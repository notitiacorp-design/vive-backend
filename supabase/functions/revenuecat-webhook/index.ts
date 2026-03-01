import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { timingSafeEqual } from "https://deno.land/std@0.168.0/crypto/timing_safe_equal.ts";

// ---------------------------------------------------------------------------
// Environment variables - fail fast at boot if any are missing
// ---------------------------------------------------------------------------
const REVENUECAT_WEBHOOK_SECRET = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || typeof SUPABASE_URL !== "string" || SUPABASE_URL.trim() === "") {
  throw new Error(
    "Missing or empty required environment variable: SUPABASE_URL"
  );
}
if (!SUPABASE_SERVICE_ROLE_KEY || typeof SUPABASE_SERVICE_ROLE_KEY !== "string" || SUPABASE_SERVICE_ROLE_KEY.trim() === "") {
  throw new Error(
    "Missing or empty required environment variable: SUPABASE_SERVICE_ROLE_KEY"
  );
}
if (!REVENUECAT_WEBHOOK_SECRET || typeof REVENUECAT_WEBHOOK_SECRET !== "string" || REVENUECAT_WEBHOOK_SECRET.trim() === "") {
  throw new Error(
    "Missing or empty required environment variable: REVENUECAT_WEBHOOK_SECRET"
  );
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: {
    fetch: (input, init) => fetch(input, init),
  },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DB_TIMEOUT_MS = 8_000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timing-safe comparison of two strings. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

/**
 * Verify HMAC-SHA256 signature.
 * RevenueCat signs the raw body with the webhook secret using HMAC-SHA256
 * and sends the hex digest in the X-RevenueCat-Signature header.
 */
async function verifyHmacSignature(
  secret: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      keyMaterial,
      enc.encode(rawBody)
    );
    const expectedHex = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // timing-safe compare
    const expectedBytes = enc.encode(expectedHex);
    const receivedBytes = enc.encode(signature);
    if (expectedBytes.length !== receivedBytes.length) return false;
    return timingSafeEqual(expectedBytes, receivedBytes);
  } catch (err) {
    console.error("[AUTH] HMAC verification error:", err);
    return false;
  }
}

