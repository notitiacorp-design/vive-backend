import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Module-level: env vars validated once at cold start, clients reused across
// warm invocations.
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
  throw new Error('Missing required Supabase environment variables (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)');
}

// Admin client reused across invocations (no user session).
const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// CORS â origin whitelist loaded from env (comma-separated list).
// Falls back to an empty list (deny all) if not set.
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS: Set<string> = new Set(
  (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

function getCorsHeaders(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    base['Access-Control-Allow-Origin'] = origin;
    base['Vary'] = 'Origin';
  }
  // If origin is not in the whitelist we still return the headers object but
  // without Access-Control-Allow-Origin, so the browser will block the request.
  return base;
}

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

const CONTINUOUS_METRICS = new Set(['heart_rate', 'hrv', 'stress']);
const CUMULATIVE_METRICS = new Set(['steps', 'calories', 'active_minutes']);

const ALL_METRIC_TYPES = new Set([...CONTINUOUS_METRICS, ...CUMULATIVE_METRICS]);

// Extend as needed; values are lower-cased source identifiers.
const ALLOWED_SOURCES = new Set([
  'apple_health',
  'google_fit',
  'garmin',
  'fitbit',
  'withings',
  'polar',
  'oura',
  'manual',
]);

// Canonical unit strings accepted per metric_type.
const ALLOWED_UNITS: Record<string, Set<string>> = {
  heart_rate:     new Set(['bpm']),
  hrv:            new Set(['ms']),
  stress:         new Set(['score']),
  steps:          new Set(['count', 'steps']),
  calories:       new Set(['kcal', 'cal']),
  active_minutes: new Set(['min', 'minutes']),
};

// Reasonable physiological / sensor value ranges per metric_type.
const VALUE_RANGES: Record<string, [number, number]> = {
  heart_rate:     [20, 300],
  hrv:            [0, 3000],
  stress:         [0, 100],
  steps:          [0, 100_000],
  calories:       [0, 30_000],
  active_minutes: [0, 1440],
};

// Field length limits (characters).
const MAX_SOURCE_LEN    = 64;
const MAX_METRIC_LEN    = 64;
const MAX_UNIT_LEN      = 32;
const MAX_METADATA_JSON = 10_240; // 10 KB

// Max allowed request body size (bytes).
const MAX_BODY_BYTES = 5_000_000; // 5 MB

// Max samples per request.
const MAX_SAMPLES = 5_000;

// Max number of affected (date, metric_type) pairs processed in one call.
const MAX_AFFECTED_PAIRS = 200;

// Allowed top-level metadata keys (extendable).
const ALLOWED_METADATA_KEYS = new Set([
  'device_model',
  'device_os',
  'app_version',
  'accuracy',
  'confidence',
  'raw_value',
  'note',
  'session_id',
  'firmware_version',
]);

// Timestamp bounds: reject timestamps older than 2 years or more than 24h in the future.
const TS_MAX_AGE_MS      = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years
const TS_MAX_FUTURE_MS   = 24 * 60 * 60 * 1000;            // 24 hours

// Global timeout (ms) for the N+1 fallback aggregation loop.
const FALLBACK_AGG_TIMEOUT_MS = 30_000; // 30 seconds

// Concurrency limit for batched DB queries in the N+1 fallback loop.
const FALLBACK_AGG_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const REQUIRED_SAMPLE_FIELDS = [
  'source',
  'metric_type',
  'start_ts',
  'end_ts',
  'value',
  'unit',
] as const;

interface HealthSample {
  source: string;
  metric_type: string;
  start_ts: string;
  end_ts: string;
  value: number;
  unit: string;
  metadata?: Record<string, string | number | boolean> | null;
}

interface ValidationError {
  index: number;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Metadata sanitiser
// ---------------------------------------------------------------------------

/**
 * Sanitises metadata:
 * - Rejects if serialised size > MAX_METADATA_JSON.
 * - Keeps only whitelisted top-level keys.
 * - Accepts only primitive leaf values (string | number | boolean).
 * Returns null if metadata is empty/undefined/null.
 */
function sanitiseMetadata(
  raw: unknown,
): { ok: true; value: Record<string, string | number | boolean> | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: "'metadata' must be a plain object" };
  }

  const serialised = JSON.stringify(raw);
  if (serialised.length > MAX_METADATA_JSON) {
    return { ok: false, message: `'metadata' exceeds max size of ${MAX_METADATA_JSON} bytes` };
  }

  const obj = raw as Record<string, unknown>;
  const clean: Record<string, string | number | boolean> = {};

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue; // silently drop unknown keys
    const v = obj[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (typeof v === 'string' && v.length > 512) {
        return { ok: false, message: `'metadata.${key}' string value exceeds 512 characters` };
      }
      clean[key] = v;
    }
    // silently drop non-primitive values
  }

  return { ok: true, value: Object.keys(clean).length > 0 ? clean : null };
}

