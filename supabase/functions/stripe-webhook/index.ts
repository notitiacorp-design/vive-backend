import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
      const [key, value] = part.split("=");
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
    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    for (const sig of signatures) {
      if (sig === computedSignature) {
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
  paymentIntent: Record<string, unknown>
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    console.warn("payment_intent.succeeded: no user_id in metadata", paymentIntent.id);
    return;
  }

  const { error } = await supabase.from("box_orders").insert({
    user_id: userId,
    payment_intent_id: paymentIntent.id,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: "paid",
    metadata: metadata,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error("Error inserting box_order for payment_intent.succeeded:", error);
    throw new Error(`Failed to create box_order: ${error.message}`);
  }

  console.log(
    `box_order created successfully for user ${userId}, payment_intent ${paymentIntent.id}`
  );
}

async function handleCheckoutSessionCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Record<string, unknown>
): Promise<void> {
  const metadata = (session.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;

  if (!userId) {
    console.warn("checkout.session.completed: no user_id in metadata", session.id);
    return;
  }

  const existingPaymentIntentId = session.payment_intent as string | null;

  if (existingPaymentIntentId) {
    const { data: existing } = await supabase
      .from("box_orders")
      .select("id")
      .eq("payment_intent_id", existingPaymentIntentId)
      .maybeSingle();

    if (existing) {
      console.log(
        `box_order already exists for payment_intent ${existingPaymentIntentId}, skipping duplicate insert`
      );
      return;
    }
  }

  const { error } = await supabase.from("box_orders").insert({
    user_id: userId,
    payment_intent_id: existingPaymentIntentId ?? null,
    checkout_session_id: session.id,
    amount: session.amount_total,
    currency: session.currency,
    status: "paid",
    metadata: metadata,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error("Error inserting box_order for checkout.session.completed:", error);
    throw new Error(`Failed to create box_order: ${error.message}`);
  }

  console.log(
    `box_order created successfully for user ${userId}, checkout session ${session.id}`
  );
}

async function handlePaymentIntentPaymentFailed(
  supabase: ReturnType<typeof createClient>,
  paymentIntent: Record<string, unknown>
): Promise<void> {
  const metadata = (paymentIntent.metadata as Record<string, string>) ?? {};
  const userId = metadata.user_id;
  const lastPaymentError = paymentIntent.last_payment_error as Record<string, unknown> | null;

  console.error("payment_intent.payment_failed:", {
    id: paymentIntent.id,
    user_id: userId ?? "unknown",
    error_code: lastPaymentError?.code,
    error_message: lastPaymentError?.message,
    error_type: lastPaymentError?.type,
  });

  const { data: existing } = await supabase
    .from("box_orders")
    .select("id, status")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("box_orders")
      .update({
        status: "payment_failed",
        failure_reason: lastPaymentError?.message ?? "Payment failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("Error updating box_order status to payment_failed:", error);
    } else {
      console.log(`box_order ${existing.id} updated to payment_failed`);
    }
  } else {
    console.warn(
      `No existing box_order found for failed payment_intent ${paymentIntent.id}; no record updated`
    );
  }
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
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

  const stripeSignature = req.headers.get("stripe-signature");
  if (!stripeSignature) {
    console.error("Missing Stripe-Signature header");
    return new Response(JSON.stringify({ error: "Missing Stripe-Signature header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const isValid = await verifyStripeSignature(rawBody, stripeSignature, STRIPE_WEBHOOK_SECRET);
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const eventType = event.type as string;
  const eventData = event.data as Record<string, unknown>;
  const eventObject = eventData?.object as Record<string, unknown>;

  console.log(`Processing Stripe event: ${eventType} (id: ${event.id})`);

  try {
    switch (eventType) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(supabase, eventObject);
        break;

      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(supabase, eventObject);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentIntentPaymentFailed(supabase, eventObject);
        break;

      default:
        console.log(`Unhandled event type: ${eventType}`);
        break;
    }
  } catch (err) {
    console.error(`Error processing event ${eventType}:`, err);
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
