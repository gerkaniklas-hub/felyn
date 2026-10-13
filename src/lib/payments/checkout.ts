/**
 * Stripe Checkout and Connect request building — pure, so every rule is unit-tested.
 *
 * The amounts always come from the database (public.booking_payment_start, 0037,
 * computed from the booking's own price snapshot and guest count; 0036's insert guard
 * re-checks them). Here they are checked once more against money.ts before anything is
 * sent to Stripe, and the Checkout Session is built so that:
 *   - the money is only AUTHORIZED (payment_intent_data.capture_method = manual): the
 *     server captures it only when the database says the booking can still be
 *     confirmed (stripe_apply_event answers "capture");
 *   - Felyn is the merchant (separate charges and transfers): NO transfer_data,
 *     application_fee_amount or on_behalf_of — the host's share stays in Felyn's
 *     balance; nothing here (or anywhere in this build) creates a transfer or payout;
 *   - it expires 10 minutes before the payment deadline (timing.ts);
 *   - cards only (no delayed payment methods, so "completed" means authorized);
 *   - the attempt id travels in metadata, client_reference_id and the PaymentIntent.
 *
 * Pure module (relative imports only), so it runs under `npm test` as well as in Next.js.
 */
import { calculatePlatformFeeCents, MIN_PRICE_PER_PERSON_CENTS, PAYMENT_CURRENCY, STRIPE_CURRENCY, STRIPE_MAX_AMOUNT_CENTS } from "./money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PaymentStartCreated = {
  result: "created";
  paymentId: string;
  livemode: boolean;
  currency: string;
  pricePerPersonCents: number;
  guestCount: number;
  grossCents: number;
  platformFeeCents: number;
  paymentDueAtMs: number;
  experienceTitle: string;
  transferGroup: string;
};

export type PaymentStartResult =
  | PaymentStartCreated
  | { result: "existing"; paymentId: string; checkoutSessionId: string }
  | { result: "not_found" | "not_payable" | "in_progress" | "processing" | "needs_support" }
  | { result: "invalid" };

function isWholeCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reads public.booking_payment_start's jsonb answer; anything unexpected is "invalid". */
export function parsePaymentStart(value: unknown): PaymentStartResult {
  if (!value || typeof value !== "object") return { result: "invalid" };
  const v = value as Record<string, unknown>;
  switch (v.result) {
    case "created": {
      const due = typeof v.payment_due_at === "string" ? Date.parse(v.payment_due_at) : NaN;
      if (
        typeof v.payment_id !== "string" || !UUID.test(v.payment_id) ||
        typeof v.livemode !== "boolean" || typeof v.currency !== "string" ||
        !isWholeCents(v.price_per_person_cents) || !isWholeCents(v.guest_count) ||
        !isWholeCents(v.gross_cents) || !isWholeCents(v.platform_fee_cents) ||
        !Number.isFinite(due) || typeof v.experience_title !== "string" || typeof v.transfer_group !== "string"
      ) {
        return { result: "invalid" };
      }
      return {
        result: "created",
        paymentId: v.payment_id,
        livemode: v.livemode,
        currency: v.currency,
        pricePerPersonCents: v.price_per_person_cents,
        guestCount: v.guest_count,
        grossCents: v.gross_cents,
        platformFeeCents: v.platform_fee_cents,
        paymentDueAtMs: due,
        experienceTitle: v.experience_title,
        transferGroup: v.transfer_group,
      };
    }
    case "existing":
      if (typeof v.payment_id !== "string" || !UUID.test(v.payment_id) || typeof v.checkout_session_id !== "string") {
        return { result: "invalid" };
      }
      return { result: "existing", paymentId: v.payment_id, checkoutSessionId: v.checkout_session_id };
    case "not_found":
    case "not_payable":
    case "in_progress":
    case "processing":
    case "needs_support":
      return { result: v.result };
    default:
      return { result: "invalid" };
  }
}

export type AttemptCheckError = "live_mode" | "currency" | "below_minimum" | "amount_mismatch" | "fee_mismatch" | "too_large" | "transfer_group";

/**
 * The database's attempt, checked against the app's own money rules: test mode, EUR,
 * €5 minimum, gross = price x guests, fee = 10% half up, within Stripe's maximum.
 * A mismatch means the two disagree — nothing is sent to Stripe.
 */
