import { respondToStripeWebhook } from "@/lib/payments/webhook-route";

/**
 * Stripe's PLATFORM webhook endpoint (Checkout, PaymentIntents, charges, disputes),
 * TEST MODE ONLY. Configure it in the Stripe Dashboard (test mode) with its own
 * signing secret: STRIPE_WEBHOOK_SECRET here, and the same value in
 * felyn_private.stripe_webhook_secrets ('platform', 'current') in the database.
 * Without PAYMENTS_ENABLED=true and a complete test-mode configuration it answers 404.
 * See src/lib/payments/webhook.ts for the order of checks.
 */
export async function POST(request: Request): Promise<Response> {
  return respondToStripeWebhook("platform", request);
}
