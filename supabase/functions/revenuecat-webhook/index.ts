import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REVENUECAT_WEBHOOK_SECRET = Deno.env.get("REVENUECAT_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function mapProductIdToPlan(productId: string): string {
  if (productId.includes("vive_essential")) return "essential";
  if (productId.includes("vive_premium")) return "premium";
  return "free";
}

function msToIso(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

async function handleInitialPurchase(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const productId = event.product_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;
  const plan = mapProductIdToPlan(productId);
  const expiresAt = msToIso(expirationAtMs);
  const purchasedAt = msToIso(event.purchased_at_ms as number) ?? new Date().toISOString();

  console.log(`[INITIAL_PURCHASE] user=${appUserId} product=${productId} plan=${plan}`);

  const { error: subError } = await supabase
    .from("subscriptions")
    .upsert(
      {
        user_id: appUserId,
        product_id: productId,
        plan,
        status: "active",
        current_period_start: purchasedAt,
        current_period_end: expiresAt,
        store: event.store ?? null,
        transaction_id: event.transaction_id ?? null,
        original_transaction_id: event.original_transaction_id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (subError) {
    console.error("[INITIAL_PURCHASE] subscription upsert error:", subError);
    throw subError;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("id", appUserId);

  if (profileError) {
    console.error("[INITIAL_PURCHASE] profile update error:", profileError);
    throw profileError;
  }

  console.log(`[INITIAL_PURCHASE] success user=${appUserId}`);
}

async function handleRenewal(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const productId = event.product_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;
  const purchasedAt = msToIso(event.purchased_at_ms as number) ?? new Date().toISOString();
  const plan = mapProductIdToPlan(productId);

  console.log(`[RENEWAL] user=${appUserId} product=${productId}`);

  const { error: subError } = await supabase
    .from("subscriptions")
    .update({
      status: "active",
      plan,
      current_period_start: purchasedAt,
      current_period_end: msToIso(expirationAtMs),
      transaction_id: event.transaction_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", appUserId);

  if (subError) {
    console.error("[RENEWAL] subscription update error:", subError);
    throw subError;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("id", appUserId);

  if (profileError) {
    console.error("[RENEWAL] profile update error:", profileError);
    throw profileError;
  }

  console.log(`[RENEWAL] success user=${appUserId}`);
}

async function handleCancellation(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;

  console.log(`[CANCELLATION] user=${appUserId}`);

  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "cancelled",
      current_period_end: msToIso(expirationAtMs),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", appUserId);

  if (error) {
    console.error("[CANCELLATION] subscription update error:", error);
    throw error;
  }

  console.log(`[CANCELLATION] success user=${appUserId}`);
}

async function handleExpiration(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;

  console.log(`[EXPIRATION] user=${appUserId}`);

  const { error: subError } = await supabase
    .from("subscriptions")
    .update({
      status: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", appUserId);

  if (subError) {
    console.error("[EXPIRATION] subscription update error:", subError);
    throw subError;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ plan: "free", updated_at: new Date().toISOString() })
    .eq("id", appUserId);

  if (profileError) {
    console.error("[EXPIRATION] profile update error:", profileError);
    throw profileError;
  }

  console.log(`[EXPIRATION] success user=${appUserId}`);
}

async function handleBillingIssue(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;

  console.log(`[BILLING_ISSUE] user=${appUserId}`);

  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "billing_issue",
      current_period_end: msToIso(expirationAtMs),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", appUserId);

  if (error) {
    console.error("[BILLING_ISSUE] subscription update error:", error);
    throw error;
  }

  console.log(`[BILLING_ISSUE] success user=${appUserId}`);
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate Authorization header
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!REVENUECAT_WEBHOOK_SECRET) {
    console.error("REVENUECAT_WEBHOOK_SECRET is not configured");
    return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (token !== REVENUECAT_WEBHOOK_SECRET) {
    console.warn("[AUTH] Invalid webhook secret received");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (err) {
    console.error("[PARSE] Failed to parse request body:", err);
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = body.event as Record<string, unknown> | undefined;

  if (!event || typeof event !== "object") {
    console.error("[PARSE] Missing or invalid event object in payload");
    return new Response(JSON.stringify({ error: "Missing event in payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventType = event.type as string;
  const appUserId = event.app_user_id as string;

  if (!eventType || !appUserId) {
    console.error("[PARSE] Missing event.type or event.app_user_id");
    return new Response(JSON.stringify({ error: "Missing required event fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[WEBHOOK] Received event type=${eventType} user=${appUserId}`);

  try {
    switch (eventType) {
      case "INITIAL_PURCHASE":
        await handleInitialPurchase(event);
        break;
      case "RENEWAL":
        await handleRenewal(event);
        break;
      case "CANCELLATION":
        await handleCancellation(event);
        break;
      case "EXPIRATION":
        await handleExpiration(event);
        break;
      case "BILLING_ISSUE":
        await handleBillingIssue(event);
        break;
      default:
        console.log(`[WEBHOOK] Unhandled event type: ${eventType} â returning 200`);
        break;
    }
  } catch (err) {
    console.error(`[WEBHOOK] Error processing event type=${eventType} user=${appUserId}:`, err);
    return new Response(
      JSON.stringify({ error: "Internal server error while processing webhook" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify({ received: true, type: eventType }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
