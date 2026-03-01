import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.1";

// Validation des variables d'environnement au dÃ©marrage
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error("Missing required environment variable: STRIPE_WEBHOOK_SECRET");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
}

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/**
 * Extracts price_id from subscription items safely.
 */
function extractPriceId(subscription: Record<string, unknown>): string | null {
  try {
    const items = subscription.items as Record<string, unknown> | null;
    if (!items) return null;
    const data = items.data as Array<Record<string, unknown>> | null;
    if (!Array.isArray(data) || data.length === 0) return null;
    const firstItem = data[0];
    if (!firstItem) return null;
    const price = firstItem.price as Record<string, unknown> | null;
    if (!price) return null;
    return (price.id as string) ?? null;
  } catch {
    return null;
  }
}

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  try {
    const parts = sigHeader.split(",");
    let timestamp = "";
    const signatures: string[] = [];

    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const key = part.slice(0, eqIdx);
      const value = part.slice(eqIdx + 1);
      if (key === "t") {
        timestamp = value;
      } else if (key === "v1") {
        signatures.push(value);
      }
    }

    if (!timestamp || signatures.length === 0) {
      log("error", "Missing timestamp or signatures in Stripe-Signature header");
      return false;
    }

    const tolerance = 300; // 5 minutes
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp, 10)) > tolerance) {
      log("error", "Stripe webhook timestamp is too old or too new");
      return false;
    }

    const signedPayload = `${timestamp}.${payload}`;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(signedPayload);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
    const computedBytes = new Uint8Array(signatureBuffer);

    // Comparaison timing-safe via XOR sur les buffers
    for (const sig of signatures) {
      // DÃ©coder la signature hex en bytes
      const hexPairs = sig.match(/.{2}/g);
      if (!hexPairs) continue;
      const sigBytes = new Uint8Array(hexPairs.map((b) => parseInt(b, 16)));

      if (sigBytes.length !== computedBytes.length) continue;

      // XOR en temps constant : accumule tous les octets diffÃ©rents
      let diff = 0;
      for (let i = 0; i < computedBytes.length; i++) {
        diff |= sigBytes[i] ^ computedBytes[i];
      }

      if (diff === 0) {
        return true;
      }
    }

    log("error", "No matching Stripe signature found");
    return false;
  } catch (err) {
    log("error", "Error verifying Stripe signature", { err: String(err) });
    return false;
  }
}

/**
 * Acquires an idempotency lock on the stripe event id in the processed_stripe_events table.
 * Returns true if this process should handle the event, false if already handled.
 */
async function acquireEventLock(
  supabase: ReturnType<typeof createClient>,
  stripeEventId: string,
  eventType: string
): Promise<boolean> {
  // Attempt to insert into a processed_stripe_events table.
  // The table should have a UNIQUE constraint on stripe_event_id.
  const { error } = await supabase.from("processed_stripe_events").insert({
    stripe_event_id: stripeEventId,
    event_type: eventType,
  });

  if (error) {
    if (error.code === "23505") {
      // Unique violation â already processed
      log("info", "Duplicate Stripe event detected, skipping", { event_type: eventType });
      return false;
    }
    // Unexpected error â rethrow
    throw new Error(`Failed to acquire event lock: ${error.message}`);
  }

  return true;
}

async function handlePaymentIntentSucceeded(
  supabase: ReturnType<typeof createClient>,
  paymentIntent: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    log("warn", "payment_intent.succeeded: no user_id in metadata");
    return;
  }

  if (!isValidUUID(userId)) {
    log("warn", "payment_intent.succeeded: invalid user_id format in metadata");
    return;
  }

  const { error } = await supabase.from("box_orders").upsert(
    {
      user_id: userId,
      payment_intent_id: paymentIntent.id,
      stripe_event_id: stripeEventId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: "paid",
      metadata: metadata,
    },
    { onConflict: "payment_intent_id", ignoreDuplicates: true }
  );

  if (error) {
    log("error", "Error upserting box_order for payment_intent.succeeded", { code: error.code });
    throw new Error("Failed to create box_order");
  }

  log("info", "box_order upserted successfully for payment_intent.succeeded");
}

