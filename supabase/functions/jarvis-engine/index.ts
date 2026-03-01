import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "https://votre-domaine.com")
  .split(",")
  .map((o) => o.trim());

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
    headers: { ...getCorsHeaders(requestOrigin), "Content-Type": "application/json" },
  });
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
    latence_endormissement: "latence d'endormissement Ã©levÃ©e",
    fragmentation_sommeil: "fragmentation du sommeil",
    hrv_faible: "variabilitÃ© cardiaque faible (HRV)",
    stress_eleve: "niveau de stress Ã©levÃ©",
    manque_activite: "manque d'activitÃ© physique",
  };
  return labels[key];
}

function buildHealthSummary(aggregates: HealthAggregate[]): string {
  if (!aggregates || aggregates.length === 0) return "Aucune donnÃ©e de santÃ© disponible.";

  const avg = (arr: (number | undefined)[]): string => {
    const valid = arr.filter((v): v is number => v !== undefined && v !== null);
    if (valid.length === 0) return "N/A";
    return (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1);
  };

  return `RÃ©sumÃ© des 7 derniers jours:
- Sommeil profond moyen: ${avg(aggregates.map((a) => a.deep_sleep_minutes))} min
- Latence d'endormissement moyenne: ${avg(aggregates.map((a) => a.sleep_latency_minutes))} min
- Index de fragmentation moyen: ${avg(aggregates.map((a) => a.sleep_fragmentation_index))}
- HRV (RMSSD) moyen: ${avg(aggregates.map((a) => a.hrv_rmssd))} ms
- Score de stress moyen: ${avg(aggregates.map((a) => a.stress_score))}/100
- Minutes d'activitÃ© moyennes: ${avg(aggregates.map((a) => a.active_minutes))} min
- Pas moyens: ${avg(aggregates.map((a) => a.steps))}
- DurÃ©e totale de sommeil moyenne: ${avg(aggregates.map((a) => a.total_sleep_minutes))} min
- Score de sommeil moyen: ${avg(aggregates.map((a) => a.sleep_score))}/100
- Score de readiness moyen: ${avg(aggregates.map((a) => a.readiness_score))}/100`;
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
  const systemPrompt = `Tu es JARVIS, un coach de santÃ© expert et bienveillant qui s'exprime en franÃ§ais.
Tu analyses les donnÃ©es de santÃ© de l'utilisateur et tu crÃ©es des briefings personnalisÃ©s, encourageants et motivants.
Tu es prÃ©cis, scientifique mais accessible, et tu adaptes tes recommandations au profil unique de chaque personne.
Tu gÃ©nÃ¨res toujours une rÃ©ponse JSON valide avec les champs demandÃ©s.`;

  const streakInfo = jarvisState?.streak_days
    ? `L'utilisateur est en sÃ©rie de ${jarvisState.streak_days} jours consÃ©cutifs.`
    : "";
  const xpInfo = jarvisState?.total_xp ? `XP total: ${jarvisState.total_xp} points.` : "";
  const previousObjective = jarvisState?.active_objective
    ? `Objectif prÃ©cÃ©dent: ${jarvisState.active_objective}`
    : "";

  const userMessage = `${healthSummary}

Principal point d'amÃ©lioration identifiÃ©: ${bottleneckLabel(bottleneck)}
${streakInfo}
${xpInfo}
${previousObjective}

GÃ©nÃ¨re un briefing quotidien personnalisÃ© en JSON avec:
1. Un texte de briefing motivant et personnalisÃ© (briefing_text) - 3 Ã  5 phrases, chaleureux et encourageant
2. Exactement 3 missions concrÃ¨tes et rÃ©alisables aujourd'hui (missions) qui adressent principalement le point d'amÃ©lioration identifiÃ©

Format JSON requis:
{
  "briefing_text": "string",
  "missions": [
    {
      "title": "string (court, max 50 chars)",
      "description": "string (instructions claires, max 200 chars)",
      "category": "string (une parmi: sommeil, activite, stress, nutrition, respiration, meditation)",
      "difficulty": "string (une parmi: facile, moyen, difficile)",
      "xp_reward": number (entre 50 et 200)
    }
  ]
}`;

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
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing required environment variable: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    if (!openaiKey) {
      throw new Error("Missing required environment variable: OPENAI_API_KEY");
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

    // Verify the authenticated user matches the requested user_id
    if (authenticatedUser.id !== user_id) {
      return corsResponse(
        JSON.stringify({ error: "Forbidden: you can only access your own data" }),
        403,
        requestOrigin
      );
    }

    // Opaque log identifier for RGPD compliance
    const logId = user_id.substring(0, 8) + "...";

    const warnings: string[] = [];

    // Step 1: Fetch last 7 days of health aggregates (explicit columns)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    const { data: aggregates, error: aggregatesError } = await supabase
      .from("health_daily_aggregates")
      .select(
        "date,user_id,deep_sleep_minutes,sleep_latency_minutes,sleep_fragmentation_index,hrv_rmssd,stress_score,active_minutes,steps,total_sleep_minutes,sleep_score,readiness_score"
      )
      .eq("user_id", user_id)
      .gte("date", sevenDaysAgoStr)
      .order("date", { ascending: false });

    if (aggregatesError) {
      console.error(`[${logId}] Error fetching health aggregates:`, aggregatesError.message);
      return corsResponse(
        JSON.stringify({ error: "Failed to fetch health data", details: aggregatesError.message }),
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

    // Step 4: Call OpenAI
    let openAIResult: OpenAIResponse;
    try {
      openAIResult = await callOpenAI(healthSummary, bottleneck, jarvisState, openaiKey);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${logId}] OpenAI error: ${errMsg}`);
      return corsResponse(
        JSON.stringify({ error: "Failed to generate briefing", details: errMsg }),
        500,
        requestOrigin
      );
    }

    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();

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
        JSON.stringify({ error: "Failed to store missions", details: missionsError.message }),
        500,
        requestOrigin
      );
    }

    // Step 6: Update jarvis_states
    const activeObjective = `AmÃ©liorer: ${bottleneckLabel(bottleneck)}`;
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
    }

    // Step 7: Return response
    const responsePayload = {
      success: true,
      user_id,
      bottleneck,
      bottleneck_label: bottleneckLabel(bottleneck),
      briefing_text: openAIResult.briefing_text,
      missions: insertedMissions || missionsToInsert,
      active_objective: activeObjective,
      analysis_date: now,
      health_data_points: healthAggregates.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    console.log(`[${logId}] JARVIS engine completed successfully`);
    return corsResponse(JSON.stringify(responsePayload), 200, requestOrigin);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Unexpected error in jarvis-engine:", errMsg);
    return corsResponse(
      JSON.stringify({ error: "Internal server error", details: errMsg }),
      500,
      requestOrigin
    );
  }
});