export function checkAttemptAmounts(attempt: PaymentStartCreated): { ok: true } | { ok: false; error: AttemptCheckError } {
  if (attempt.livemode) return { ok: false, error: "live_mode" };
  if (attempt.currency !== PAYMENT_CURRENCY) return { ok: false, error: "currency" };
  if (attempt.pricePerPersonCents < MIN_PRICE_PER_PERSON_CENTS) return { ok: false, error: "below_minimum" };
  if (attempt.guestCount < 1 || attempt.grossCents !== attempt.pricePerPersonCents * attempt.guestCount) {
    return { ok: false, error: "amount_mismatch" };
  }
  if (attempt.grossCents > STRIPE_MAX_AMOUNT_CENTS) return { ok: false, error: "too_large" };
  if (attempt.platformFeeCents !== calculatePlatformFeeCents(attempt.grossCents)) return { ok: false, error: "fee_mismatch" };
  if (attempt.transferGroup !== `felyn_payment_${attempt.paymentId}`) return { ok: false, error: "transfer_group" };
  return { ok: true };
}

export type CheckoutSessionInput = {
  attempt: PaymentStartCreated;
  bookingItemId: string;
  expiresAtUnixSeconds: number;
  /** Origin only (config.appUrl). */
  appUrl: string;
  customerEmail: string | null;
};

/** Stripe's Checkout Session parameters, flattened for form encoding. */
export function buildCheckoutSessionParams(input: CheckoutSessionInput): Record<string, string> {
  const { attempt } = input;
  const title = attempt.experienceTitle.trim().slice(0, 200) || "Felyn experience";
  const bookingUrl = `${input.appUrl}/bookings/${encodeURIComponent(input.bookingItemId)}`;
  const params: Record<string, string> = {
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": String(attempt.guestCount),
    "line_items[0][price_data][currency]": STRIPE_CURRENCY,
    "line_items[0][price_data][unit_amount]": String(attempt.pricePerPersonCents),
    "line_items[0][price_data][product_data][name]": title,
    "payment_intent_data[capture_method]": "manual",
    "payment_intent_data[transfer_group]": attempt.transferGroup,
    "payment_intent_data[metadata][felyn_payment_id]": attempt.paymentId,
    "payment_intent_data[metadata][felyn_booking_item_id]": input.bookingItemId,
    "metadata[felyn_payment_id]": attempt.paymentId,
    "metadata[felyn_booking_item_id]": input.bookingItemId,
    client_reference_id: attempt.paymentId,
    expires_at: String(input.expiresAtUnixSeconds),
    success_url: `${bookingUrl}?checkout=success`,
    cancel_url: `${bookingUrl}?checkout=cancelled`,
  };
  if (input.customerEmail) params.customer_email = input.customerEmail;
  return params;
}

/** A host's Express connected account (test mode), able to receive transfers later. No payout is created. */
export function buildExpressAccountParams(input: { providerId: string; email: string | null }): Record<string, string> {
  const params: Record<string, string> = {
    type: "express",
    country: "ES",
    "capabilities[transfers][requested]": "true",
    "metadata[felyn_provider_id]": input.providerId,
  };
  if (input.email) params.email = input.email;
  return params;
}

export function buildAccountLinkParams(input: { accountId: string; appUrl: string }): Record<string, string> {
  return {
    account: input.accountId,
    type: "account_onboarding",
    refresh_url: `${input.appUrl}/provider/payouts?onboarding=refresh`,
    return_url: `${input.appUrl}/provider/payouts?onboarding=return`,
  };
}

/** application/x-www-form-urlencoded, as Stripe's API takes it. */
export function encodeStripeForm(params: Record<string, string>): string {
  return new URLSearchParams(Object.entries(params)).toString();
}

/** A Checkout Session URL we are willing to send a guest to. */
export function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

/** An onboarding URL we are willing to send a host to. */
export function isStripeConnectUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "connect.stripe.com";
  } catch {
    return false;
  }
}

/** Test-mode ids only (the database's constraints refuse live ones too). */
export function isTestCheckoutSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_test_[A-Za-z0-9]{1,250}$/.test(value);
}

export function isStripeAccountId(value: unknown): value is string {
  return typeof value === "string" && /^acct_[A-Za-z0-9]{1,250}$/.test(value);
}