async function handleCheckoutSessionCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (session.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    log("warn", "checkout.session.completed: no user_id in metadata");
    return;
  }

  if (!isValidUUID(userId)) {
    log("warn", "checkout.session.completed: invalid user_id format in metadata");
    return;
  }

  const paymentIntentId = (session.payment_intent as string | null) ?? null;

  // Idempotence atomique via contrainte UNIQUE sur checkout_session_id
  const { error } = await supabase.from("box_orders").upsert(
    {
      user_id: userId,
      payment_intent_id: paymentIntentId,
      checkout_session_id: session.id,
      stripe_event_id: stripeEventId,
      amount: session.amount_total,
      currency: session.currency,
      status: "paid",
      metadata: metadata,
    },
    { onConflict: "checkout_session_id", ignoreDuplicates: true }
  );

  if (error) {
    log("error", "Error upserting box_order for checkout.session.completed", { code: error.code });
    throw new Error("Failed to create box_order");
  }

  log("info", "box_order upserted successfully for checkout.session.completed");
}

async function handlePaymentIntentPaymentFailed(
  supabase: ReturnType<typeof createClient>,
  paymentIntent: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id ?? null;
  const lastPaymentError = paymentIntent.last_payment_error as Record<string, unknown> | null;

  log("error", "payment_intent.payment_failed", {
    error_code: lastPaymentError?.code as string | undefined,
    error_type: lastPaymentError?.type as string | undefined,
  });

  const { data: existing, error: selectError } = await supabase
    .from("box_orders")
    .select("id, status")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (selectError) {
    log("error", "Error querying box_order for payment_intent.payment_failed", { code: selectError.code });
    throw new Error("Failed to query box_order");
  }

  if (existing) {
    const { error } = await supabase
      .from("box_orders")
      .update({
        status: "payment_failed",
        failure_reason: lastPaymentError?.message ?? "Payment failed",
        stripe_event_id: stripeEventId,
      })
      .eq("id", existing.id);

    if (error) {
      log("error", "Error updating box_order status to payment_failed", { code: error.code });
      throw new Error("Failed to update box_order");
    } else {
      log("info", "box_order updated to payment_failed");
    }
  } else {
    // Aucune commande prÃ©existante : crÃ©er un enregistrement pour conserver la trace
    log("warn", "No existing box_order found for failed payment_intent; creating failure record");

    const validatedUserId = userId && isValidUUID(userId) ? userId : null;

    const { error } = await supabase.from("box_orders").insert({
      user_id: validatedUserId,
      payment_intent_id: paymentIntent.id,
      stripe_event_id: stripeEventId,
      status: "payment_failed",
      failure_reason: lastPaymentError?.message ?? "Payment failed",
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      metadata: metadata,
    });

    if (error) {
      log("error", "Error inserting failure record for payment_intent.payment_failed", { code: error.code });
      throw new Error("Failed to insert failure record");
    } else {
      log("info", "Failure record created for payment_intent.payment_failed");
    }
  }
}

async function handleSubscriptionUpsert(
  supabase: ReturnType<typeof createClient>,
  subscription: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (subscription.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id ?? null;
  const customerId = subscription.customer as string | null;

  log("info", "Handling subscription upsert");

  const validatedUserId = userId && isValidUUID(userId) ? userId : null;
  if (userId && !validatedUserId) {
    log("warn", "subscription upsert: invalid user_id format in metadata, storing as null");
  }

  const { error } = await supabase.from("subscriptions").upsert(
    {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customerId,
      stripe_event_id: stripeEventId,
      user_id: validatedUserId,
      status: subscription.status,
      price_id: extractPriceId(subscription),
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ?? null,
      metadata: metadata,
    },
    { onConflict: "stripe_subscription_id", ignoreDuplicates: false }
  );

  if (error) {
    log("error", "Error upserting subscription", { code: error.code });
    throw new Error("Failed to upsert subscription");
  }

  log("info", "Subscription upserted successfully");
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof createClient>,
  subscription: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  log("info", "Handling subscription deleted");

  // Verify that a matching subscription exists before updating
  const { data: existing, error: selectError } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();

  if (selectError) {
    log("error", "Error querying subscription for deletion", { code: selectError.code });
    throw new Error("Failed to query subscription");
  }

  if (!existing) {
    log("warn", "handleSubscriptionDeleted: no matching subscription found, skipping update");
    return;
  }

  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "canceled",
      stripe_event_id: stripeEventId,
      canceled_at: subscription.canceled_at ?? null,
    })
    .eq("id", existing.id);

  if (error) {
    log("error", "Error updating subscription to canceled", { code: error.code });
    throw new Error("Failed to update subscription to canceled");
  }

  log("info", "Subscription marked as canceled");
}

