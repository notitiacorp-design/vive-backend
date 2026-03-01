import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Validation des variables d'environnement au dÃ©marrage
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error("Missing required environment variable: STRIPE_WEBHOOK_SECRET");
}
if (!SUPABASE_URL) {
  throw new Error("Missing required environment variable: SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
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
      console.error("Missing timestamp or signatures in Stripe-Signature header");
      return false;
    }

    const tolerance = 300; // 5 minutes
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp, 10)) > tolerance) {
      console.error("Stripe webhook timestamp is too old or too new");
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

    console.error("No matching Stripe signature found");
    return false;
  } catch (err) {
    console.error("Error verifying Stripe signature:", err);
    return false;
  }
}

async function handlePaymentIntentSucceeded(
  supabase: ReturnType<typeof createClient>,
  paymentIntent: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    console.warn("payment_intent.succeeded: no user_id in metadata", paymentIntent.id);
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
      created_at: new Date().toISOString(),
    },
    { onConflict: "payment_intent_id", ignoreDuplicates: true }
  );

  if (error) {
    console.error("Error upserting box_order for payment_intent.succeeded:", error);
    throw new Error(`Failed to create box_order: ${error.message}`);
  }

  console.log(
    `box_order upserted successfully for user ${userId}, payment_intent ${paymentIntent.id}`
  );
}

async function handleCheckoutSessionCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (session.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    console.warn("checkout.session.completed: no user_id in metadata", session.id);
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
      created_at: new Date().toISOString(),
    },
    { onConflict: "checkout_session_id", ignoreDuplicates: true }
  );

  if (error) {
    console.error("Error upserting box_order for checkout.session.completed:", error);
    throw new Error(`Failed to create box_order: ${error.message}`);
  }

  console.log(
    `box_order upserted successfully for user ${userId}, checkout session ${session.id}`
  );
}