/**
 * Wraps a promise with a hard timeout.
 * Throws a DOMException with name 'AbortError' if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(`DB operation timed out after ${ms}ms`, "AbortError")),
      ms
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function mapProductIdToPlan(productId: string): string {
  if (productId.includes("vive_essential")) return "essential";
  if (productId.includes("vive_premium")) return "premium";
  return "free";
}

function msToIso(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// NOTE ON ATOMICITY:
// Supabase/PostgREST does not support multi-table transactions via the JS client.
// Operations on `subscriptions` and `profiles` are sequential and not atomic.
// If the subscriptions update succeeds but profiles fails, we log the error
// and re-throw so the webhook returns 500 and RevenueCat can retry.
// The retry will re-apply both operations idempotently (upsert semantics).
// For true atomicity, a PostgreSQL RPC wrapping both UPDATEs would be required.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleInitialPurchase(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const productId = event.product_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;
  const plan = mapProductIdToPlan(productId);
  const expiresAt = msToIso(expirationAtMs);
  const purchasedAt =
    msToIso(event.purchased_at_ms as number) ?? new Date().toISOString();

  console.log(
    `[INITIAL_PURCHASE] product=${productId} plan=${plan}`
  );

  const { error: subError } = await withTimeout(
    supabase.from("subscriptions").upsert(
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
    ),
    DB_TIMEOUT_MS
  );

  if (subError) {
    console.error("[INITIAL_PURCHASE] subscription upsert error:", subError);
    throw subError;
  }

  const { error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .update({ plan, updated_at: new Date().toISOString() })
      .eq("id", appUserId),
    DB_TIMEOUT_MS
  );

  if (profileError) {
    console.error(
      "[INITIAL_PURCHASE] profile update error (subscription already updated, retry will re-apply both):",
      profileError
    );
    throw profileError;
  }

  console.log(`[INITIAL_PURCHASE] success`);
}

async function handleRenewal(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;
  const productId = event.product_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;
  const purchasedAt =
    msToIso(event.purchased_at_ms as number) ?? new Date().toISOString();
  const plan = mapProductIdToPlan(productId);

  console.log(`[RENEWAL] product=${productId}`);

  const subscriptionPayload = {
    user_id: appUserId,
    product_id: productId,
    plan,
    status: "active",
    current_period_start: purchasedAt,
    current_period_end: msToIso(expirationAtMs),
    transaction_id: event.transaction_id ?? null,
    updated_at: new Date().toISOString(),
  };

  // Attempt update first; fall back to upsert if no row exists.
  const { error: subError, data: updatedRows } = await withTimeout(
    supabase
      .from("subscriptions")
      .update(subscriptionPayload)
      .eq("user_id", appUserId)
      .select("user_id"),
    DB_TIMEOUT_MS
  );

  if (subError) {
    console.error("[RENEWAL] subscription update error:", subError);
    throw subError;
  }

  if (!updatedRows || updatedRows.length === 0) {
    console.warn(
      `[RENEWAL] No subscription found for user=[REDACTED], falling back to upsert`
    );
    const { error: upsertError } = await withTimeout(
      supabase
        .from("subscriptions")
        .upsert(subscriptionPayload, { onConflict: "user_id" }),
      DB_TIMEOUT_MS
    );
    if (upsertError) {
      console.error("[RENEWAL] subscription upsert fallback error:", upsertError);
      throw upsertError;
    }
  }

  const { error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .update({ plan, updated_at: new Date().toISOString() })
      .eq("id", appUserId),
    DB_TIMEOUT_MS
  );

  if (profileError) {
    console.error(
      "[RENEWAL] profile update error (subscription already updated, retry will re-apply both):",
      profileError
    );
    throw profileError;
  }

  console.log(`[RENEWAL] success`);
}

async function handleCancellation(
  event: Record<string, unknown>
): Promise<void> {
  const appUserId = event.app_user_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;

  console.log(`[CANCELLATION] processing`);

  const { error } = await withTimeout(
    supabase
      .from("subscriptions")
      .update({
        status: "cancelled",
        current_period_end: msToIso(expirationAtMs),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", appUserId),
    DB_TIMEOUT_MS
  );

  if (error) {
    console.error("[CANCELLATION] subscription update error:", error);
    throw error;
  }

  console.log(`[CANCELLATION] success`);
}

async function handleUncancellation(
  event: Record<string, unknown>
): Promise<void> {
  const appUserId = event.app_user_id as string;
  const productId = event.product_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;
  const plan = mapProductIdToPlan(productId);

  console.log(`[UNCANCELLATION] processing`);

  const { error: subError } = await withTimeout(
    supabase
      .from("subscriptions")
      .update({
        status: "active",
        plan,
        current_period_end: msToIso(expirationAtMs),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", appUserId),
    DB_TIMEOUT_MS
  );

  if (subError) {
    console.error("[UNCANCELLATION] subscription update error:", subError);
    throw subError;
  }

  const { error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .update({ plan, updated_at: new Date().toISOString() })
      .eq("id", appUserId),
    DB_TIMEOUT_MS
  );

  if (profileError) {
    console.error(
      "[UNCANCELLATION] profile update error (subscription already updated, retry will re-apply both):",
      profileError
    );
    throw profileError;
  }

  console.log(`[UNCANCELLATION] success`);
}

async function handleExpiration(event: Record<string, unknown>): Promise<void> {
  const appUserId = event.app_user_id as string;

  console.log(`[EXPIRATION] processing`);

  const { error: subError } = await withTimeout(
    supabase
      .from("subscriptions")
      .update({
        status: "expired",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", appUserId),
    DB_TIMEOUT_MS
  );

  if (subError) {
    console.error("[EXPIRATION] subscription update error:", subError);
    throw subError;
  }

  const { error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .update({ plan: "free", updated_at: new Date().toISOString() })
      .eq("id", appUserId),
    DB_TIMEOUT_MS
  );

  if (profileError) {
    console.error(
      "[EXPIRATION] profile update error (subscription already updated, retry will re-apply both):",
      profileError
    );
    throw profileError;
  }

  console.log(`[EXPIRATION] success`);
}

async function handleBillingIssue(
  event: Record<string, unknown>
): Promise<void> {
  const appUserId = event.app_user_id as string;
  const expirationAtMs = event.expiration_at_ms as number | null;

  console.log(`[BILLING_ISSUE] processing`);

  const { error } = await withTimeout(
    supabase
      .from("subscriptions")
      .update({
        status: "billing_issue",
        current_period_end: msToIso(expirationAtMs),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", appUserId),
    DB_TIMEOUT_MS
  );

  if (error) {
    console.error("[BILLING_ISSUE] subscription update error:", error);
    throw error;
  }

  console.log(`[BILLING_ISSUE] success`);
}

async function handleProductChange(
  event: Record<string, unknown>
): Promise<void> {
  const appUserId = event.app_user_id as string;
  // RevenueCat sends new_product_id for the product being changed to.
  const newProductId =
    (event.new_product_id as string | undefined) ??
    (event.product_id as string);
  const expirationAtMs = event.expiration_at_ms as number | null;
  const purchasedAt =
    msToIso(event.purchased_at_ms as number) ?? new Date().toISOString();
  const plan = mapProductIdToPlan(newProductId);

  console.log(
    `[PRODUCT_CHANGE] new_product=${newProductId} plan=${plan}`
  );

  const subscriptionPayload = {
    user_id: appUserId,
    product_id: newProductId,
    plan,
    status: "active",
    current_period_start: purchasedAt,
    current_period_end: msToIso(expirationAtMs),
    transaction_id: event.transaction_id ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error: subError, data: updatedRows } = await withTimeout(
    supabase
      .from("subscriptions")
      .update(subscriptionPayload)
      .eq("user_id", appUserId)
      .select("user_id"),
    DB_TIMEOUT_MS
  );

  if (subError) {
    console.error("[PRODUCT_CHANGE] subscription update error:", subError);
    throw subError;
  }

  if (!updatedRows || updatedRows.length === 0) {
    console.warn(
      `[PRODUCT_CHANGE] No subscription found for user=[REDACTED], falling back to upsert`
    );
    const { error: upsertError } = await withTimeout(
      supabase
        .from("subscriptions")
        .upsert(subscriptionPayload, { onConflict: "user_id" }),
      DB_TIMEOUT_MS
    );
    if (upsertError) {
      console.error(
        "[PRODUCT_CHANGE] subscription upsert fallback error:",
        upsertError
      );
      throw upsertError;
    }
  }

  const { error: profileError } = await withTimeout(
    supabase
      .from("profiles")
      .update({ plan, updated_at: new Date().toISOString() })
      .eq("id", appUserId),
    DB_TIMEOUT_MS
  );

  if (profileError) {
    console.error(
      "[PRODUCT_CHANGE] profile update error (subscription already updated, retry will re-apply both):",
      profileError
    );
    throw profileError;
  }

  console.log(`[PRODUCT_CHANGE] success`);
}

async function handleTransfer(event: Record<string, unknown>): Promise<void> {
  // RevenueCat TRANSFER event moves a subscription from one user to another.
  // Payload contains transferred_from (array) and transferred_to (array).
  const transferredFrom = event.transferred_from as string[] | undefined;
  const transferredTo = event.transferred_to as string[] | undefined;

  // Extract product/plan info for the target user if available.
  const productId = (event.product_id as string | undefined) ?? "";
  const plan = productId ? mapProductIdToPlan(productId) : "essential"; // default to non-free on transfer
  const expirationAtMs = event.expiration_at_ms as number | null | undefined;
  const purchasedAt =
    msToIso(event.purchased_at_ms as number | undefined) ?? new Date().toISOString();

  console.log(
    `[TRANSFER] processing transfer event`
  );

  // Mark source users' subscriptions as transferred and reset their plan to free.
  if (transferredFrom && transferredFrom.length > 0) {
    for (const fromUserId of transferredFrom) {
      if (!UUID_REGEX.test(fromUserId)) {
        console.warn(`[TRANSFER] Skipping invalid from user_id: [REDACTED]`);
        continue;
      }
      const { error } = await withTimeout(
        supabase
          .from("subscriptions")
          .update({
            status: "transferred",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", fromUserId),
        DB_TIMEOUT_MS
      );
      if (error) {
        console.error(
          `[TRANSFER] subscription update error for from_user=[REDACTED]:`,
          error
        );
        throw error;
      }

      const { error: profileError } = await withTimeout(
        supabase
          .from("profiles")
          .update({ plan: "free", updated_at: new Date().toISOString() })
          .eq("id", fromUserId),
        DB_TIMEOUT_MS
      );
      if (profileError) {
        console.error(
          `[TRANSFER] profile update error for from_user=[REDACTED]:`,
          profileError
        );
        throw profileError;
      }
    }
  }

  // Assign subscription to target users.
  if (transferredTo && transferredTo.length > 0) {
    for (const toUserId of transferredTo) {
      if (!UUID_REGEX.test(toUserId)) {
        console.warn(`[TRANSFER] Skipping invalid to user_id: [REDACTED]`);
        continue;
      }

      const subscriptionPayload = {
        user_id: toUserId,
        product_id: productId || null,
        plan,
        status: "active",
        current_period_start: purchasedAt,
        current_period_end: msToIso(expirationAtMs),
        transaction_id: (event.transaction_id as string | undefined) ?? null,
        original_transaction_id: (event.original_transaction_id as string | undefined) ?? null,
        store: (event.store as string | undefined) ?? null,
        updated_at: new Date().toISOString(),
      };

      const { error: subError } = await withTimeout(
        supabase
          .from("subscriptions")
          .upsert(subscriptionPayload, { onConflict: "user_id" }),
        DB_TIMEOUT_MS
      );
      if (subError) {
        console.error(
          `[TRANSFER] subscription upsert error for to_user=[REDACTED]:`,
          subError
        );
        throw subError;
      }

      const { error: profileError } = await withTimeout(
        supabase
          .from("profiles")
          .update({ plan, updated_at: new Date().toISOString() })
          .eq("id", toUserId),
        DB_TIMEOUT_MS
      );
      if (profileError) {
        console.error(
          `[TRANSFER] profile update error for to_user=[REDACTED] (subscription already upserted, retry will re-apply both):`,
          profileError
        );
        throw profileError;
      }

      console.log(`[TRANSFER] subscription assigned plan=${plan}`);
    }
  }

  console.log(`[TRANSFER] success`);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Read raw body once so we can both verify the HMAC and parse JSON.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[PARSE] Failed to read request body:", err);
    return new Response(JSON.stringify({ error: "Failed to read body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---------------------------------------------------------------------------
  // Authentication: prefer HMAC-SHA256 signature, fall back to Bearer token.
  //
  // RevenueCat sends the HMAC-SHA256 hex digest of the raw body signed with
  // the webhook secret in the "X-RevenueCat-Signature" header.
  // If that header is present we validate the body integrity via HMAC.
  // Otherwise we fall back to timing-safe comparison of the Bearer token
  // (backward-compatible with simpler RevenueCat webhook configurations).
  // ---------------------------------------------------------------------------
  const rcSignature = req.headers.get("X-RevenueCat-Signature");

  if (rcSignature) {
    const valid = await verifyHmacSignature(
      REVENUECAT_WEBHOOK_SECRET,
      rawBody,
      rcSignature
    );
    if (!valid) {
      console.warn("[AUTH] Invalid HMAC-SHA256 signature");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    // Fall back to Bearer token validation.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (!timingSafeStringEqual(token, REVENUECAT_WEBHOOK_SECRET)) {
      console.warn("[AUTH] Invalid webhook secret received");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    console.error("[PARSE] Failed to parse request body as JSON:", err);
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
    return new Response(
      JSON.stringify({ error: "Missing required event fields" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Validate UUID format for app_user_id (TRANSFER events handle their own arrays separately).
  if (eventType !== "TRANSFER" && !UUID_REGEX.test(appUserId)) {
    console.error(`[PARSE] Invalid app_user_id format: [REDACTED]`);
    return new Response(
      JSON.stringify({ error: "Invalid app_user_id format" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(
    `[WEBHOOK] Received event type=${eventType}`
  );

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
      case "UNCANCELLATION":
        await handleUncancellation(event);
        break;
      case "EXPIRATION":
        await handleExpiration(event);
        break;
      case "BILLING_ISSUE":
        await handleBillingIssue(event);
        break;
      case "PRODUCT_CHANGE":
        await handleProductChange(event);
        break;
      case "TRANSFER":
        await handleTransfer(event);
        break;
      case "SUBSCRIBER_ALIAS":
        console.log(
          "[WEBHOOK] SUBSCRIBER_ALIAS event received, no action required"
        );
        break;
      default:
        console.log(
          `[WEBHOOK] Unhandled event type: ${eventType} - returning 200`
        );
        break;
    }
  } catch (err) {
    console.error(
      `[WEBHOOK] Error processing event type=${eventType}:`,
      err
    );
    return new Response(
      JSON.stringify({
        error: "Internal server error while processing webhook",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Return minimal response - do not expose internal event details
  return new Response(
    JSON.stringify({ received: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
