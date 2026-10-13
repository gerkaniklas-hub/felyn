import "server-only";
import { encodeStripeForm, type StripeJsonBody } from "./checkout";

/**
 * The few Stripe API calls Felyn makes, over plain fetch (no SDK dependency).
 * Server-only: the secret key never reaches the browser. Every write that creates
 * something uses an idempotency key derived from Felyn's own ids, so a retry can never
 * create a second session, account, capture or cancellation. No call here creates a
 * transfer, a payout or a refund — there is deliberately no such function.
 *
 * The /v1 requests use the Stripe account's default API version. Host accounts and
 * their onboarding links use Accounts v2 (/v2/core), which takes JSON and requires an
 * explicit Stripe-Version. Only long-stable fields are read (id, url, status,
 * latest_charge).
 */
const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_V2 = "https://api.stripe.com/v2";
/** The Stripe API version for the /v2 requests (the release that made Accounts v2 generally available). */
export const STRIPE_V2_API_VERSION = "2025-12-15.clover";
const TIMEOUT_MS = 15_000;

/**
 * A failure carries only Stripe's HTTP status, error type and code, and the request id
 * (req_...), which finds the request in Stripe's logs. Never the message: it can repeat
 * what was sent, such as an email address.
 */
export type StripeFailure = { ok: false; status: number; code: string | null; type: string | null; requestId: string | null };
export type StripeResult<T> = { ok: true; data: T } | StripeFailure;

type StripeObject = Record<string, unknown>;

/** Stripe's own identifiers only (error types, codes, request ids), so a log line can't carry anything else. */
function safeToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
}

async function send(url: string, init: RequestInit): Promise<StripeResult<StripeObject>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    return { ok: false, status: 0, code: "network_error", type: null, requestId: null };
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
      code: safeToken(error.code),
      type: safeToken(error.type),
      requestId: safeToken(response.headers.get("request-id")),
    };
  }
  return { ok: true, data: json };
}

function stripeRequest(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> | null,
  idempotencyKey: string | null,
): Promise<StripeResult<StripeObject>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return send(`${STRIPE_API}${path}`, { method, headers, body: method === "POST" ? encodeStripeForm(params ?? {}) : undefined });
}

/** A /v2 POST: a JSON body and an explicit API version. */
function stripeV2Post(secretKey: string, path: string, body: StripeJsonBody, idempotencyKey: string | null): Promise<StripeResult<StripeObject>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    "Stripe-Version": STRIPE_V2_API_VERSION,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return send(`${STRIPE_API_V2}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A /v2 GET with an explicit API version (array query parameters are indexed, as /v2 requires). */
function stripeV2Get(secretKey: string, path: string, query: URLSearchParams): Promise<StripeResult<StripeObject>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_V2_API_VERSION };
  return send(`${STRIPE_API_V2}${path}?${query.toString()}`, { method: "GET", headers });
}

/** What a host account fetch includes: the recipient configuration (capabilities) and the requirements. */
export const ACCOUNT_INCLUDES = ["configuration.recipient", "requirements"] as const;

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
    // Accounts v2. The key differs from the old /v1 one (felyn-account-<id>), whose stored
    // failure /v1 replays for 24 hours; a /v2 replay re-runs a request that failed.
    createRecipientAccount: (body: StripeJsonBody, providerId: string) =>
      stripeV2Post(secretKey, "/core/accounts", body, `felyn-account-v2-${providerId}`),
    // A fresh single-use link every time, so no idempotency key.
    createAccountLink: (body: StripeJsonBody) => stripeV2Post(secretKey, "/core/account_links", body, null),
    // The account's current state (read only), for account-sync.ts.
    retrieveAccount: (accountId: string) =>
      stripeV2Get(
        secretKey,
        `/core/accounts/${encodeURIComponent(accountId)}`,
        new URLSearchParams(ACCOUNT_INCLUDES.map((value, index) => [`include[${index}]`, value])),
      ),
  };
}

export type StripeApi = ReturnType<typeof createStripeApi>;

// Capture and cancel decisions live in ./stripe-intents.ts (pure, unit-tested).
