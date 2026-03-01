import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.0';
import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const CRON_SECRET = Deno.env.get('CRON_SECRET');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET) {
  throw new Error(
    '[cron-daily] Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET'
  );
}

const JARVIS_ENGINE_URL = `${SUPABASE_URL}/functions/v1/jarvis-engine`;
const BOX_SELECTOR_URL = `${SUPABASE_URL}/functions/v1/box-selector`;

const MAX_JOB_ATTEMPTS = 3;
const BATCH_DELAY_MS = 500;
const FUNCTION_TIMEOUT_MS = 25000;
const PROCESSING_STUCK_MINUTES = 30;
const CONCURRENT_BATCH_SIZE = 5;
const MAX_USERS_TO_ANALYZE = 1000;
const BOX_LOCK_PAGE_SIZE = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Timing-safe comparison for secrets to prevent timing attacks.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    const encoder = new TextEncoder();
    const aBytes = encoder.encode(a);
    const bBytes = encoder.encode(b);
    if (aBytes.length !== bBytes.length) {
      // Still do a comparison to avoid length-based timing leak
      const dummy = new Uint8Array(aBytes.length);
      timingSafeEqual(aBytes, dummy);
      return false;
    }
    return timingSafeEqual(aBytes, bBytes);
  } catch {
    return false;
  }
}

