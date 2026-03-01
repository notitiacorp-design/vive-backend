import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "https://votre-domaine.com")
  .split(",")
  .map((o) => o.trim());

// Rate limiting: in-memory store per user (resets on cold start)
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_CALLS = 3;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_CALLS) {
    return false;
  }
  entry.count += 1;
  return true;
}

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function corsResponse(body: string | null, status = 200, requestOrigin: string | null = null) {
  return new Response(body, {
    status,
    headers: { ...getCorsHeaders(requestOrigin), "Content-Type": "application/json; charset=utf-8" },
  });
}

// Robust log ID: use a simple hash to avoid correlation in small user sets
async function hashUserId(userId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface HealthAggregate {
  date: string;
  user_id: string;
  deep_sleep_minutes?: number;
  sleep_latency_minutes?: number;
  sleep_fragmentation_index?: number;
  hrv_rmssd?: number;
  stress_score?: number;
  active_minutes?: number;
  steps?: number;
  total_sleep_minutes?: number;
  sleep_score?: number;
  readiness_score?: number;
}

interface JarvisState {
  id?: string;
  user_id: string;
  current_bottleneck?: string;
  active_objective?: string;
  last_analysis?: string;
  context?: Record<string, unknown>;
  streak_days?: number;
  total_xp?: number;
}

interface Mission {
  title: string;
  description: string;
  category: string;
  difficulty: string;
  xp_reward: number;
}

interface OpenAIResponse {
  briefing_text: string;
  missions: Mission[];
}

type BottleneckKey =
  | "sommeil_profond"
  | "latence_endormissement"
  | "fragmentation_sommeil"
  | "hrv_faible"
  | "stress_eleve"
  | "manque_activite";

const VALID_CATEGORIES = ["sommeil", "activite", "stress", "nutrition", "respiration", "meditation"] as const;
const VALID_DIFFICULTIES = ["facile", "moyen", "difficile"] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function analyzeBottleneck(aggregates: HealthAggregate[]): BottleneckKey {
  if (!aggregates || aggregates.length === 0) return "manque_activite";

  const avg = (arr: (number | undefined)[]): number => {
    const valid = arr.filter((v): v is number => v !== undefined && v !== null);
    if (valid.length === 0) return 0;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  };

  const avgDeepSleep = avg(aggregates.map((a) => a.deep_sleep_minutes));
  const avgLatency = avg(aggregates.map((a) => a.sleep_latency_minutes));
  const avgFragmentation = avg(aggregates.map((a) => a.sleep_fragmentation_index));
  const avgHRV = avg(aggregates.map((a) => a.hrv_rmssd));
  const avgStress = avg(aggregates.map((a) => a.stress_score));
  const avgActive = avg(aggregates.map((a) => a.active_minutes));

  const scores: Record<BottleneckKey, number> = {
    sommeil_profond: 0,
    latence_endormissement: 0,
    fragmentation_sommeil: 0,
    hrv_faible: 0,
    stress_eleve: 0,
    manque_activite: 0,
  };

  if (avgDeepSleep > 0 && avgDeepSleep < 60) {
    scores.sommeil_profond = (60 - avgDeepSleep) / 60;
  }

  if (avgLatency > 20) {
    scores.latence_endormissement = Math.min((avgLatency - 20) / 40, 1);
  }

  if (avgFragmentation > 0.3) {
    scores.fragmentation_sommeil = Math.min((avgFragmentation - 0.3) / 0.7, 1);
  }

  if (avgHRV > 0 && avgHRV < 40) {
    scores.hrv_faible = (40 - avgHRV) / 40;
  }

  if (avgStress > 60) {
    scores.stress_eleve = Math.min((avgStress - 60) / 40, 1);
  }

  if (avgActive < 30) {
    scores.manque_activite = avgActive === 0 ? 1 : (30 - avgActive) / 30;
  }

  let maxScore = -1;
  let bottleneck: BottleneckKey = "manque_activite";
  for (const [key, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bottleneck = key as BottleneckKey;
    }
  }

  return bottleneck;
}

function bottleneckLabel(key: BottleneckKey): string {
  const labels: Record<BottleneckKey, string> = {
    sommeil_profond: "manque de sommeil profond",
    latence_endormissement: "latence d\u2019endormissement \u00e9lev\u00e9e",
    fragmentation_sommeil: "fragmentation du sommeil",
    hrv_faible: "variabilit\u00e9 cardiaque faible (HRV)",
    stress_eleve: "niveau de stress \u00e9lev\u00e9",
    manque_activite: "manque d\u2019activit\u00e9 physique",
  };
  return labels[key];
}

function buildHealthSummary(aggregates: HealthAggregate[]): string {
  if (!aggregates || aggregates.length === 0) return "Aucune donn\u00e9e de sant\u00e9 disponible.";

  const avg = (arr: (number | undefined)[]): string => {
    const valid = arr.filter((v): v is number => v !== undefined && v !== null);
    if (valid.length === 0) return "N/A";
    return (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1);
  };

  return `R\u00e9sum\u00e9 des 7 derniers jours:\n- Sommeil profond moyen: ${avg(aggregates.map((a) => a.deep_sleep_minutes))} min\n- Latence d\u2019endormissement moyenne: ${avg(aggregates.map((a) => a.sleep_latency_minutes))} min\n- Index de fragmentation moyen: ${avg(aggregates.map((a) => a.sleep_fragmentation_index))}\n- HRV (RMSSD) moyen: ${avg(aggregates.map((a) => a.hrv_rmssd))} ms\n- Score de stress moyen: ${avg(aggregates.map((a) => a.stress_score))}/100\n- Minutes d\u2019activit\u00e9 moyennes: ${avg(aggregates.map((a) => a.active_minutes))} min\n- Pas moyens: ${avg(aggregates.map((a) => a.steps))}\n- Dur\u00e9e totale de sommeil moyenne: ${avg(aggregates.map((a) => a.total_sleep_minutes))} min\n- Score de sommeil moyen: ${avg(aggregates.map((a) => a.sleep_score))}/100\n- Score de readiness moyen: ${avg(aggregates.map((a) => a.readiness_score))}/100`;
}

function validateAndSanitizeOpenAIResponse(parsed: unknown): OpenAIResponse {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OpenAI response is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.briefing_text !== "string" || obj.briefing_text.trim().length === 0) {
    throw new Error("Invalid briefing_text in OpenAI response");
  }

  if (!Array.isArray(obj.missions)) {
    throw new Error("missions must be an array in OpenAI response");
  }

  if (obj.missions.length !== 3) {
    throw new Error(`Expected exactly 3 missions, got ${obj.missions.length}`);
  }

  const validatedMissions: Mission[] = obj.missions.map((mission: unknown, index: number) => {
    if (typeof mission !== "object" || mission === null) {
      throw new Error(`Mission ${index} is not an object`);
    }

    const m = mission as Record<string, unknown>;

    if (typeof m.title !== "string" || m.title.trim().length === 0) {
      throw new Error(`Mission ${index}: title is required and must be a string`);
    }
    if (typeof m.description !== "string" || m.description.trim().length === 0) {
      throw new Error(`Mission ${index}: description is required and must be a string`);
    }
    if (typeof m.category !== "string") {
      throw new Error(`Mission ${index}: category must be a string`);
    }
    if (typeof m.difficulty !== "string") {
      throw new Error(`Mission ${index}: difficulty must be a string`);
    }
    if (typeof m.xp_reward !== "number" || isNaN(m.xp_reward)) {
      throw new Error(`Mission ${index}: xp_reward must be a number`);
    }

    const category = m.category.toLowerCase().trim();
    if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Mission ${index}: invalid category '${category}'. Must be one of: ${VALID_CATEGORIES.join(", ")}`);
    }

    const difficulty = m.difficulty.toLowerCase().trim();
    if (!(VALID_DIFFICULTIES as readonly string[]).includes(difficulty)) {
      throw new Error(`Mission ${index}: invalid difficulty '${difficulty}'. Must be one of: ${VALID_DIFFICULTIES.join(", ")}`);
    }

    const xp_reward = Math.round(m.xp_reward);
    if (xp_reward < 50 || xp_reward > 200) {
      throw new Error(`Mission ${index}: xp_reward must be between 50 and 200, got ${xp_reward}`);
    }

    return {
      title: m.title.trim().substring(0, 50),
      description: m.description.trim().substring(0, 200),
      category,
      difficulty,
      xp_reward,
    };
  });

  return {
    briefing_text: obj.briefing_text.trim().substring(0, 2000),
    missions: validatedMissions,
  };
}

async function callOpenAI(
  healthSummary: string,
  bottleneck: BottleneckKey,
  jarvisState: JarvisState | null,
  openaiKey: string
): Promise<OpenAIResponse> {
  const systemPrompt = `Tu es JARVIS, un coach de sant\u00e9 expert et bienveillant qui s\u2019exprime en fran\u00e7ais.\nTu analyses les donn\u00e9es de sant\u00e9 de l\u2019utilisateur et tu cr\u00e9es des briefings personnalis\u00e9s, encourageants et motivants.\nTu es pr\u00e9cis, scientifique mais accessible, et tu adaptes tes recommandations au profil unique de chaque personne.\nTu g\u00e9n\u00e8res toujours une r\u00e9ponse JSON valide avec les champs demand\u00e9s.`;

  const streakInfo = jarvisState?.streak_days
    ? `L\u2019utilisateur est en s\u00e9rie de ${jarvisState.streak_days} jours cons\u00e9cutifs.`
    : "";
  const xpInfo = jarvisState?.total_xp ? `XP total: ${jarvisState.total_xp} points.` : "";
  const previousObjective = jarvisState?.active_objective
    ? `Objectif pr\u00e9c\u00e9dent: ${jarvisState.active_objective}`
    : "";

  const userMessage = `${healthSummary}\n\nPrincipal point d\u2019am\u00e9lioration identifi\u00e9: ${bottleneckLabel(bottleneck)}\n${streakInfo}\n${xpInfo}\n${previousObjective}\n\nG\u00e9n\u00e8re un briefing quotidien personnalis\u00e9 en JSON avec:\n1. Un texte de briefing motivant et personnalis\u00e9 (briefing_text) - 3 \u00e0 5 phrases, chaleureux et encourageant\n2. Exactement 3 missions concr\u00e8tes et r\u00e9alisables aujourd\u2019hui (missions) qui adressent principalement le point d\u2019am\u00e9lioration identifi\u00e9\n\nFormat JSON requis:\n{\n  "briefing_text": "string",\n  "missions": [\n    {\n      "title": "string (court, max 50 chars)",\n      "description": "string (instructions claires, max 200 chars)",\n      "category": "string (une parmi: sommeil, activite, stress, nutrition, respiration, meditation)",\n      "difficulty": "string (une parmi: facile, moyen, difficile)",\n      "xp_reward": number (entre 50 et 200)\n    }\n  ]\n}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 1200,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Read and discard the raw error body without forwarding sensitive details
      const _rawError = await response.text();
      // Only expose status code to the error chain, never the raw body
      throw new Error(`OpenAI API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in OpenAI response");

    const parsed: unknown = JSON.parse(content);
    return validateAndSanitizeOpenAIResponse(parsed);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OpenAI API call timed out after 30 seconds");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

serve(async (req: Request) => {
  const requestOrigin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(requestOrigin) });
  }

  if (req.method !== "POST") {
    return corsResponse(JSON.stringify({ error: "Method not allowed" }), 405, requestOrigin);
  }

  // Capture a single timestamp for temporal consistency
  const NOW = new Date();
  const now = NOW.toISOString();
  const today = now.split("T")[0];

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return corsResponse(
        JSON.stringify({ error: "Internal server error", code: "CONFIG_ERROR" }),
        500,
        requestOrigin
      );
    }

    if (!openaiKey) {
      return corsResponse(
        JSON.stringify({ error: "Internal server error", code: "CONFIG_ERROR" }),
        500,
        requestOrigin
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // Step 0: Verify JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return corsResponse(
        JSON.stringify({ error: "Unauthorized: missing or invalid Authorization header" }),
        401,
        requestOrigin
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authenticatedUser) {
      return corsResponse(
        JSON.stringify({ error: "Unauthorized: invalid or expired token" }),
        401,
        requestOrigin
      );
    }

    let user_id: string;
    try {
      const body = await req.json();
      user_id = body.user_id;
    } catch {
      return corsResponse(JSON.stringify({ error: "Invalid JSON body" }), 400, requestOrigin);
    }

    if (!user_id || typeof user_id !== "string") {
      return corsResponse(JSON.stringify({ error: "user_id is required" }), 400, requestOrigin);
    }

    // Validate UUID format
    if (!UUID_REGEX.test(user_id)) {
      return corsResponse(
        JSON.stringify({ error: "Invalid user_id format" }),
        400,
        requestOrigin
      );
    }

    // Verify the authenticated user matches the requested user_id
    if (authenticatedUser.id !== user_id) {
      return corsResponse(
        JSON.stringify({ error: "Forbidden: you can only access your own data" }),
        403,
        requestOrigin
      );
    }

    // Opaque log identifier using a hash for RGPD compliance
    const logId = await hashUserId(user_id);

    // Rate limiting: prevent repeated expensive calls within the same window
    if (!checkRateLimit(user_id)) {
      console.warn(`[${logId}] Rate limit exceeded`);
      return corsResponse(
        JSON.stringify({ error: "Too many requests. Please wait before calling again.", code: "RATE_LIMITED" }),
        429,
        requestOrigin
      );
    }

    const warnings: string[] = [];

    // Step 1: Fetch last 7 days of health aggregates (explicit columns, explicit limit)
    const sevenDaysAgo = new Date(NOW);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    // NOTE: Ensure the following indexes exist in your database for performance and correctness:
    //   CREATE INDEX IF NOT EXISTS idx_health_daily_aggregates_user_date ON health_daily_aggregates(user_id, date);
    //   CREATE UNIQUE INDEX IF NOT EXISTS idx_jarvis_states_user_id ON jarvis_states(user_id);
    // The upsert on jarvis_states uses onConflict: 'user_id', which requires a unique index on user_id.
    const { data: aggregates, error: aggregatesError } = await supabase
      .from("health_daily_aggregates")
      .select(
        "date,user_id,deep_sleep_minutes,sleep_latency_minutes,sleep_fragmentation_index,hrv_rmssd,stress_score,active_minutes,steps,total_sleep_minutes,sleep_score,readiness_score"
      )
      .eq("user_id", user_id)
      .gte("date", sevenDaysAgoStr)
      .order("date", { ascending: false })
      .limit(7);

    if (aggregatesError) {
      console.error(`[${logId}] Error fetching health aggregates:`, aggregatesError.message);
      return corsResponse(
        JSON.stringify({ error: "Failed to fetch health data", code: "DB_ERROR" }),
        500,
        requestOrigin
      );
    }

    // Step 2: Fetch current jarvis_state (explicit columns)
    const { data: jarvisStateData, error: jarvisError } = await supabase
      .from("jarvis_states")
      .select("id,user_id,current_bottleneck,active_objective,last_analysis,context,streak_days,total_xp")
      .eq("user_id", user_id)
      .maybeSingle();

    if (jarvisError) {
      console.error(`[${logId}] Error fetching jarvis state:`, jarvisError.message);
      warnings.push("jarvis_state_fetch_degraded");
    }

    const jarvisState: JarvisState | null = jarvisStateData;

    // Step 3: Analyze bottleneck
    const healthAggregates: HealthAggregate[] = aggregates || [];
    const bottleneck = analyzeBottleneck(healthAggregates);
    const healthSummary = buildHealthSummary(healthAggregates);

    console.log(`[${logId}] JARVIS engine: bottleneck=${bottleneck}, data_points=${healthAggregates.length}`);

    // Step 3b: Idempotency check â if missions already exist for this user+date, return them
    const { data: existingMissions, error: existingError } = await supabase
      .from("missions")
      .select("id,user_id,title,description,category,difficulty,xp_reward,status,assigned_date,source,bottleneck_target,created_at")
      .eq("user_id", user_id)
      .eq("assigned_date", today)
      .eq("source", "jarvis")
      .limit(10);

    if (!existingError && existingMissions && existingMissions.length >= 3) {
      console.log(`[${logId}] Idempotency: missions already exist for today, returning cached result`);
      // Fetch jarvis state for active_objective
      const activeObj = jarvisState?.active_objective ?? `Am\u00e9liorer: ${bottleneckLabel(bottleneck)}`;
      const cachedPayload = {
        success: true,
        bottleneck: jarvisState?.current_bottleneck ?? bottleneck,
        bottleneck_label: bottleneckLabel((jarvisState?.current_bottleneck as BottleneckKey) ?? bottleneck),
        briefing_text: null,
        missions: existingMissions,
        active_objective: activeObj,
        analysis_date: jarvisState?.last_analysis ?? now,
        health_data_points: healthAggregates.length,
        idempotent: true,
      };
      return corsResponse(JSON.stringify(cachedPayload), 200, requestOrigin);
    }

    // Step 4: Call OpenAI
    let openAIResult: OpenAIResponse;
    try {
      openAIResult = await callOpenAI(healthSummary, bottleneck, jarvisState, openaiKey);
    } catch (err) {
      console.error(`[${logId}] OpenAI error:`, err instanceof Error ? err.message : "Unknown error");
      return corsResponse(
        JSON.stringify({ error: "Failed to generate briefing", code: "OPENAI_ERROR" }),
        500,
        requestOrigin
      );
    }

    // Step 5: Store missions
    const missionsToInsert = openAIResult.missions.map((mission) => ({
      user_id,
      title: mission.title,
      description: mission.description,
      category: mission.category,
      difficulty: mission.difficulty,
      xp_reward: mission.xp_reward,
      status: "pending",
      assigned_date: today,
      source: "jarvis",
      bottleneck_target: bottleneck,
      created_at: now,
    }));

    const { data: insertedMissions, error: missionsError } = await supabase
      .from("missions")
      .insert(missionsToInsert)
      .select("id,user_id,title,description,category,difficulty,xp_reward,status,assigned_date,source,bottleneck_target,created_at");

    if (missionsError) {
      console.error(`[${logId}] Error inserting missions:`, missionsError.message);
      return corsResponse(
        JSON.stringify({ error: "Failed to store missions", code: "DB_ERROR" }),
        500,
        requestOrigin
      );
    }

    // Verify that the expected number of missions was inserted
    const finalMissions = insertedMissions ?? [];
    if (finalMissions.length !== 3) {
      console.warn(`[${logId}] Expected 3 inserted missions, got ${finalMissions.length}. Falling back to missionsToInsert.`);
      // Emit a monitoring warning for alerting systems
      warnings.push("missions_insert_count_mismatch");
    }

    const missionsResult = finalMissions.length === 3 ? finalMissions : missionsToInsert;

    // Step 6: Update jarvis_states
    const activeObjective = `Am\u00e9liorer: ${bottleneckLabel(bottleneck)}`;
    const contextData = {
      last_bottleneck: bottleneck,
      briefing_date: today,
      missions_count: openAIResult.missions.length,
      aggregates_count: healthAggregates.length,
    };

    const upsertData = {
      user_id,
      current_bottleneck: bottleneck,
      active_objective: activeObjective,
      last_analysis: now,
      context: contextData,
      updated_at: now,
    };

    const { error: upsertError } = await supabase
      .from("jarvis_states")
      .upsert(upsertData, { onConflict: "user_id" });

    if (upsertError) {
      console.error(`[${logId}] Error updating jarvis state:`, upsertError.message);
      warnings.push("jarvis_state_update_failed");
      // Emit alerting hook for monitoring: log a structured warning that can be picked up by log aggregators
      console.warn(JSON.stringify({
        alert: "jarvis_state_update_failed",
        logId,
        timestamp: now,
        error: upsertError.message,
      }));
    }

    // Step 7: Return response
    const responsePayload = {
      success: true,
      bottleneck,
      bottleneck_label: bottleneckLabel(bottleneck),
      briefing_text: openAIResult.briefing_text,
      missions: missionsResult,
      active_objective: activeObjective,
      analysis_date: now,
      health_data_points: healthAggregates.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    console.log(`[${logId}] JARVIS engine completed successfully`);
    return corsResponse(JSON.stringify(responsePayload), 200, requestOrigin);
  } catch (err) {
    console.error("Unexpected error in jarvis-engine:", err instanceof Error ? err.message : "Unknown error");
    return corsResponse(
      JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR" }),
      500,
      requestOrigin
    );
  }
});
