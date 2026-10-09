/**
 * Stripe integration, Stage 1: payment-window timing rules, as named constants
 * and pure functions over epoch milliseconds (no Date.now() inside — the
 * caller passes `nowMs`, so every rule is deterministic and testable).
 *
 * The payment deadline itself is 0035's, unchanged:
 *   payment_due_at = least(accepted_at + 24 hours, confirmed_start_at - 2 hours)
 * Stage 1 decision 3 adds the buffers around it:
 *   - a host may accept only if at least 60 minutes remain until payment_due_at
 *     (0036's booking_item_confirm enforces the same, FB001);
 *   - a new Checkout session may be created only while at least 41 minutes remain
 *     (0036's check on new payment attempts enforces the same, FB005);
 *   - a Checkout session expires 10 minutes before payment_due_at, so a payment
 *     completed in Checkout always lands before the deadline the database checks.
 * Stripe requires a Checkout session's expires_at to be between 30 minutes and
 * 24 hours after the session is created. The 41-minute cutoff is that 30-minute
 * minimum + the 10-minute buffer + 1 minute of margin, so even at the cutoff the
 * session expires 31 minutes out — a minute clear of Stripe's minimum for request
 * latency and clock differences.
 *
 * Pure module (relative imports only), so it runs under `npm test` as well as in Next.js.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** 0035: the guest has at most 24 hours from acceptance to pay... */
export const PAYMENT_WINDOW_MAX_MS = 24 * HOUR_MS;
/** 0035: ...and must have paid 2 hours before the experience starts. */
export const PAYMENT_DUE_BEFORE_START_MS = 2 * HOUR_MS;
/** Decision 3: acceptance needs at least this long until payment_due_at. */
export const MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS = 60 * MINUTE_MS;
/** Decision 3: a Checkout session expires this long before payment_due_at. */
export const CHECKOUT_EXPIRY_BEFORE_DUE_MS = 10 * MINUTE_MS;
/** Stripe: a Checkout session's expires_at must be at least 30 minutes after creation... */
export const STRIPE_CHECKOUT_MIN_EXPIRY_MS = 30 * MINUTE_MS;
/** ...and at most 24 hours after creation. */
export const STRIPE_CHECKOUT_MAX_EXPIRY_MS = 24 * HOUR_MS;
/** Kept clear of Stripe's minimum, for request latency and clock differences. */
export const CHECKOUT_EXPIRY_MARGIN_MS = 1 * MINUTE_MS;
/**
 * Host transfers: the review period after an experience's scheduled end (the 0033
 * acceptance snapshot) before its host share can be released — seven full days, which
 * 0036's release gate enforces as 168 hours.
 */
export const HOST_TRANSFER_REVIEW_PERIOD_MS = 7 * 24 * HOUR_MS;
/** No new Checkout session with less than this left until payment_due_at: 30 + 10 + 1 = 41 minutes. */
export const MIN_TIME_TO_START_CHECKOUT_MS =
  STRIPE_CHECKOUT_MIN_EXPIRY_MS + CHECKOUT_EXPIRY_BEFORE_DUE_MS + CHECKOUT_EXPIRY_MARGIN_MS;

/** 0035's deadline formula, on instants. */
export function calculatePaymentDueAtMs(acceptedAtMs: number, confirmedStartAtMs: number): number {
  return Math.min(acceptedAtMs + PAYMENT_WINDOW_MAX_MS, confirmedStartAtMs - PAYMENT_DUE_BEFORE_START_MS);
}

export type AcceptanceWindow =
  | { ok: true; paymentDueAtMs: number }
  | { ok: false; error: "too_late_to_accept"; paymentDueAtMs: number };

/**
 * Whether a host accepting at `nowMs` leaves the guest enough time to pay
 * (at least MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS until payment_due_at; exactly
 * that much is enough).
 */
export function getAcceptancePaymentWindow(nowMs: number, confirmedStartAtMs: number): AcceptanceWindow {
  const paymentDueAtMs = calculatePaymentDueAtMs(nowMs, confirmedStartAtMs);
  if (paymentDueAtMs - nowMs < MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS) {
    return { ok: false, error: "too_late_to_accept", paymentDueAtMs };
  }
  return { ok: true, paymentDueAtMs };
}

export type CheckoutWindowError =
  | "invalid_time" // a non-finite instant
  | "payment_deadline_passed" // nowMs is at or after payment_due_at
  | "too_late_to_start_checkout"; // under MIN_TIME_TO_START_CHECKOUT_MS left (or Stripe's minimum can't be met)

export type CheckoutWindow =
  | {
      ok: true;
      /** When the Checkout session must expire, as Stripe's expires_at (whole Unix seconds, rounded down). */
      expiresAtUnixSeconds: number;
      expiresAtMs: number;
    }
  | { ok: false; error: CheckoutWindowError };

/**
 * Whether a new Checkout session may be created at `nowMs`, and when it must
 * expire: CHECKOUT_EXPIRY_BEFORE_DUE_MS before payment_due_at, capped at Stripe's
 * 24-hour maximum. The expiry is rounded DOWN to a whole second (Stripe takes
 * seconds), so it is never later than the rule allows; if that rounding would
 * put it under Stripe's 30-minute minimum, the session is refused rather than
 * created with an expiry Stripe would reject or one past the rule (with the
 * 1-minute margin this can't happen for a valid window; it stays as a guard).
 *
 * Stripe measures its 30-minute minimum from when IT receives the request, a
 * moment after `nowMs`; the 1-minute margin covers that. If Stripe still rejects
 * the expiry, the caller shows the same "too late to start payment" message.
 */
export function getCheckoutWindow(nowMs: number, paymentDueAtMs: number): CheckoutWindow {
  if (!Number.isFinite(nowMs) || !Number.isFinite(paymentDueAtMs)) return { ok: false, error: "invalid_time" };
  if (nowMs >= paymentDueAtMs) return { ok: false, error: "payment_deadline_passed" };
  if (paymentDueAtMs - nowMs < MIN_TIME_TO_START_CHECKOUT_MS) return { ok: false, error: "too_late_to_start_checkout" };
  const targetMs = Math.min(paymentDueAtMs - CHECKOUT_EXPIRY_BEFORE_DUE_MS, nowMs + STRIPE_CHECKOUT_MAX_EXPIRY_MS);
  const expiresAtUnixSeconds = Math.floor(targetMs / 1000);
  const expiresAtMs = expiresAtUnixSeconds * 1000;
  if (expiresAtMs - nowMs < STRIPE_CHECKOUT_MIN_EXPIRY_MS) return { ok: false, error: "too_late_to_start_checkout" };
  return { ok: true, expiresAtUnixSeconds, expiresAtMs };
}

/** A safe, user-facing sentence for each error. */
export function getCheckoutWindowErrorMessage(error: CheckoutWindowError): string {
  switch (error) {
    case "payment_deadline_passed":
      return "The payment deadline for this booking has passed, so it can no longer be paid.";
    case "too_late_to_start_checkout":
      return "It's too close to the payment deadline to start a new payment. Please contact Felyn support if you need help.";
    default:
      return "We couldn't start the payment. Please try again.";
  }
}
