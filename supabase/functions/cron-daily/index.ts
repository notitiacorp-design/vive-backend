import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.0';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
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
      return { ok: false, data, error: `HTTP ${res.status}: ${JSON.stringify(data)}` };
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

  // Recovery: remettre en pending les jobs bloquÃ©s en processing depuis trop longtemps
  const stuckThreshold = new Date(Date.now() - PROCESSING_STUCK_MINUTES * 60 * 1000).toISOString();
  const { error: recoveryError } = await supabase
    .from('jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('updated_at', stuckThreshold);

  if (recoveryError) {
    console.warn('[cron-daily] Failed to recover stuck processing jobs (non-critical):', recoveryError.message);
  } else {
    console.log(`[cron-daily] Recovery: jobs stuck in processing before ${stuckThreshold} reset to pending.`);
  }

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, type, payload, attempts')
    .eq('status', 'pending')
    .lt('attempts', MAX_JOB_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[cron-daily] Failed to fetch pending jobs:', error.message);
    return { processed: 0, failed: 0 };
  }

  if (!jobs || jobs.length === 0) {
    console.log('[cron-daily] No pending jobs found.');
    return { processed: 0, failed: 0 };
  }

  console.log(`[cron-daily] Found ${jobs.length} pending job(s).`);

  let processed = 0;
  let failed = 0;

  const processJob = async (job: { id: string; type: string; payload: Record<string, unknown> | null; attempts: number | null }) => {
    const newAttempts = (job.attempts ?? 0) + 1;
    let targetUrl: string | null = null;

    if (job.type === 'jarvis-engine') targetUrl = JARVIS_ENGINE_URL;
    else if (job.type === 'box-selector') targetUrl = BOX_SELECTOR_URL;
    else {
      console.warn(`[cron-daily] Unknown job type "${job.type}" for job ${job.id}. Skipping.`);
      await supabase
        .from('jobs')
        .update({
          status: 'failed',
          attempts: newAttempts,
          updated_at: new Date().toISOString(),
          error_message: 'Unknown job type',
        })
        .eq('id', job.id);
      failed++;
      return;
    }

    console.log(`[cron-daily] Processing job ${job.id} (type=${job.type}, attempt=${newAttempts})`);

    // Mark as processing â vÃ©rifier l'erreur pour ne pas exÃ©cuter si le lock Ã©choue
    const { error: lockError } = await supabase
      .from('jobs')
      .update({ status: 'processing', attempts: newAttempts, updated_at: new Date().toISOString() })
      .eq('id', job.id);

    if (lockError) {
      console.error(`[cron-daily] Failed to mark job ${job.id} as processing:`, lockError.message);
      failed++;
      return;
    }

    const result = await callEdgeFunction(targetUrl, { job_id: job.id, ...(job.payload ?? {}) });

    if (result.ok) {
      const { error: completeError } = await supabase
        .from('jobs')
        .update({ status: 'completed', updated_at: new Date().toISOString(), error_message: null })
        .eq('id', job.id);
      if (completeError) {
        console.error(`[cron-daily] Failed to mark job ${job.id} as completed:`, completeError.message);
      } else {
        console.log(`[cron-daily] Job ${job.id} completed successfully.`);
        processed++;
      }
    } else {
      const finalStatus = newAttempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending';
      const { error: failError } = await supabase
        .from('jobs')
        .update({
          status: finalStatus,
          updated_at: new Date().toISOString(),
          error_message: result.error ?? 'Unknown error',
        })
        .eq('id', job.id);
      if (failError) {
        console.error(`[cron-daily] Failed to update job ${job.id} status to ${finalStatus}:`, failError.message);
      }
      console.error(`[cron-daily] Job ${job.id} failed (attempt ${newAttempts}): ${result.error}`);
      if (finalStatus === 'failed') failed++;
    }
  };

  await processInBatches(jobs as Parameters<typeof processJob>[0][], CONCURRENT_BATCH_SIZE, processJob);

  return { processed, failed };
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

  // Utiliser une RPC pour Ã©viter les 3 requÃªtes chaÃ®nÃ©es et le chargement mÃ©moire excessif
  const { data: usersToAnalyzeRaw, error: rpcError } = await supabase.rpc('get_users_to_analyze', {
    p_since: yesterday,
    p_today_start: todayStartISO,
  });

  if (rpcError) {
    console.warn('[cron-daily] RPC get_users_to_analyze failed, falling back to chained queries:', rpcError.message);

    // Fallback: requÃªtes chaÃ®nÃ©es avec LIMIT
    const { data: activeUsers, error: usersError } = await supabase
      .from('profiles')
      .select('id, plan')
      .neq('plan', 'free')
      .not('plan', 'is', null)
      .limit(500);

    if (usersError) {
      console.error('[cron-daily] Failed to fetch active users:', usersError.message);
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    if (!activeUsers || activeUsers.length === 0) {
      console.log('[cron-daily] No paid users found.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    const { data: healthUsers, error: healthError } = await supabase
      .from('health_metrics')
      .select('user_id')
      .gte('recorded_at', yesterday)
      .in('user_id', activeUsers.map((u: { id: string }) => u.id))
      .limit(500);

    if (healthError) {
      console.error('[cron-daily] Failed to fetch health data users:', healthError.message);
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    const healthUserIds = [...new Set((healthUsers ?? []).map((h: { user_id: string }) => h.user_id))];

    if (healthUserIds.length === 0) {
      console.log('[cron-daily] No users with recent health data found.');
      return { analyses_run: 0, analyses_failed: 0, user_ids: [] };
    }

    const { data: alreadyAnalyzed, error: analysisError } = await supabase
      .from('jarvis_analyses')
      .select('user_id')
      .gte('created_at', todayStartISO)
      .in('user_id', healthUserIds)
      .limit(500);

    if (analysisError) {
      console.error('[cron-daily] Failed to check existing analyses:', analysisError.message);
    }

    const analyzedToday = new Set((alreadyAnalyzed ?? []).map((a: { user_id: string }) => a.user_id));
    const fallbackUsersToAnalyze = healthUserIds.filter((id) => !analyzedToday.has(id));

    return await runJarvisForUsers(fallbackUsersToAnalyze, now);
  }

  const usersToAnalyze: string[] = (usersToAnalyzeRaw ?? []).map(
    (row: { user_id: string }) => row.user_id
  );

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

  let analyses_run = 0;
  let analyses_failed = 0;
  const analyzedUserIds: string[] = [];

  const analyzeUser = async (userId: string) => {
    console.log(`[cron-daily] Calling jarvis-engine for user ${userId}`);
    const result = await callEdgeFunction(JARVIS_ENGINE_URL, {
      user_id: userId,
      trigger: 'cron_daily',
      timestamp: now.toISOString(),
    });
    if (result.ok) {
      analyses_run++;
      analyzedUserIds.push(userId);
      console.log(`[cron-daily] jarvis-engine succeeded for user ${userId}`);
    } else {
      analyses_failed++;
      console.error(`[cron-daily] jarvis-engine failed for user ${userId}: ${result.error}`);
    }
  };

  await processInBatches(usersToAnalyze, CONCURRENT_BATCH_SIZE, analyzeUser);

  return { analyses_run, analyses_failed, user_ids: analyzedUserIds };
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

  const { data: analyses, error: analysesError } = await supabase
    .from('jarvis_analyses')
    .select('user_id, summary, insights, score, created_at')
    .in('user_id', analyzedUserIds)
    .gte('created_at', todayStart.toISOString())
    .order('created_at', { ascending: false })
    .limit(500);

  if (analysesError) {
    console.error('[cron-daily] Failed to fetch analyses for briefings:', analysesError.message);
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

  const notifications = Array.from(latestByUser.entries()).map(([userId, analysis]) => ({
    user_id: userId,
    type: 'morning_briefing',
    title: 'Your Morning Health Briefing',
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

  const { data: inserted, error: insertError } = await supabase
    .from('notifications')
    .insert(notifications)
    .select('id');

  if (insertError) {
    console.error('[cron-daily] Failed to insert notifications:', insertError.message);
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

  const { data: boxesToLock, error: fetchError } = await supabase
    .from('box_orders')
    .select('id, user_id, delivery_month, mode, status')
    .eq('status', 'pending')
    .eq('mode', 'validation')
    .gte('delivery_month', currentMonthStart)
    .lte('delivery_month', currentMonthEnd);

  if (fetchError) {
    console.error('[cron-daily] Failed to fetch box orders for locking:', fetchError.message);
    return { boxes_locked: 0 };
  }

  if (!boxesToLock || boxesToLock.length === 0) {
    console.log('[cron-daily] No validation boxes found to lock.');
    return { boxes_locked: 0 };
  }

  console.log(`[cron-daily] Found ${boxesToLock.length} box(es) to lock.`);

  const lockedAt = now.toISOString();
  const boxIds = boxesToLock.map((b: { id: string }) => b.id);

  const { data: updatedBoxes, error: updateError } = await supabase
    .from('box_orders')
    .update({
      mode: 'locked',
      locked_at: lockedAt,
      updated_at: lockedAt,
    })
    .in('id', boxIds)
    .select('id');

  if (updateError) {
    console.error('[cron-daily] Failed to lock boxes:', updateError.message);
    return { boxes_locked: 0 };
  }

  const lockedCount = updatedBoxes?.length ?? 0;
  console.log(`[cron-daily] Successfully locked ${lockedCount} box(es).`);

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
      console.warn('[cron-daily] Failed to insert box lock events (non-critical):', eventError.message);
    }
  }

  return { boxes_locked: lockedCount };
}

// --- Main Handler ---
serve(async (req: Request) => {
  const startTime = Date.now();
  console.log(`[cron-daily] Invoked at ${new Date().toISOString()}`);

  // Auth validation: seul CRON_SECRET est acceptÃ© comme secret d'entrÃ©e HTTP
  const cronSecretHeader = req.headers.get('x-cron-secret') ?? '';
  const isValidCronSecret = CRON_SECRET !== '' && cronSecretHeader === CRON_SECRET;

  if (!isValidCronSecret) {
    console.warn('[cron-daily] Unauthorized request.');
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Build service-role client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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
    console.error('[cron-daily] Step 1 threw:', msg);
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
    console.error('[cron-daily] Step 2 threw:', msg);
    summary.errors.push(`step2_jarvis: ${msg}`);
  }

  // Step 3
  try {
    const { notifications_created } = await generateMorningBriefings(supabase, analyzedUserIds);
    summary.notifications_created = notifications_created;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 3 threw:', msg);
    summary.errors.push(`step3_briefings: ${msg}`);
  }

  // Step 4
  try {
    const { boxes_locked } = await checkBoxLocks(supabase);
    summary.boxes_locked = boxes_locked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-daily] Step 4 threw:', msg);
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
    console.warn('[cron-daily] Failed to write run log (non-critical):', logErr);
  }

  console.log('[cron-daily] Completed. Summary:', JSON.stringify(summary));

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
