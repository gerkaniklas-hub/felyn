import { respondToStripeWebhook } from "@/lib/payments/webhook-route";

/**
 * Stripe's CONNECT webhook endpoint (events from hosts' connected accounts:
 * account.updated), TEST MODE ONLY. A separate endpoint in the Stripe Dashboard
 * ("Listen to events on Connected accounts") with its own signing secret:
 * STRIPE_CONNECT_WEBHOOK_SECRET here, and the same value in
 * felyn_private.stripe_webhook_secrets ('connect', 'current') in the database.
 * Without PAYMENTS_ENABLED=true and a complete test-mode configuration it answers 404.
 */
export async function POST(request: Request): Promise<Response> {
  return respondToStripeWebhook("connect", request);
}
