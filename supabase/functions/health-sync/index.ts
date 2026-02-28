import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CONTINUOUS_METRICS = new Set(['heart_rate', 'hrv', 'stress']);
const CUMULATIVE_METRICS = new Set(['steps', 'calories', 'active_minutes']);

const REQUIRED_SAMPLE_FIELDS = ['source', 'metric_type', 'start_ts', 'end_ts', 'value', 'unit'] as const;

interface HealthSample {
  source: string;
  metric_type: string;
  start_ts: string;
  end_ts: string;
  value: number;
  unit: string;
  metadata?: Record<string, unknown>;
}

interface ValidationError {
  index: number;
  field: string;
  message: string;
}

function validateSamples(samples: unknown[]): { valid: HealthSample[]; errors: ValidationError[] } {
  const valid: HealthSample[] = [];
  const errors: ValidationError[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];

    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
      errors.push({ index: i, field: 'sample', message: 'Each sample must be a non-null object' });
      continue;
    }

    const s = sample as Record<string, unknown>;
    let hasError = false;

    for (const field of REQUIRED_SAMPLE_FIELDS) {
      if (s[field] === undefined || s[field] === null || s[field] === '') {
        errors.push({ index: i, field, message: `Field '${field}' is required and cannot be empty` });
        hasError = true;
      }
    }

    if (!hasError) {
      if (typeof s.value !== 'number' || isNaN(s.value)) {
        errors.push({ index: i, field: 'value', message: 'Field \'value\' must be a valid number' });
        hasError = true;
      }
    }

    if (!hasError) {
      const startTs = new Date(s.start_ts as string);
      const endTs = new Date(s.end_ts as string);

      if (isNaN(startTs.getTime())) {
        errors.push({ index: i, field: 'start_ts', message: 'Field \'start_ts\' must be a valid ISO 8601 timestamp' });
        hasError = true;
      }

      if (isNaN(endTs.getTime())) {
        errors.push({ index: i, field: 'end_ts', message: 'Field \'end_ts\' must be a valid ISO 8601 timestamp' });
        hasError = true;
      }

      if (!isNaN(startTs.getTime()) && !isNaN(endTs.getTime()) && endTs < startTs) {
        errors.push({ index: i, field: 'end_ts', message: 'Field \'end_ts\' must be >= \'start_ts\'' });
        hasError = true;
      }
    }

    if (!hasError) {
      valid.push({
        source: String(s.source),
        metric_type: String(s.metric_type),
        start_ts: String(s.start_ts),
        end_ts: String(s.end_ts),
        value: s.value as number,
        unit: String(s.unit),
        metadata: s.metadata as Record<string, unknown> | undefined,
      });
    }
  }

  return { valid, errors };
}

