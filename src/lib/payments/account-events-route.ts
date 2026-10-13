import "server-only";
import { handleAccountEvent } from "./account-events";
import { syncHostPayoutAccount } from "./account-sync-server";
import { getServerPayments } from "./server";
import { MAX_WEBHOOK_BODY_BYTES } from "./webhook";

/**
 * Wires the real side effects into handleAccountEvent (account-events.ts). With payments
 * off or misconfigured, or without STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET, the endpoint
 * doesn't exist (404).
 */
export async function respondToAccountEvent(request: Request): Promise<Response> {
  const payments = getServerPayments();
  if (!payments.enabled || !payments.config.accountEventsWebhookSecret) return new Response(null, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) return Response.json({ received: false, error: "body size" }, { status: 413 });
  // The exact bytes Stripe signed — never re-serialized JSON.
  const rawBody = new Uint8Array(await request.arrayBuffer());

  const secretKey = payments.config.secretKey;
  const result = await handleAccountEvent(rawBody, request.headers.get("stripe-signature"), {
    secrets: [payments.config.accountEventsWebhookSecret],
    nowSeconds: Math.floor(Date.now() / 1000),
    syncAccount: (accountId) => syncHostPayoutAccount(secretKey, accountId),
    log: (message) => console.error(message),
  });
  return Response.json(result.body, { status: result.status });
}
