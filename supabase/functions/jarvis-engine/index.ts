import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function corsResponse(body: string | null, status = 200) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

  // Deep sleep: less than 60 min is problematic
  if (avgDeepSleep > 0 && avgDeepSleep < 60) {
    scores.sommeil_profond = (60 - avgDeepSleep) / 60;
  }

  // Sleep latency: more than 20 min is problematic
  if (avgLatency > 20) {
    scores.latence_endormissement = Math.min((avgLatency - 20) / 40, 1);
  }

  // Fragmentation: index > 0.3 is problematic
  if (avgFragmentation > 0.3) {
    scores.fragmentation_sommeil = Math.min((avgFragmentation - 0.3) / 0.7, 1);
  }

  // HRV: less than 40ms is problematic
  if (avgHRV > 0 && avgHRV < 40) {
    scores.hrv_faible = (40 - avgHRV) / 40;
  }

  // Stress: more than 60 is problematic
  if (avgStress > 60) {
    scores.stress_eleve = Math.min((avgStress - 60) / 40, 1);
  }

  // Activity: less than 30 active minutes is problematic
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
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in OpenAI response");

  const parsed: OpenAIResponse = JSON.parse(content);

  if (!parsed.briefing_text || !Array.isArray(parsed.missions)) {
    throw new Error("Invalid OpenAI response structure");
  }

  return parsed;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return corsResponse(JSON.stringify({ error: "Method not allowed" }), 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return corsResponse(JSON.stringify({ error: "Missing Supabase configuration" }), 500);
    }

    if (!openaiKey) {
      return corsResponse(JSON.stringify({ error: "Missing OpenAI API key" }), 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    let user_id: string;
    try {
      const body = await req.json();
      user_id = body.user_id;
    } catch {
      return corsResponse(JSON.stringify({ error: "Invalid JSON body" }), 400);
    }

    if (!user_id || typeof user_id !== "string") {
      return corsResponse(JSON.stringify({ error: "user_id is required" }), 400);
    }

    // Step 1: Fetch last 7 days of health aggregates
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    const { data: aggregates, error: aggregatesError } = await supabase
      .from("health_daily_aggregates")
      .select("*")
      .eq("user_id", user_id)
      .gte("date", sevenDaysAgoStr)
      .order("date", { ascending: false });

    if (aggregatesError) {
      console.error("Error fetching health aggregates:", aggregatesError);
      return corsResponse(
        JSON.stringify({ error: "Failed to fetch health data", details: aggregatesError.message }),
        500
      );
    }

    // Step 2: Fetch current jarvis_state
    const { data: jarvisStateData, error: jarvisError } = await supabase
      .from("jarvis_states")
      .select("*")
      .eq("user_id", user_id)
      .maybeSingle();

    if (jarvisError) {
      console.error("Error fetching jarvis state:", jarvisError);
    }

    const jarvisState: JarvisState | null = jarvisStateData;

    // Step 3: Analyze bottleneck
    const healthAggregates: HealthAggregate[] = aggregates || [];
    const bottleneck = analyzeBottleneck(healthAggregates);
    const healthSummary = buildHealthSummary(healthAggregates);

    console.log(`User ${user_id}: Bottleneck identified as ${bottleneck}`);

    // Step 4: Call OpenAI
    let openAIResult: OpenAIResponse;
    try {
      openAIResult = await callOpenAI(healthSummary, bottleneck, jarvisState, openaiKey);
    } catch (err) {
      console.error("OpenAI error:", err);
      return corsResponse(
        JSON.stringify({ error: "Failed to generate briefing", details: String(err) }),
        500
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
      .select();

    if (missionsError) {
      console.error("Error inserting missions:", missionsError);
      return corsResponse(
        JSON.stringify({ error: "Failed to store missions", details: missionsError.message }),
        500
      );
    }

    // Step 6: Update jarvis_states
    const activeObjective = `AmÃ©liorer: ${bottleneckLabel(bottleneck)}`;
    const contextData = {
      last_bottleneck: bottleneck,
      health_summary: healthSummary,
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
      console.error("Error updating jarvis state:", upsertError);
      // Non-fatal: continue
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
    };

    console.log(`JARVIS engine completed for user ${user_id}`);
    return corsResponse(JSON.stringify(responsePayload), 200);
  } catch (err) {
    console.error("Unexpected error in jarvis-engine:", err);
    return corsResponse(
      JSON.stringify({ error: "Internal server error", details: String(err) }),
      500
    );
  }
});