function toDateString(ts: string): string {
  return new Date(ts).toISOString().split('T')[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // --- Auth ---
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return new Response(
        JSON.stringify({ error: 'Server configuration error.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use user JWT client to verify auth
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: invalid or expired token.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.id;

    // Service-role client for DB operations
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // --- Parse Body ---
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (typeof body !== 'object' || body === null || !('samples' in body)) {
      return new Response(
        JSON.stringify({ error: 'Request body must be a JSON object with a \'samples\' array.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { samples: rawSamples } = body as { samples: unknown };

    if (!Array.isArray(rawSamples)) {
      return new Response(
        JSON.stringify({ error: '\'samples\' must be an array.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (rawSamples.length === 0) {
      return new Response(
        JSON.stringify({ synced: 0, aggregates_updated: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (rawSamples.length > 5000) {
      return new Response(
        JSON.stringify({ error: 'Too many samples. Maximum 5000 per request.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // --- Validate ---
    const { valid: validSamples, errors: validationErrors } = validateSamples(rawSamples);

    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'Validation failed for one or more samples.',
          validation_errors: validationErrors,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // --- UPSERT health_samples ---
    const rows = validSamples.map((s) => ({
      user_id: userId,
      source: s.source,
      metric_type: s.metric_type,
      start_ts: s.start_ts,
      end_ts: s.end_ts,
      value: s.value,
      unit: s.unit,
      metadata: s.metadata ?? null,
    }));

    const { data: upsertedData, error: upsertError } = await adminClient
      .from('health_samples')
      .upsert(rows, {
        onConflict: 'user_id,source,metric_type,start_ts',
        ignoreDuplicates: false,
      })
      .select('id, metric_type, start_ts, created_at, updated_at');

    if (upsertError) {
      console.error('Upsert error:', upsertError);
      return new Response(
        JSON.stringify({ error: 'Failed to sync health samples.', detail: upsertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const syncedCount = upsertedData?.length ?? 0;

    // Determine newly inserted rows (created_at == updated_at within a small window)
    const newlyInserted = (upsertedData ?? []).filter((row) => {
      if (!row.created_at || !row.updated_at) return true;
      const created = new Date(row.created_at).getTime();
      const updated = new Date(row.updated_at).getTime();
      return Math.abs(updated - created) < 2000; // within 2s => new insert
    });

    // --- Determine affected (date, metric_type) pairs ---
    const affectedPairs = new Map<string, { date: string; metric_type: string }>();

    for (const s of validSamples) {
      const date = toDateString(s.start_ts);
      const key = `${date}::${s.metric_type}`;
      if (!affectedPairs.has(key)) {
        affectedPairs.set(key, { date, metric_type: s.metric_type });
      }
    }

    // --- Recalculate health_daily_aggregates ---
    let aggregatesUpdated = 0;

    for (const { date, metric_type } of affectedPairs.values()) {
      const isContinuous = CONTINUOUS_METRICS.has(metric_type);
      const isCumulative = CUMULATIVE_METRICS.has(metric_type);

      // Fetch all samples for this user/date/metric_type
      const startOfDay = `${date}T00:00:00.000Z`;
      const endOfDay = `${date}T23:59:59.999Z`;

      const { data: daySamples, error: fetchError } = await adminClient
        .from('health_samples')
        .select('value, unit')
        .eq('user_id', userId)
        .eq('metric_type', metric_type)
        .gte('start_ts', startOfDay)
        .lte('start_ts', endOfDay);

      if (fetchError) {
        console.error(`Failed to fetch samples for aggregation (${date}, ${metric_type}):`, fetchError);
        continue;
      }

      if (!daySamples || daySamples.length === 0) continue;

      const values = daySamples.map((s) => s.value);
      const unit = daySamples[0].unit;
      let aggregatedValue: number;
      let aggregationMethod: string;

      if (isContinuous) {
        aggregatedValue = values.reduce((sum, v) => sum + v, 0) / values.length;
        aggregationMethod = 'avg';
      } else if (isCumulative) {
        aggregatedValue = values.reduce((sum, v) => sum + v, 0);
        aggregationMethod = 'sum';
      } else {
        // Default: average for unknown metric types
        aggregatedValue = values.reduce((sum, v) => sum + v, 0) / values.length;
        aggregationMethod = 'avg';
      }

      const aggregateRow = {
        user_id: userId,
        date,
        metric_type,
        aggregated_value: aggregatedValue,
        unit,
        aggregation_method: aggregationMethod,
        sample_count: daySamples.length,
        updated_at: new Date().toISOString(),
      };

      const { error: aggError } = await adminClient
        .from('health_daily_aggregates')
        .upsert(aggregateRow, {
          onConflict: 'user_id,date,metric_type',
          ignoreDuplicates: false,
        });

      if (aggError) {
        console.error(`Failed to upsert aggregate (${date}, ${metric_type}):`, aggError);
        continue;
      }

      aggregatesUpdated++;
    }

    // --- Create job for jarvis-engine if new data was inserted ---
    if (newlyInserted.length > 0) {
      const affectedMetricTypes = [...new Set(validSamples.map((s) => s.metric_type))];
      const affectedDates = [...new Set(validSamples.map((s) => toDateString(s.start_ts)))];

      const jobRow = {
        user_id: userId,
        job_type: 'health_analysis',
        status: 'pending',
        payload: {
          trigger: 'health_sync',
          new_samples_count: newlyInserted.length,
          metric_types: affectedMetricTypes,
          dates: affectedDates,
          synced_at: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      };

      const { error: jobError } = await adminClient
        .from('jobs')
        .insert(jobRow);

      if (jobError) {
        // Non-fatal: log but don't fail the request
        console.error('Failed to create jarvis-engine job:', jobError);
      }
    }

    return new Response(
      JSON.stringify({
        synced: syncedCount,
        aggregates_updated: aggregatesUpdated,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Unexpected error in health-sync:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
