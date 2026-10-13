import { respondToAccountEvent } from "@/lib/payments/account-events-route";

/**
 * Stripe's ACCOUNTS V2 event endpoint, TEST MODE ONLY: a separate event destination in
 * Stripe Workbench with the THIN payload format and "Events from: Your account",
 * subscribed to v2.core.account[requirements].updated and
 * v2.core.account[configuration.recipient].capability_status_updated. Its own signing
 * secret: STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET. Each event only triggers a fetch of the
 * host's account from Stripe; the event never decides anything itself.
 * Without PAYMENTS_ENABLED=true, a complete test-mode configuration and that secret it
 * answers 404.
 */
export async function POST(request: Request): Promise<Response> {
  return respondToAccountEvent(request);
}
