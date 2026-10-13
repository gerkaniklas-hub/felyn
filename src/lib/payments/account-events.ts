/**
 * The Accounts v2 event route's logic (/api/stripe/account-events), with its side
 * effects injected so it can be unit-tested, like webhook.ts.
 *
 * Stripe sends this endpoint "thin" events (an event destination with the thin payload
 * format, "Events from: Your account"): the event type and the account id, never the
 * account's state. Order, and why:
 *   1. size limit, then the signature over the RAW body bytes (webhook-signature.ts:
 *      Stripe's v1 scheme, this destination's own whsec_ secret, 300-second tolerance) —
 *      nothing is parsed for an unverified request;
 *   2. test mode only: a live-mode event is refused;
 *   3. only v2.core.account[requirements].updated and
 *      v2.core.account[configuration.recipient].capability_status_updated for a v2
 *      Account lead anywhere; any other verified event is acknowledged and ignored;
 *   4. the account is FETCHED from Stripe and recorded (account-sync-server.ts); the
 *      event's own contents never decide readiness.
 * A redelivered or duplicate event just fetches and records the current state again,
 * so it needs no deduplication. 200 tells Stripe to stop; 4xx is a request Stripe
 * shouldn't resend as-is; 5xx (Stripe or the database unavailable) means "try again".
 * Responses and logs never contain the body, the header, a secret or an email.
 */
import { parseAccountEventNotice } from "./account-sync";
import { MAX_WEBHOOK_BODY_BYTES, type WebhookResponse } from "./webhook";
import { verifyStripeSignature, WEBHOOK_TOLERANCE_SECONDS } from "./webhook-signature";

/** The result of fetching one account from Stripe and recording it (0038). */
export type AccountSyncOutcome =
  | "synced" // recorded
  | "stale" // an older reading than the one already recorded: nothing changed
  | "unknown_account" // not a Felyn host's account: nothing changed
  | "stripe_not_found" // Stripe has no such account
  | "invalid_account" // Stripe's answer wasn't the account asked for, or was live
  | "stripe_unavailable" // the fetch failed (network, rate limit, permission, 5xx)
  | "database_unavailable";

export type AccountEventDeps = {
  /** This destination's signing secret(s). */
  secrets: readonly string[];
  nowSeconds: number;
  /** Fetches the account from Stripe and records it; never throws. */
  syncAccount: (accountId: string) => Promise<AccountSyncOutcome>;
  /** Server log line (never given a body, header or secret). */
  log: (message: string) => void;
};

const reply = (status: number, error?: string): WebhookResponse => ({ status, body: error ? { received: false, error } : { received: true } });

export async function handleAccountEvent(rawBody: Uint8Array, signatureHeader: string | null, deps: AccountEventDeps): Promise<WebhookResponse> {
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) return reply(413, "body size");

  const check = verifyStripeSignature(rawBody, signatureHeader, deps.secrets, deps.nowSeconds, WEBHOOK_TOLERANCE_SECONDS);
  if (!check.ok) {
    deps.log(`stripe account events: refused, ${check.error}`);
    return reply(400, "signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return reply(400, "body");
  }
  const notice = parseAccountEventNotice(parsed);
  switch (notice.kind) {
    case "malformed":
      deps.log("stripe account events: refused a malformed event");
      return reply(400, "body");
    case "live":
      deps.log("stripe account events: refused a live-mode event (this build is test mode only)");
      return reply(400, "mode");
    case "ignore":
      return reply(200);
    case "sync":
      break;
  }

  const outcome = await deps.syncAccount(notice.accountId);
  switch (outcome) {
    case "synced":
    case "stale":
      return reply(200);
    case "unknown_account":
    case "stripe_not_found":
    case "invalid_account":
      deps.log(`stripe account events: ${notice.eventId} not applied (${outcome})`);
      return reply(200);
    case "stripe_unavailable":
    case "database_unavailable":
      deps.log(`stripe account events: ${notice.eventId} not applied (${outcome}), Stripe will retry`);
      return reply(500, "unavailable");
    default:
      deps.log("stripe account events: unexpected sync result");
      return reply(500, "unexpected");
  }
}
