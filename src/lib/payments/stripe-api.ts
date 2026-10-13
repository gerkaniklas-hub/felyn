import "server-only";
import { encodeStripeForm } from "./checkout";

/**
 * The few Stripe API calls Felyn makes, over plain fetch (no SDK dependency).
 * Server-only: the secret key never reaches the browser. Every write uses an
 * idempotency key derived from Felyn's own ids, so a retry can never create a
 * second session, account, capture or cancellation. No call here creates a
 * transfer, a payout or a refund — there is deliberately no such function.
 *
 * Requests use the Stripe account's default API version. Only long-stable fields
 * are read (id, url, status, latest_charge).
 */
const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 15_000;

export type StripeResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null; type: string | null };

type StripeObject = Record<string, unknown>;

async function stripeRequest(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> | null,
  idempotencyKey: string | null,
): Promise<StripeResult<StripeObject>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers,
      body: method === "POST" ? encodeStripeForm(params ?? {}) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, code: "network_error", type: null };
  }
  let json: StripeObject = {};
  try {
    json = (await response.json()) as StripeObject;
  } catch {
    // Non-JSON body: treated as an error below.
  }
  if (!response.ok) {
    const error = (json.error ?? {}) as { code?: unknown; type?: unknown };
    return {
      ok: false,
      status: response.status,
      code: typeof error.code === "string" ? error.code : null,
      type: typeof error.type === "string" ? error.type : null,
    };
  }
  return { ok: true, data: json };
}

export function createStripeApi(secretKey: string) {
  return {
    createCheckoutSession: (params: Record<string, string>, paymentId: string) =>
      stripeRequest(secretKey, "POST", "/checkout/sessions", params, `felyn-checkout-${paymentId}`),
    retrieveCheckoutSession: (sessionId: string) =>
      stripeRequest(secretKey, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, null, null),
    expireCheckoutSession: (sessionId: string) =>
      stripeRequest(secretKey, "POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, `felyn-expire-${sessionId}`),
    retrievePaymentIntent: (paymentIntentId: string) =>
      stripeRequest(secretKey, "GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}`, null, null),
    capturePaymentIntent: (paymentIntentId: string) =>
      stripeRequest(secretKey, "POST", `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, {}, `felyn-capture-${paymentIntentId}`),
    cancelPaymentIntent: (paymentIntentId: string) =>
      stripeRequest(secretKey, "POST", `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, { cancellation_reason: "abandoned" }, `felyn-cancel-${paymentIntentId}`),
    createExpressAccount: (params: Record<string, string>, providerId: string) =>
      stripeRequest(secretKey, "POST", "/accounts", params, `felyn-account-${providerId}`),
    createAccountLink: (params: Record<string, string>) => stripeRequest(secretKey, "POST", "/account_links", params, null),
  };
}

export type StripeApi = ReturnType<typeof createStripeApi>;

// Capture and cancel decisions live in ./stripe-intents.ts (pure, unit-tested).