async function callEdgeFunction(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = FUNCTION_TIMEOUT_MS
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeader(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, data, error: `HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, data: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function processInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await Promise.allSettled(chunk.map(fn));
    if (i + batchSize < items.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }
}

// --- Step 1: Process pending jobs ---
async function processPendingJobs(
  supabase: ReturnType<typeof createClient>
): Promise<{ processed: number; failed: number }> {
  console.log('[cron-daily] Step 1: Processing pending jobs...');

  // Recovery: reset stuck jobs to pending â done as a scoped update, not a global reset.
  // We select candidate stuck job IDs first and then update only those IDs to avoid
  // concurrent runners resetting and re-picking the same jobs.
  const stuckThreshold = new Date(Date.now() - PROCESSING_STUCK_MINUTES * 60 * 1000).toISOString();

  // Fetch stuck job IDs with a limit to avoid unbounded updates
  const { data: stuckJobs, error: stuckFetchError } = await supabase
    .from('jobs')
    .select('id')
    .eq('status', 'processing')
    .lt('updated_at', stuckThreshold)
    .limit(50);

  if (stuckFetchError) {
    console.warn('[cron-daily] Failed to fetch stuck jobs (non-critical).');
  } else if (stuckJobs && stuckJobs.length > 0) {
    const stuckIds = stuckJobs.map((j: { id: string }) => j.id);
    const { error: recoveryError } = await supabase
      .from('jobs')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .in('id', stuckIds)
      // Only reset if still processing (guard against concurrent reset)
      .eq('status', 'processing');

    if (recoveryError) {
      console.warn('[cron-daily] Failed to recover stuck processing jobs (non-critical).');
    } else {
      console.log(`[cron-daily] Recovery: reset ${stuckIds.length} stuck job(s) to pending.`);
    }
  }

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, type, payload, attempts')
    .eq('status', 'pending')
    .lt('attempts', MAX_JOB_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[cron-daily] Failed to fetch pending jobs.');
    return { processed: 0, failed: 0 };
  }

  if (!jobs || jobs.length === 0) {
    console.log('[cron-daily] No pending jobs found.');
    return { processed: 0, failed: 0 };
  }

  console.log(`[cron-daily] Found ${jobs.length} pending job(s).`);

  // Use local counters per batch; aggregated after Promise.allSettled
  const results = { processed: 0, failed: 0 };

  const processJob = async (job: { id: string; type: string; payload: Record<string, unknown> | null; attempts: number | null }): Promise<void> => {
    const newAttempts = (job.attempts ?? 0) + 1;
    let targetUrl: string | null = null;

    if (job.type === 'jarvis-engine') targetUrl = JARVIS_ENGINE_URL;
    else if (job.type === 'box-selector') targetUrl = BOX_SELECTOR_URL;
    else {
      console.warn(`[cron-daily] Unknown job type for job ${job.id.substring(0, 8)}. Skipping.`);
      await supabase
        .from('jobs')
        .update({
          status: 'failed',
          attempts: newAttempts,
          updated_at: new Date().toISOString(),
          error_message: 'Unknown job type',
        })
        .eq('id', job.id);
      results.failed++;
      return;
    }

    console.log(`[cron-daily] Processing job ${job.id.substring(0, 8)} (type=${job.type}, attempt=${newAttempts})`);

    // Optimistic lock: only mark as processing if still pending.
    // This prevents double-processing by concurrent cron invocations.
    const { count: lockCount, error: lockError } = await supabase
      .from('jobs')
      .update({ status: 'processing', attempts: newAttempts, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending') // Optimistic lock: only succeed if still pending
      .select('id', { count: 'exact', head: true });

    if (lockError) {
      console.error(`[cron-daily] Failed to lock job ${job.id.substring(0, 8)}.`);
      results.failed++;
      return;
    }

    // If count is 0, another runner already picked up this job
    if ((lockCount ?? 0) === 0) {
      console.log(`[cron-daily] Job ${job.id.substring(0, 8)} already claimed by another runner. Skipping.`);
      return;
    }

    const result = await callEdgeFunction(targetUrl, { job_id: job.id, ...(job.payload ?? {}) });

    if (result.ok) {
      const { error: completeError } = await supabase
        .from('jobs')
        .update({ status: 'completed', updated_at: new Date().toISOString(), error_message: null })
        .eq('id', job.id);
      if (completeError) {
        console.error(`[cron-daily] Failed to mark job ${job.id.substring(0, 8)} as completed.`);
      } else {
        console.log(`[cron-daily] Job ${job.id.substring(0, 8)} completed successfully.`);
        results.processed++;
      }
    } else {
      const finalStatus = newAttempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending';
      const { error: failError } = await supabase
        .from('jobs')
        .update({
          status: finalStatus,
          updated_at: new Date().toISOString(),
          error_message: 'Job execution failed',
        })
        .eq('id', job.id);
      if (failError) {
        console.error(`[cron-daily] Failed to update job ${job.id.substring(0, 8)} status to ${finalStatus}.`);
      }
      console.error(`[cron-daily] Job ${job.id.substring(0, 8)} failed (attempt ${newAttempts}).`);
      if (finalStatus === 'failed') results.failed++;
    }
  };

  await processInBatches(jobs as Parameters<typeof processJob>[0][], CONCURRENT_BATCH_SIZE, processJob);

  return { processed: results.processed, failed: results.failed };
}

// --- Step 2: Launch jarvis-engine for active users ---
async function launchJarvisForActiveUsers(
  supabase: ReturnType<typeof createClient>
): Promise<{ analyses_run: number; analyses_failed: number; user_ids: string[] }> {
  console.log('[cron-daily] Step 2: Launching jarvis-engine for active users...');

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();

  // Use an RPC to avoid N+1 chained queries and excessive memory load
  const { data: usersToAnalyzeRaw, error: rpcError } = await supabase.rpc('get_users_to_analyze', {
    p_since: yesterday,
    p_today_start: todayStartISO,
  });

  if (rpcError) {
    console.warn('[cron-daily] RPC get_users_to_analyze failed, falling back to chained queries.');

    // Fallback: chained queries.
    // Use the same limit across all sub-queries for consistency.
    const FALLBACK_LIMIT = 500;

    const { data: activeUsers, error: usersError } = await supabase
      .from('profiles')
      .select('id')
      .neq('plan', 'free')
      .not('plan', 'is', null)
      .limit(FALLBACK_LIMIT);

    if (usersError) {
      console.error('[cron-daily] Failed to fetch active users.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    if (!activeUsers || activeUsers.length === 0) {
      console.log('[cron-daily] No paid users found.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    const activeUserIds = activeUsers.map((u: { id: string }) => u.id);

    // Fetch health users scoped to the same FALLBACK_LIMIT set of users
    const { data: healthUsers, error: healthError } = await supabase
      .from('health_metrics')
      .select('user_id')
      .gte('recorded_at', yesterday)
      .in('user_id', activeUserIds)
      .limit(FALLBACK_LIMIT);

    if (healthError) {
      console.error('[cron-daily] Failed to fetch health data users.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    const healthUserIds = [...new Set((healthUsers ?? []).map((h: { user_id: string }) => h.user_id))];

    if (healthUserIds.length === 0) {
      console.log('[cron-daily] No users with recent health data found.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    // Fetch already-analyzed users scoped to the same healthUserIds (consistent scope)
    const { data: alreadyAnalyzed, error: analysisError } = await supabase
      .from('jarvis_analyses')
      .select('user_id')
      .gte('created_at', todayStartISO)
      .in('user_id', healthUserIds)
      .limit(FALLBACK_LIMIT);

    if (analysisError) {
      console.error('[cron-daily] Failed to check existing analyses.');
    }

    const analyzedToday = new Set((alreadyAnalyzed ?? []).map((a: { user_id: string }) => a.user_id));
    const fallbackUsersToAnalyze = healthUserIds
      .filter((id) => !analyzedToday.has(id))
      .slice(0, MAX_USERS_TO_ANALYZE);

    return await runJarvisForUsers(fallbackUsersToAnalyze, now);
  }

  // Cap the number of users to analyze to avoid unbounded processing
  const usersToAnalyze: string[] = ((usersToAnalyzeRaw ?? []) as { user_id: string }[])
    .map((row) => row.user_id)
    .slice(0, MAX_USERS_TO_ANALYZE);

  console.log(`[cron-daily] Users to analyze (via RPC): ${usersToAnalyze.length}`);

  return await runJarvisForUsers(usersToAnalyze, now);
}

async function runJarvisForUsers(
  usersToAnalyze: string[],
  now: Date
): Promise<{ analyses_run: number; analyses_failed: number; user_ids: string[] }> {
  if (usersToAnalyze.length === 0) {
    console.log('[cron-daily] No users to analyze.');
    return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
  }

  console.log(`[cron-daily] Launching jarvis-engine for ${usersToAnalyze.length} user(s).`);

  const results = { analyses_run: 0, analyses_failed: 0 };
  const analyzedUserIds: string[] = [];

  const analyzeUser = async (userId: string): Promise<void> => {
    const shortId = userId.substring(0, 8);
    console.log(`[cron-daily] Calling jarvis-engine for user ${shortId}...`);
    const result = await callEdgeFunction(JARVIS_ENGINE_URL, {
      user_id: userId,
      trigger: 'cron_daily',
      timestamp: now.toISOString(),
    });
    if (result.ok) {
      results.analyses_run++;
      analyzedUserIds.push(userId);
      console.log(`[cron-daily] jarvis-engine succeeded for user ${shortId}`);
    } else {
      results.analyses_failed++;
      console.error(`[cron-daily] jarvis-engine failed for user ${shortId}.`);
    }
  };

  await processInBatches(usersToAnalyze, CONCURRENT_BATCH_SIZE, analyzeUser);

  return { analyses_run: results.analyses_run, analyses_failed: results.analyses_failed, user_ids: analyzedUserIds };
}

// --- Step 3: Generate morning briefing notifications ---
async function generateMorningBriefings(
  supabase: ReturnType<typeof createClient>,
  analyzedUserIds: string[]
): Promise<{ notifications_created: number }> {
  console.log(`[cron-daily] Step 3: Generating morning briefings for ${analyzedUserIds.length} user(s)...`);

  if (analyzedUserIds.length === 0) {
    return { notifications_created: 0 };
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();

  const { data: analyses, error: analysesError } = await supabase
    .from('jarvis_analyses')
    .select('user_id, summary, insights, score, created_at')
    .in('user_id', analyzedUserIds)
    .gte('created_at', todayStartISO)
    .order('created_at', { ascending: false })
    .limit(500);

  if (analysesError) {
    console.error('[cron-daily] Failed to fetch analyses for briefings.');
    return { notifications_created: 0 };
  }

  if (!analyses || analyses.length === 0) {
    console.log('[cron-daily] No fresh analyses found for briefings.');
    return { notifications_created: 0 };
  }

  // Deduplicate: latest analysis per user
  const latestByUser = new Map<string, typeof analyses[number]>();
  for (const analysis of analyses) {
    if (!latestByUser.has(analysis.user_id)) {
      latestByUser.set(analysis.user_id, analysis);
    }
  }

  // Idempotency check: fetch users that already have a morning_briefing notification today
  const candidateUserIds = Array.from(latestByUser.keys());
  const { data: existingNotifs, error: existingError } = await supabase
    .from('notifications')
    .select('user_id')
    .eq('type', 'morning_briefing')
    .gte('created_at', todayStartISO)
    .in('user_id', candidateUserIds);

  if (existingError) {
    console.error('[cron-daily] Failed to check existing notifications for idempotency.');
    // Non-fatal: proceed without idempotency guard rather than skipping entirely
  }

  const alreadyNotifiedToday = new Set(
    (existingNotifs ?? []).map((n: { user_id: string }) => n.user_id)
  );

  const notifications = Array.from(latestByUser.entries())
    .filter(([userId]) => !alreadyNotifiedToday.has(userId))
    .map(([userId, analysis]) => ({
      user_id: userId,
      type: 'morning_briefing',
      title: 'ð Your Morning Health Briefing',
      body: analysis.summary ?? 'Your daily VIVE health analysis is ready. Tap to view your insights.',
      payload: JSON.stringify({
        analysis_score: analysis.score,
        insights_count: Array.isArray(analysis.insights) ? analysis.insights.length : 0,
        analysis_date: analysis.created_at,
      }),
      status: 'pending',
      scheduled_for: now.toISOString(),
      created_at: now.toISOString(),
    }));

  if (notifications.length === 0) {
    console.log('[cron-daily] All users already notified today. No new notifications needed.');
    return { notifications_created: 0 };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('notifications')
    .insert(notifications)
    .select('id');

  if (insertError) {
    console.error('[cron-daily] Failed to insert notifications.');
    return { notifications_created: 0 };
  }

  const count = inserted?.length ?? notifications.length;
  console.log(`[cron-daily] Created ${count} morning briefing notification(s).`);
  return { notifications_created: count };
}

// --- Step 4: Check box locks (J-2) ---
async function checkBoxLocks(
  supabase: ReturnType<typeof createClient>
): Promise<{ boxes_locked: number }> {
  console.log('[cron-daily] Step 4: Checking box locks (J-2)...');

  const now = new Date();

  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const daysUntilMonthEnd = Math.floor(
    (lastDayOfMonth.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  console.log(
    `[cron-daily] Today: ${now.toISOString()}, ` +
    `Last day of month: ${lastDayOfMonth.toISOString()}, ` +
    `Days until month end: ${daysUntilMonthEnd}`
  );

  if (daysUntilMonthEnd > 2) {
    console.log(`[cron-daily] Not yet J-2. No boxes to lock today.`);
    return { boxes_locked: 0 };
  }

  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const currentMonthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)
  ).toISOString();

  const lockedAt = now.toISOString();
  let totalLocked = 0;
  let offset = 0;

  // Paginate box_orders to avoid unbounded memory usage
  while (true) {
    const { data: boxesToLock, error: fetchError } = await supabase
      .from('box_orders')
      .select('id, user_id, delivery_month, mode, status')
      .eq('status', 'pending')
      .eq('mode', 'validation')
      .gte('delivery_month', currentMonthStart)
      .lte('delivery_month', currentMonthEnd)
      .order('id', { ascending: true })
      .range(offset, offset + BOX_LOCK_PAGE_SIZE - 1);

    if (fetchError) {
      console.error('[cron-daily] Failed to fetch box orders for locking.');
      break;
    }

    if (!boxesToLock || boxesToLock.length === 0) {
      break;
    }

    console.log(`[cron-daily] Found ${boxesToLock.length} box(es) to lock (offset=${offset}).`);

    const boxIds = boxesToLock.map((b: { id: string }) => b.id);

    const { data: updatedBoxes, error: updateError } = await supabase
      .from('box_orders')
      .update({
        mode: 'locked',
        locked_at: lockedAt,
        updated_at: lockedAt,
      })
      .in('id', boxIds)
      .eq('status', 'pending')
      .eq('mode', 'validation')
      .select('id');

    if (updateError) {
      console.error('[cron-daily] Failed to lock boxes.');
      break;
    }

    const batchLocked = updatedBoxes?.length ?? 0;
    totalLocked += batchLocked;

    const lockEvents = (updatedBoxes ?? []).map((b: { id: string }) => ({
      box_order_id: b.id,
      event_type: 'box_locked',
      triggered_by: 'cron_daily',
      metadata: JSON.stringify({ days_until_month_end: daysUntilMonthEnd }),
      created_at: lockedAt,
    }));

    if (lockEvents.length > 0) {
      const { error: eventError } = await supabase.from('box_events').insert(lockEvents);
      if (eventError) {
        console.warn('[cron-daily] Failed to insert box lock events (non-critical).');
      }
    }

    if (boxesToLock.length < BOX_LOCK_PAGE_SIZE) {
      // Last page
      break;
    }

    offset += BOX_LOCK_PAGE_SIZE;
    await sleep(BATCH_DELAY_MS);
  }

  console.log(`[cron-daily] Successfully locked ${totalLocked} box(es).`);
  return { boxes_locked: totalLocked };
}

// --- Main Handler ---
serve(async (req: Request) => {
  const startTime = Date.now();
  console.log(`[cron-daily] Invoked at ${new Date().toISOString()}`);

  // Auth validation: timing-safe comparison to prevent timing attacks
  const cronSecretHeader = req.headers.get('x-cron-secret') ?? '';
  const isValidCronSecret = CRON_SECRET !== '' && timingSafeStringEqual(cronSecretHeader, CRON_SECRET!);

  if (!isValidCronSecret) {
    console.warn('[cron-daily] Unauthorized request.');
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  // Build service-role client
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const summary = {
    jobs_processed: 0,
    jobs_failed: 0,
    analyses_run: 0,
    analyses_failed: 0,
    notifications_created: 0,
    boxes_locked: 0,
    duration_ms: 0,
    errors: [] as string[],
  };

  // Step 1
  try {
    const { processed, failed } = await processPendingJobs(supabase);
    summary.jobs_processed = processed;
    summary.jobs_failed = failed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 1 threw an unexpected error.');
    summary.errors.push(`step1_jobs: ${msg}`);
  }

  // Step 2
  let analyzedUserIds: string[] = [];
  try {
    const { analyses_run, analyses_failed, user_ids } = await launchJarvisForActiveUsers(supabase);
    summary.analyses_run = analyses_run;
    summary.analyses_failed = analyses_failed;
    analyzedUserIds = user_ids;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 2 threw an unexpected error.');
    summary.errors.push(`step2_jarvis: ${msg}`);
  }

  // Step 3
  try {
    const { notifications_created } = await generateMorningBriefings(supabase, analyzedUserIds);
    summary.notifications_created = notifications_created;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 3 threw an unexpected error.');
    summary.errors.push(`step3_briefings: ${msg}`);
  }

  // Step 4
  try {
    const { boxes_locked } = await checkBoxLocks(supabase);
    summary.boxes_locked = boxes_locked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 4 threw an unexpected error.');
    summary.errors.push(`step4_box_locks: ${msg}`);
  }

  summary.duration_ms = Date.now() - startTime;

  // Persist run log
  try {
    await supabase.from('cron_run_logs').insert({
      cron_name: 'cron-daily',
      ran_at: new Date().toISOString(),
      summary: JSON.stringify(summary),
      success: summary.errors.length === 0,
    });
  } catch (logErr) {
    console.warn('[cron-daily] Failed to write run log (non-critical).');
  }

  console.log('[cron-daily] Completed. Summary:', JSON.stringify(summary));

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
});
