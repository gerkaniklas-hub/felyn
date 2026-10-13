/**
 * Capturing and cancelling a held (authorized) payment, idempotently — pure apart
 * from the API object passed in, so the decisions are unit-tested. Used by the
 * webhook route only, when public.stripe_apply_event asks for it.
 */
export type IntentCallResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; code: string | null };

export type IntentApi = {
  capturePaymentIntent: (paymentIntentId: string) => Promise<IntentCallResult>;
  cancelPaymentIntent: (paymentIntentId: string) => Promise<IntentCallResult>;
  retrievePaymentIntent: (paymentIntentId: string) => Promise<IntentCallResult>;
};

const isMissing = (result: IntentCallResult) => !result.ok && (result.status === 404 || result.code === "resource_missing");

/**
 * Capture: true only when Stripe says the PaymentIntent is (now or already) captured.
 * Anything else — declined, expired authorization, network, a missing PaymentIntent —
 * is false, so the route answers 500 and Stripe redelivers (the database decides again).
 */
export async function captureAuthorizedPayment(api: IntentApi, paymentIntentId: string): Promise<boolean> {
  const result = await api.capturePaymentIntent(paymentIntentId);
  if (result.ok) return result.data.status === "succeeded";
  const current = await api.retrievePaymentIntent(paymentIntentId);
  return current.ok && current.data.status === "succeeded";
}

/**
 * Cancel a hold: true when it is (now or already) cancelled, or when Stripe has no
 * such PaymentIntent at all — then there is nothing to release (e.g. the Dashboard's
 * "Send test event" uses made-up ids). Without that, a single synthetic event would
 * be retried by Stripe for three days.
 */
export async function cancelAuthorization(api: IntentApi, paymentIntentId: string): Promise<boolean> {
  const result = await api.cancelPaymentIntent(paymentIntentId);
  if (result.ok) return result.data.status === "canceled";
  if (isMissing(result)) return true;
  const current = await api.retrievePaymentIntent(paymentIntentId);
  if (isMissing(current)) return true;
  return current.ok && current.data.status === "canceled";
}
