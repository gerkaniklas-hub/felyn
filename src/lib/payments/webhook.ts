/**
 * The Stripe webhook route's logic, with its side effects injected so it can be
 * unit-tested (the route in src/app/api/stripe/ only wires in the real ones).
 *
 * Order, and why:
 *   1. size limit, then the route's own signature check over the RAW body bytes
 *      (webhook-signature.ts) — nothing is parsed or stored for an unverified request;
 *   2. test mode only: an event with livemode true is refused before the database;
 *   3. public.stripe_apply_event (0037) verifies the signature AGAIN in the database,
 *      deduplicates by event id and applies the event; it alone decides what happens;
 *   4. only then, the Stripe call the database asked for: capture the authorized
 *      payment, or cancel an authorization it won't keep. If that call fails the
 *      route answers 500, Stripe redelivers, and the database decides again from the
 *      attempt's current state (it may now say cancel instead of capture).
 *   200 tells Stripe to stop retrying; 4xx is a request Stripe shouldn't resend as-is
 *   (it still retries, which is harmless); 5xx means "try again later".
 * Responses never contain the body, the header, a secret or an internal error.
 */
import { verifyStripeSignature, WEBHOOK_TOLERANCE_SECONDS } from "./webhook-signature";

export type WebhookEndpoint = "platform" | "connect";

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

export type ApplyEventResult = {
  result: string;
  action?: string;
  payment_intent_id?: string;
};

export type WebhookDeps = {
  /** The endpoint's signing secret(s) (current, and previous during a rotation). */
  secrets: readonly string[];
  nowSeconds: number;
  /** public.stripe_apply_event via the service_role client; throws when the database can't be reached. */
  applyEvent: (endpoint: WebhookEndpoint, bodyBase64: string, signature: string) => Promise<ApplyEventResult>;
  /** Captures an authorized PaymentIntent; true when it is (now or already) captured. */
  capture: (paymentIntentId: string) => Promise<boolean>;
  /** Cancels an authorization; true when it is (now or already) cancelled. */
  cancel: (paymentIntentId: string) => Promise<boolean>;
  /** Server log line (never given a body, header or secret). */
  log: (message: string) => void;
  /**
   * Connect endpoint only: after the database applied a legacy account.updated, re-reads
   * that account through Accounts v2 (account-sync-server.ts). The fetch is later than the
   * event, so the stricter v2 reading replaces the v1 snapshot. Never throws; a failure
   * leaves the event's (Stripe-signed) state in place.
   */
  resyncAccount?: (accountId: string) => Promise<unknown>;
};

export type WebhookResponse = { status: number; body: { received: boolean; error?: string } };

const reply = (status: number, error?: string): WebhookResponse => ({ status, body: error ? { received: false, error } : { received: true } });

export async function handleStripeWebhook(
  endpoint: WebhookEndpoint,
  rawBody: Uint8Array,
  signatureHeader: string | null,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) return reply(413, "body size");

  const check = verifyStripeSignature(rawBody, signatureHeader, deps.secrets, deps.nowSeconds, WEBHOOK_TOLERANCE_SECONDS);
  if (!check.ok) {
    deps.log(`stripe webhook (${endpoint}): refused, ${check.error}`);
    return reply(400, "signature");
  }

  let event: { livemode?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
  try {
    event = JSON.parse(Buffer.from(rawBody).toString("utf8")) as typeof event;
  } catch {
    return reply(400, "body");
  }
  if (event === null || typeof event !== "object") return reply(400, "body");
  if (event.livemode !== false) {
    deps.log(`stripe webhook (${endpoint}): refused a live-mode or unmarked event (this build is test mode only)`);
    return reply(400, "mode");
  }

  let result: ApplyEventResult;
  try {
    result = await deps.applyEvent(endpoint, Buffer.from(rawBody).toString("base64"), signatureHeader as string);
  } catch {
    deps.log(`stripe webhook (${endpoint}): database unavailable, Stripe will retry`);
    return reply(500, "unavailable");
  }

  switch (result.result) {
    case "processed":
    case "ignored":
    case "duplicate":
      break;
    case "invalid_signature":
      deps.log(`stripe webhook (${endpoint}): the database rejected a signature the route accepted — webhook secrets out of sync`);
      return reply(500, "configuration");
    case "not_configured":
      deps.log(`stripe webhook (${endpoint}): no webhook secret configured in the database (felyn_private.stripe_webhook_secrets)`);
      return reply(500, "configuration");
    case "stale_timestamp":
      return reply(400, "signature");
    case "wrong_mode":
    case "wrong_endpoint":
    case "malformed":
    case "payload_mismatch":
      deps.log(`stripe webhook (${endpoint}): refused by the database, ${result.result}`);
      return reply(400, "refused");
    default:
      deps.log(`stripe webhook (${endpoint}): unexpected database answer`);
      return reply(500, "unexpected");
  }

  const accountId = event.data?.object?.id;
  if (endpoint === "connect" && result.result === "processed" && event.type === "account.updated" && deps.resyncAccount
      && typeof accountId === "string" && /^acct_[A-Za-z0-9]{1,250}$/.test(accountId)) {
    try {
      await deps.resyncAccount(accountId);
    } catch {
      deps.log(`stripe webhook (${endpoint}): Accounts v2 re-read after account.updated failed; the event's state stays`);
    }
  }

  if (result.action === "capture" || result.action === "cancel_authorization") {
    const pi = result.payment_intent_id;
    if (typeof pi !== "string" || !/^pi_[A-Za-z0-9]{1,250}$/.test(pi)) {
      deps.log(`stripe webhook (${endpoint}): action without a valid PaymentIntent id`);
      return reply(500, "unexpected");
    }
    const done = result.action === "capture" ? await deps.capture(pi) : await deps.cancel(pi);
    if (!done) {
      deps.log(`stripe webhook (${endpoint}): ${result.action} failed for a payment; Stripe will redeliver and the database decides again`);
      return reply(500, "action");
    }
  }
  return reply(200);
}
