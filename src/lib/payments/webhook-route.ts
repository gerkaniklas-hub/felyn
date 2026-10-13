import "server-only";
import { createPaymentsAdminClient, getServerPayments } from "./server";
import { createStripeApi } from "./stripe-api";
import { cancelAuthorization, captureAuthorizedPayment } from "./stripe-intents";
import { handleStripeWebhook, MAX_WEBHOOK_BODY_BYTES, type ApplyEventResult, type WebhookEndpoint } from "./webhook";

/**
 * Wires the real side effects into handleStripeWebhook (webhook.ts) for the two
 * route handlers. With payments off or misconfigured the endpoints don't exist (404),
 * so a stray Stripe configuration can't reach the database.
 */
export async function respondToStripeWebhook(endpoint: WebhookEndpoint, request: Request): Promise<Response> {
  const payments = getServerPayments();
  if (!payments.enabled) return new Response(null, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) return Response.json({ received: false, error: "body size" }, { status: 413 });
  // The exact bytes Stripe signed — never re-serialized JSON.
  const rawBody = new Uint8Array(await request.arrayBuffer());

  const admin = createPaymentsAdminClient();
  const stripe = createStripeApi(payments.config.secretKey);
  const secret = endpoint === "platform" ? payments.config.webhookSecret : payments.config.connectWebhookSecret;

  const result = await handleStripeWebhook(endpoint, rawBody, request.headers.get("stripe-signature"), {
    secrets: [secret],
    nowSeconds: Math.floor(Date.now() / 1000),
    applyEvent: async (ep, bodyBase64, signature) => {
      if (!admin) throw new Error("no database client");
      const { data, error } = await admin.rpc("stripe_apply_event", { p_endpoint: ep, p_body_base64: bodyBase64, p_signature: signature });
      if (error || !data || typeof data !== "object") throw new Error("stripe_apply_event failed");
      return data as ApplyEventResult;
    },
    capture: (paymentIntentId) => captureAuthorizedPayment(stripe, paymentIntentId),
    cancel: (paymentIntentId) => cancelAuthorization(stripe, paymentIntentId),
    log: (message) => console.error(message),
  });
  return Response.json(result.body, { status: result.status });
}