async function handleInvoicePaymentSucceeded(
  supabase: ReturnType<typeof createClient>,
  invoice: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const customerId = invoice.customer as string | null;
  const subscriptionId = invoice.subscription as string | null;

  log("info", "Handling invoice.payment_succeeded");

  const { error } = await supabase.from("invoices").upsert(
    {
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId,
      stripe_event_id: stripeEventId,
      status: "paid",
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
    },
    { onConflict: "stripe_invoice_id", ignoreDuplicates: false }
  );

  if (error) {
    log("error", "Error upserting invoice for invoice.payment_succeeded", { code: error.code });
    throw new Error("Failed to upsert invoice");
  }

  log("info", "Invoice upserted as paid");
}

async function handleInvoicePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  invoice: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const customerId = invoice.customer as string | null;
  const subscriptionId = invoice.subscription as string | null;

  log("error", "Handling invoice.payment_failed");

  const { error } = await supabase.from("invoices").upsert(
    {
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId,
      stripe_event_id: stripeEventId,
      status: "payment_failed",
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
    },
    { onConflict: "stripe_invoice_id", ignoreDuplicates: false }
  );

  if (error) {
    log("error", "Error upserting invoice for invoice.payment_failed", { code: error.code });
    throw new Error("Failed to upsert invoice");
  }

  log("info", "Invoice upserted as payment_failed");
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Limite de taille du body entrant (protection DoS)
  // Note: Content-Length check is informational only; chunked transfers may omit it.
  // The authoritative size check is performed after reading the full body.
  const MAX_BODY_SIZE = 1_048_576; // 1 MB
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    log("error", "Payload too large (Content-Length header)", { bytes: parseInt(contentLength, 10) });
    return new Response(JSON.stringify({ error: "Payload too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  let rawBody: string;
  try {
    // Read with a size cap to handle chunked transfer encoding (no Content-Length)
    const reader = req.body?.getReader();
    if (!reader) {
      return new Response(JSON.stringify({ error: "Failed to read request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_SIZE) {
          log("error", "Payload too large during streaming read", { bytes: totalBytes });
          return new Response(JSON.stringify({ error: "Payload too large" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }
        chunks.push(value);
      }
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rawBody = new TextDecoder().decode(combined);
  } catch (err) {
    log("error", "Failed to read request body", { err: String(err) });
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripeSignature = req.headers.get("stripe-signature");
  if (!stripeSignature) {
    log("error", "Missing Stripe-Signature header");
    return new Response(JSON.stringify({ error: "Missing Stripe-Signature header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // STRIPE_WEBHOOK_SECRET est garanti non-null grÃ¢ce Ã  la validation au dÃ©marrage
  const isValid = await verifyStripeSignature(rawBody, stripeSignature, STRIPE_WEBHOOK_SECRET!);
  if (!isValid) {
    log("error", "Stripe webhook signature verification failed");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    log("error", "Failed to parse webhook payload as JSON", { err: String(err) });
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const eventType = event.type as string;
  const eventId = event.id as string;

  // Validate that eventData and eventObject are present before processing
  const eventData = event.data as Record<string, unknown> | null | undefined;
  if (!eventData || typeof eventData !== "object") {
    log("error", "Malformed event: missing or invalid data field", { event_type: eventType });
    return new Response(JSON.stringify({ error: "Malformed event payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventObject = eventData.object as Record<string, unknown> | null | undefined;
  if (!eventObject || typeof eventObject !== "object") {
    log("error", "Malformed event: missing or invalid data.object field", { event_type: eventType });
    return new Response(JSON.stringify({ error: "Malformed event payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  log("info", "Processing Stripe event", { event_type: eventType });

  // Event-level idempotency: acquire a lock before processing
  // This prevents duplicate processing even under concurrent deliveries.
  let acquired: boolean;
  try {
    acquired = await acquireEventLock(supabase, eventId, eventType);
  } catch (err) {
    log("error", "Failed to acquire event lock", { err: String(err), event_type: eventType });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!acquired) {
    // Already processed â return 200 to prevent Stripe from retrying
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    switch (eventType) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(supabase, eventObject, eventId);
        break;

      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(supabase, eventObject, eventId);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentIntentPaymentFailed(supabase, eventObject, eventId);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(supabase, eventObject, eventId);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabase, eventObject, eventId);
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(supabase, eventObject, eventId);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(supabase, eventObject, eventId);
        break;

      default:
        // Log unknown event types for observability/alerting
        log("warn", "Unhandled Stripe event type â consider adding a handler or monitoring sink", {
          event_type: eventType,
          event_id: eventId,
        });
        break;
    }
  } catch (err) {
    log("error", "Error processing Stripe event", { event_type: eventType, err: String(err) });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