async function handlePaymentIntentPaymentFailed(
  supabase: ReturnType<typeof createClient>,
  paymentIntent: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id ?? null;
  const lastPaymentError = paymentIntent.last_payment_error as Record<string, unknown> | null;

  console.error("payment_intent.payment_failed:", {
    id: paymentIntent.id,
    user_id: userId ?? "unknown",
    error_code: lastPaymentError?.code,
    error_message: lastPaymentError?.message,
    error_type: lastPaymentError?.type,
  });

  const { data: existing, error: selectError } = await supabase
    .from("box_orders")
    .select("id, status")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (selectError) {
    console.error("Error querying box_order for payment_intent.payment_failed:", selectError);
    throw new Error(`Failed to query box_order: ${selectError.message}`);
  }

  if (existing) {
    const { error } = await supabase
      .from("box_orders")
      .update({
        status: "payment_failed",
        failure_reason: lastPaymentError?.message ?? "Payment failed",
        stripe_event_id: stripeEventId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("Error updating box_order status to payment_failed:", error);
      throw new Error(`Failed to update box_order: ${error.message}`);
    } else {
      console.log(`box_order ${existing.id} updated to payment_failed`);
    }
  } else {
    // Aucune commande prÃ©existante : crÃ©er un enregistrement pour conserver la trace
    console.warn(
      `No existing box_order found for failed payment_intent ${paymentIntent.id}; creating failure record`
    );

    const { error } = await supabase.from("box_orders").insert({
      user_id: userId,
      payment_intent_id: paymentIntent.id,
      stripe_event_id: stripeEventId,
      status: "payment_failed",
      failure_reason: lastPaymentError?.message ?? "Payment failed",
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      metadata: metadata,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Error inserting failure record for payment_intent.payment_failed:", error);
      throw new Error(`Failed to insert failure record: ${error.message}`);
    } else {
      console.log(
        `Failure record created for payment_intent ${paymentIntent.id}, user ${userId ?? "unknown"}`
      );
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

  console.log(`Handling subscription upsert: ${subscription.id}, customer: ${customerId}`);

  const { error } = await supabase.from("subscriptions").upsert(
    {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customerId,
      stripe_event_id: stripeEventId,
      user_id: userId,
      status: subscription.status,
      price_id: (subscription.items as Record<string, unknown> | null)
        ? ((subscription.items as Record<string, unknown>).data as Array<Record<string, unknown>>)?.[0]
            ?.price
            ? (((subscription.items as Record<string, unknown>).data as Array<Record<string, unknown>>)[0].price as Record<string, unknown>).id
            : null
        : null,
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ?? null,
      metadata: metadata,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id", ignoreDuplicates: false }
  );

  if (error) {
    console.error("Error upserting subscription:", error);
    throw new Error(`Failed to upsert subscription: ${error.message}`);
  }

  console.log(`Subscription ${subscription.id} upserted successfully`);
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof createClient>,
  subscription: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  console.log(`Handling subscription deleted: ${subscription.id}`);

  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: "canceled",
      stripe_event_id: stripeEventId,
      canceled_at: subscription.canceled_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error("Error updating subscription to canceled:", error);
    throw new Error(`Failed to update subscription to canceled: ${error.message}`);
  }

  console.log(`Subscription ${subscription.id} marked as canceled`);
}

async function handleInvoicePaymentSucceeded(
  supabase: ReturnType<typeof createClient>,
  invoice: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const customerId = invoice.customer as string | null;
  const subscriptionId = invoice.subscription as string | null;

  console.log(
    `Handling invoice.payment_succeeded: invoice ${invoice.id}, subscription ${subscriptionId}, customer ${customerId}`
  );

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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_invoice_id", ignoreDuplicates: false }
  );

  if (error) {
    console.error("Error upserting invoice for invoice.payment_succeeded:", error);
    throw new Error(`Failed to upsert invoice: ${error.message}`);
  }

  console.log(`Invoice ${invoice.id} upserted as paid`);
}

async function handleInvoicePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  invoice: Record<string, unknown>,
  stripeEventId: string
): Promise<void> {
  const customerId = invoice.customer as string | null;
  const subscriptionId = invoice.subscription as string | null;

  console.error(
    `Handling invoice.payment_failed: invoice ${invoice.id}, subscription ${subscriptionId}, customer ${customerId}`
  );

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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_invoice_id", ignoreDuplicates: false }
  );

  if (error) {
    console.error("Error upserting invoice for invoice.payment_failed:", error);
    throw new Error(`Failed to upsert invoice: ${error.message}`);
  }

  console.log(`Invoice ${invoice.id} upserted as payment_failed`);
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Limite de taille du body entrant (protection DoS)
  const MAX_BODY_SIZE = 1_048_576; // 1 MB
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    console.error(`Payload too large: ${contentLength} bytes`);
    return new Response(JSON.stringify({ error: "Payload too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("Failed to read request body:", err);
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // VÃ©rification de taille aprÃ¨s lecture rÃ©elle (dÃ©fense en profondeur)
  if (rawBody.length > MAX_BODY_SIZE) {
    console.error(`Payload too large after read: ${rawBody.length} bytes`);
    return new Response(JSON.stringify({ error: "Payload too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripeSignature = req.headers.get("stripe-signature");
  if (!stripeSignature) {
    console.error("Missing Stripe-Signature header");
    return new Response(JSON.stringify({ error: "Missing Stripe-Signature header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // STRIPE_WEBHOOK_SECRET est garanti non-null grÃ¢ce Ã  la validation au dÃ©marrage
  const isValid = await verifyStripeSignature(rawBody, stripeSignature, STRIPE_WEBHOOK_SECRET!);
  if (!isValid) {
    console.error("Stripe webhook signature verification failed");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    console.error("Failed to parse webhook payload as JSON:", err);
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
  const eventData = event.data as Record<string, unknown>;
  const eventObject = eventData?.object as Record<string, unknown>;

  console.log(`Processing Stripe event: ${eventType} (id: ${eventId})`);

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
        console.log(`Unhandled event type: ${eventType}`);
        break;
    }
  } catch (err) {
    console.error(`Error processing event ${eventType} (id: ${eventId}):`, err);
    return new Response(
      JSON.stringify({ error: "Internal server error while processing event" }),
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