// ---------------------------------------------------------------------------
// Sample validator
// ---------------------------------------------------------------------------

function validateSamples(
  samples: unknown[],
): { valid: HealthSample[]; errors: ValidationError[] } {
  const valid: HealthSample[] = [];
  const errors: ValidationError[] = [];

  const now = Date.now();
  const minTsMs = now - TS_MAX_AGE_MS;
  const maxTsMs = now + TS_MAX_FUTURE_MS;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];

    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
      errors.push({ index: i, field: 'sample', message: 'Each sample must be a non-null object' });
      continue;
    }

    const s = sample as Record<string, unknown>;
    let hasError = false;

    // Required field presence.
    for (const field of REQUIRED_SAMPLE_FIELDS) {
      if (s[field] === undefined || s[field] === null || s[field] === '') {
        errors.push({ index: i, field, message: `Field '${field}' is required and cannot be empty` });
        hasError = true;
      }
    }
    if (hasError) continue;

    // value type.
    if (typeof s.value !== 'number' || isNaN(s.value)) {
      errors.push({ index: i, field: 'value', message: "Field 'value' must be a valid number" });
      hasError = true;
    }
    if (hasError) continue;

    // source whitelist + length.
    const source = String(s.source);
    if (source.length > MAX_SOURCE_LEN) {
      errors.push({ index: i, field: 'source', message: `Field 'source' exceeds max length of ${MAX_SOURCE_LEN}` });
      hasError = true;
    } else if (!ALLOWED_SOURCES.has(source)) {
      errors.push({
        index: i,
        field: 'source',
        message: `Field 'source' value '${source}' is not in the allowed list: ${[...ALLOWED_SOURCES].join(', ')}`,
      });
      hasError = true;
    }
    if (hasError) continue;

    // metric_type whitelist + length.
    const metricType = String(s.metric_type);
    if (metricType.length > MAX_METRIC_LEN) {
      errors.push({ index: i, field: 'metric_type', message: `Field 'metric_type' exceeds max length of ${MAX_METRIC_LEN}` });
      hasError = true;
    } else if (!ALL_METRIC_TYPES.has(metricType)) {
      errors.push({
        index: i,
        field: 'metric_type',
        message: `Field 'metric_type' value '${metricType}' is not supported. Supported: ${[...ALL_METRIC_TYPES].join(', ')}`,
      });
      hasError = true;
    }
    if (hasError) continue;

    // unit whitelist + length.
    const unit = String(s.unit);
    if (unit.length > MAX_UNIT_LEN) {
      errors.push({ index: i, field: 'unit', message: `Field 'unit' exceeds max length of ${MAX_UNIT_LEN}` });
      hasError = true;
    } else {
      const allowedUnits = ALLOWED_UNITS[metricType];
      if (allowedUnits && !allowedUnits.has(unit)) {
        errors.push({
          index: i,
          field: 'unit',
          message: `Field 'unit' value '${unit}' is not valid for metric_type '${metricType}'. Allowed: ${[...allowedUnits].join(', ')}`,
        });
        hasError = true;
      }
    }
    if (hasError) continue;

    // value range.
    const range = VALUE_RANGES[metricType];
    if (range) {
      const [min, max] = range;
      const numVal = s.value as number;
      if (numVal < min || numVal > max) {
        errors.push({
          index: i,
          field: 'value',
          message: `Field 'value' ${numVal} is out of range [${min}, ${max}] for metric_type '${metricType}'`,
        });
        hasError = true;
      }
    }
    if (hasError) continue;

    // Timestamps.
    const startTs = new Date(s.start_ts as string);
    const endTs   = new Date(s.end_ts as string);

    if (isNaN(startTs.getTime())) {
      errors.push({ index: i, field: 'start_ts', message: "Field 'start_ts' must be a valid ISO 8601 timestamp" });
      hasError = true;
    } else {
      const startTsMs = startTs.getTime();
      if (startTsMs < minTsMs) {
        errors.push({
          index: i,
          field: 'start_ts',
          message: `Field 'start_ts' is too far in the past (max 2 years ago)`,
        });
        hasError = true;
      } else if (startTsMs > maxTsMs) {
        errors.push({
          index: i,
          field: 'start_ts',
          message: `Field 'start_ts' is too far in the future (max 24h ahead)`,
        });
        hasError = true;
      }
    }

    if (isNaN(endTs.getTime())) {
      errors.push({ index: i, field: 'end_ts', message: "Field 'end_ts' must be a valid ISO 8601 timestamp" });
      hasError = true;
    } else if (!hasError) {
      const endTsMs = endTs.getTime();
      if (endTsMs < minTsMs) {
        errors.push({
          index: i,
          field: 'end_ts',
          message: `Field 'end_ts' is too far in the past (max 2 years ago)`,
        });
        hasError = true;
      } else if (endTsMs > maxTsMs) {
        errors.push({
          index: i,
          field: 'end_ts',
          message: `Field 'end_ts' is too far in the future (max 24h ahead)`,
        });
        hasError = true;
      }
    }

    if (!hasError && !isNaN(startTs.getTime()) && !isNaN(endTs.getTime()) && endTs < startTs) {
      errors.push({ index: i, field: 'end_ts', message: "Field 'end_ts' must be >= 'start_ts'" });
      hasError = true;
    }
    if (hasError) continue;

    // Metadata sanitisation.
    const metaResult = sanitiseMetadata(s.metadata);
    if (!metaResult.ok) {
      errors.push({ index: i, field: 'metadata', message: metaResult.message });
      continue;
    }

    valid.push({
      source,
      metric_type: metricType,
      start_ts: String(s.start_ts),
      end_ts:   String(s.end_ts),
      value:    s.value as number,
      unit,
      metadata: metaResult.value,
    });
  }

  return { valid, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns YYYY-MM-DD for a given ISO timestamp.
 * NOTE: All timestamps are assumed to be UTC. The client is responsible for
 * aligning timestamps to the user's local midnight before sending.
 * An optional timezone parameter can be passed in the payload for
 * server-side alignment (stored in metadata / future use).
 */
function toDateString(ts: string): string {
  return new Date(ts).toISOString().split('T')[0];
}

/**
 * Wraps JSON.stringify of an error for safe client responses.
 * Returns a sanitised message + a traceable error_id.
 */
function makeErrorResponse(
  publicMessage: string,
  status: number,
  corsHeaders: Record<string, string>,
  privateDetail?: unknown,
): Response {
  const errorId = crypto.randomUUID();
  if (privateDetail !== undefined) {
    console.error(`[${errorId}]`, privateDetail);
  }
  return new Response(
    JSON.stringify({ error: publicMessage, error_id: errorId }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

/**
 * Runs an async task with a timeout. Rejects with a TimeoutError if the
 * task does not complete within the given number of milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const origin      = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // ââ Preflight ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // ââ Content-Type validation ââââââââââââââââââââââââââââââââââââââââââââââ
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return new Response(
      JSON.stringify({ error: "Content-Type must be 'application/json'." }),
      { status: 415, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    // ââ Auth âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const jwt = authHeader.slice('Bearer '.length);

    // User-scoped client (validates JWT, no elevated privileges).
    const userClient = createClient(supabaseUrl!, supabaseAnonKey!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth:   { persistSession: false },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: invalid or expired token.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const userId = user.id;

    // ââ Body size guard ââââââââââââââââââââââââââââââââââââââââââââââââââ
    const contentLengthHeader = req.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
        return new Response(
          JSON.stringify({ error: `Request body too large. Maximum ${MAX_BODY_BYTES} bytes.` }),
          { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    let rawBodyText: string;
    try {
      rawBodyText = await req.text();
    } catch (e) {
      return makeErrorResponse('Failed to read request body.', 500, corsHeaders, e);
    }

    if (rawBodyText.length > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({ error: `Request body too large. Maximum ${MAX_BODY_BYTES} bytes.` }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ââ Parse JSON âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    let body: unknown;
    try {
      body = JSON.parse(rawBodyText);
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (typeof body !== 'object' || body === null || !('samples' in body)) {
      return new Response(
        JSON.stringify({ error: "Request body must be a JSON object with a 'samples' array." }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { samples: rawSamples } = body as { samples: unknown };

    if (!Array.isArray(rawSamples)) {
      return new Response(
        JSON.stringify({ error: "'samples' must be an array." }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (rawSamples.length === 0) {
      return new Response(
        JSON.stringify({ synced: 0, aggregates_updated: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (rawSamples.length > MAX_SAMPLES) {
      return new Response(
        JSON.stringify({ error: `Too many samples. Maximum ${MAX_SAMPLES} per request.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ââ Validate âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const { valid: validSamples, errors: validationErrors } = validateSamples(rawSamples);

    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'Validation failed for one or more samples.',
          validation_errors: validationErrors,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ââ UPSERT health_samples via RPC ââââââââââââââââââââââââââââââââââââ
    // NOTE: health data (value, metadata) should be encrypted at the column
    // level using pgcrypto (pgp_sym_encrypt) or Supabase Vault. The RPC
    // function `upsert_health_samples` is expected to handle encryption
    // transparently. Until column-level encryption is configured in the DB,
    // data is protected solely by cloud-provider disk encryption and Supabase
    // Row-Level Security (RLS).
    //
    // The RPC is expected to:
    //   1. Upsert rows into health_samples.
    //   2. Return a result set of { id, metric_type, start_ts, is_new_insert }
    //      where is_new_insert = (xmax = 0) at the time of write.
    //
    // Fallback: if the RPC is not yet available we perform a direct upsert
    // and mark all rows as new (conservative: may create extra jobs).

    const rows = validSamples.map((s) => ({
      user_id:     userId,
      source:      s.source,
      metric_type: s.metric_type,
      start_ts:    s.start_ts,
      end_ts:      s.end_ts,
      value:       s.value,
      unit:        s.unit,
      // NOTE: encrypt metadata via pgcrypto inside the DB function.
      metadata:    s.metadata ?? null,
    }));

    // Try RPC-based upsert first (returns is_new_insert via xmax trick).
    let syncedCount = 0;
    let newlyInsertedMetricTypes: string[] = [];
    let newlyInsertedDates: string[] = [];
    let hasNewInserts = false;

    const { data: rpcUpsertData, error: rpcUpsertError } = await adminClient.rpc(
      'upsert_health_samples',
      { p_rows: rows },
    );

    if (rpcUpsertError) {
      // RPC not available or failed â fall back to direct upsert.
      console.warn('upsert_health_samples RPC unavailable, falling back to direct upsert:', rpcUpsertError.message);

      const { data: upsertedData, error: upsertError } = await adminClient
        .from('health_samples')
        .upsert(rows, {
          onConflict:       'user_id,source,metric_type,start_ts',
          ignoreDuplicates: false,
        })
        .select('id, metric_type, start_ts');

      if (upsertError) {
        return makeErrorResponse('Failed to sync health samples.', 500, corsHeaders, upsertError);
      }

      syncedCount = upsertedData?.length ?? 0;
      // Conservative: treat all as new inserts when RPC is unavailable.
      hasNewInserts = syncedCount > 0;
      newlyInsertedMetricTypes = [...new Set(validSamples.map((s) => s.metric_type))];
      newlyInsertedDates       = [...new Set(validSamples.map((s) => toDateString(s.start_ts)))];
    } else {
      // RPC succeeded.
      // Expected shape: Array<{ id: string, metric_type: string, start_ts: string, is_new_insert: boolean }>
      const upsertResult = (rpcUpsertData ?? []) as Array<{
        id:            string;
        metric_type:   string;
        start_ts:      string;
        is_new_insert: boolean;
      }>;

      syncedCount = upsertResult.length;

      const newRows = upsertResult.filter((r) => r.is_new_insert);
      hasNewInserts = newRows.length > 0;

      newlyInsertedMetricTypes = [...new Set(newRows.map((r) => r.metric_type))];
      newlyInsertedDates       = [...new Set(newRows.map((r) => toDateString(r.start_ts)))];
    }

    // ââ Recalculate daily aggregates via RPC âââââââââââââââââââââââââââââ
    // Prefer a single RPC call that handles all (date, metric_type) pairs
    // server-side to avoid N+1 DB round-trips.
    //
    // Expected RPC signature:
    //   recalculate_daily_aggregates(
    //     p_user_id uuid,
    //     p_pairs   jsonb   -- [{date, metric_type}]
    //   ) returns int       -- number of aggregate rows upserted

    const affectedPairsMap = new Map<string, { date: string; metric_type: string }>();
    for (const s of validSamples) {
      const date = toDateString(s.start_ts);
      const key  = `${date}::${s.metric_type}`;
      if (!affectedPairsMap.has(key)) {
        affectedPairsMap.set(key, { date, metric_type: s.metric_type });
      }
    }

    let aggregatesUpdated = 0;
    const affectedPairs = [...affectedPairsMap.values()];

    if (affectedPairs.length > MAX_AFFECTED_PAIRS) {
      console.warn(
        `health-sync: ${affectedPairs.length} affected (date, metric_type) pairs exceeds MAX_AFFECTED_PAIRS=${MAX_AFFECTED_PAIRS}. ` +
        'Truncating to limit. Consider splitting the payload into smaller batches.',
      );
      affectedPairs.splice(MAX_AFFECTED_PAIRS);
    }

    const { data: rpcAggData, error: rpcAggError } = await adminClient.rpc(
      'recalculate_daily_aggregates',
      { p_user_id: userId, p_pairs: affectedPairs },
    );

    if (rpcAggError) {
      // RPC not available â fall back to a time-bounded batched loop (best-effort, logged).
      console.warn(
        'recalculate_daily_aggregates RPC unavailable, falling back to batched loop. ' +
        'Please create the RPC to avoid performance issues:',
        rpcAggError.message,
      );

      /**
       * Process a single (date, metric_type) pair and return 1 if the
       * aggregate was successfully upserted, 0 otherwise.
       */
      const processOnePair = async (
        date: string,
        metric_type: string,
      ): Promise<number> => {
        const isCumulative = CUMULATIVE_METRICS.has(metric_type);

        const startOfDay = `${date}T00:00:00.000Z`;
        const endOfDay   = `${date}T23:59:59.999Z`;

        const { data: daySamples, error: fetchError } = await adminClient
          .from('health_samples')
          .select('value, unit')
          .eq('user_id',     userId)
          .eq('metric_type', metric_type)
          .gte('start_ts',   startOfDay)
          .lte('start_ts',   endOfDay);

        if (fetchError) {
          const fId = crypto.randomUUID();
          console.error(`[${fId}] Failed to fetch samples for aggregation (${date}, ${metric_type}):`, fetchError);
          return 0;
        }

        if (!daySamples || daySamples.length === 0) return 0;

        const values = daySamples.map((s: { value: number }) => s.value);
        const unit   = (daySamples[0] as { unit: string }).unit;

        let aggregatedValue:   number;
        let aggregationMethod: string;

        if (isCumulative) {
          aggregatedValue   = values.reduce((sum: number, v: number) => sum + v, 0);
          aggregationMethod = 'sum';
        } else {
          // continuous or unknown â average
          aggregatedValue   = values.reduce((sum: number, v: number) => sum + v, 0) / values.length;
          aggregationMethod = 'avg';
        }

        const aggregateRow = {
          user_id:            userId,
          date,
          metric_type,
          aggregated_value:   aggregatedValue,
          unit,
          aggregation_method: aggregationMethod,
          sample_count:       daySamples.length,
          updated_at:         new Date().toISOString(),
        };

        const { error: aggError } = await adminClient
          .from('health_daily_aggregates')
          .upsert(aggregateRow, {
            onConflict:       'user_id,date,metric_type',
            ignoreDuplicates: false,
          });

        if (aggError) {
          const aId = crypto.randomUUID();
          console.error(`[${aId}] Failed to upsert aggregate (${date}, ${metric_type}):`, aggError);
          return 0;
        }

        return 1;
      };

      /**
       * Process all pairs in concurrent batches of FALLBACK_AGG_CONCURRENCY,
       * bounded by FALLBACK_AGG_TIMEOUT_MS total wall-clock time.
       */
      const runBatchedAggregation = async (): Promise<number> => {
        let total = 0;
        for (let i = 0; i < affectedPairs.length; i += FALLBACK_AGG_CONCURRENCY) {
          const batch = affectedPairs.slice(i, i + FALLBACK_AGG_CONCURRENCY);
          const results = await Promise.all(
            batch.map(({ date, metric_type }) => processOnePair(date, metric_type))
          );
          total += results.reduce((s, v) => s + v, 0);
        }
        return total;
      };

      try {
        aggregatesUpdated = await withTimeout(
          runBatchedAggregation(),
          FALLBACK_AGG_TIMEOUT_MS,
          'fallback aggregation loop',
        );
      } catch (timeoutErr) {
        const tId = crypto.randomUUID();
        console.error(
          `[${tId}] Fallback aggregation loop timed out or failed after ${FALLBACK_AGG_TIMEOUT_MS}ms:`,
          timeoutErr,
        );
        // Non-fatal: continue with whatever count was accumulated before timeout.
        // aggregatesUpdated remains at its last known value (0 if timeout fired before any result).
      }
    } else {
      aggregatesUpdated = typeof rpcAggData === 'number' ? rpcAggData : (rpcAggData as unknown as number | null) ?? 0;
    }

    // ââ Create job for jarvis-engine (only for genuinely new data) âââââââ
    if (hasNewInserts && newlyInsertedMetricTypes.length > 0) {
      const jobRow = {
        user_id:  userId,
        job_type: 'health_analysis',
        status:   'pending',
        payload: {
          trigger:            'health_sync',
          new_samples_count:  syncedCount,
          metric_types:       newlyInsertedMetricTypes,
          dates:              newlyInsertedDates,
          synced_at:          new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      };

      const { error: jobError } = await adminClient
        .from('jobs')
        .insert(jobRow);

      if (jobError) {
        // Non-fatal: log but do not fail the request.
        const jId = crypto.randomUUID();
        console.error(`[${jId}] Failed to create jarvis-engine job:`, jobError);
      }
    }

    // ââ Success ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    return new Response(
      JSON.stringify({
        synced:             syncedCount,
        aggregates_updated: aggregatesUpdated,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    return makeErrorResponse('Internal server error.', 500, corsHeaders, err);
  }
});
