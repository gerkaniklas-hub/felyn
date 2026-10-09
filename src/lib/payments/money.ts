/**
 * Stripe integration, Stage 1: booking money in integer euro cents.
 *
 * Every amount here is a whole number of cents (a safe integer) — never a
 * floating-point euro value. Prices come from the database
 * (booking_request_items.price_per_person, numeric(10,2), copied from the
 * experience when the request is created, 0031), never from the client; the
 * total is always recomputed from that snapshot and guest_count, never taken
 * from a client-supplied total.
 *
 * Felyn's commission rule (Stage 1 decision 5):
 *   platform fee = 10% of the gross booking amount, rounded to the nearest cent,
 *                  with an exact half cent rounded UP (round half up; every
 *                  amount is positive, so this is also "half away from zero").
 *                  Integer form: fee = floor((gross + 5) / 10).
 *   host share   = gross - platform fee   (so fee + host share = gross, always).
 * A fractional cent only appears when gross is not a multiple of 10 cents; the
 * half-cent case is gross ending in 5 cents (e.g. 1005 -> fee 101, host 904).
 *
 * The host share is NOMINAL: Felyn absorbs Stripe's processing fees, so they
 * reduce Felyn's fee, never the host share. Stripe's own fees are not modelled
 * here.
 *
 * Pure module (relative imports only, no Stripe SDK, no Supabase), so it runs
 * under `npm test` as well as in Next.js.
 */

/** The only currency Felyn charges in (experiences.currency defaults to EUR). */
export const PAYMENT_CURRENCY = "EUR";
/** The same currency as Stripe's API spells it. */
export const STRIPE_CURRENCY = "eur";

/** Felyn's commission, in basis points of the gross amount (10%). */
export const PLATFORM_FEE_BASIS_POINTS = 1000;
/** Minimum price per person Felyn accepts for a paid booking: €5.00 (Stage 1 decision 9). */
export const MIN_PRICE_PER_PERSON_CENTS = 500;
/**
 * Stripe's largest single charge amount: eight digits in the smallest unit
 * (€999,999.99). Re-check against Stripe's documentation before going live.
 */
export const STRIPE_MAX_AMOUNT_CENTS = 99_999_999;

export type MoneyError =
  | "invalid_price" // not a non-negative amount with at most two decimals
  | "price_below_minimum" // under MIN_PRICE_PER_PERSON_CENTS
  | "invalid_guest_count" // not a positive whole number
  | "amount_too_large" // the gross amount exceeds STRIPE_MAX_AMOUNT_CENTS
  | "unsupported_currency"; // anything but EUR

export type MoneyResult<T> = { ok: true; value: T } | { ok: false; error: MoneyError };

export type BookingAmounts = {
  currency: typeof PAYMENT_CURRENCY;
  pricePerPersonCents: number;
  guestCount: number;
  /** pricePerPersonCents x guestCount: what the guest pays. */
  grossCents: number;
  /** Felyn's 10% commission (see the rounding rule above). */
  platformFeeCents: number;
  /** grossCents - platformFeeCents: the nominal amount owed to the host. */
  hostShareCents: number;
};

const DECIMAL_AMOUNT = /^(\d{1,8})(?:\.(\d{1,2}))?$/;

/**
 * A database price ("85.00", "19.9" or the number 85.5, as PostgREST may return
 * numeric) to whole cents, by reading its decimal digits — never by
 * multiplying a float. Rejects negatives, more than two decimals, exponents,
 * NaN/Infinity and anything that isn't plainly a number.
 */
export function priceToCents(price: string | number): MoneyResult<number> {
  if (typeof price === "number" && !Number.isFinite(price)) return { ok: false, error: "invalid_price" };
  const text = typeof price === "number" ? String(price) : price.trim();
  const match = DECIMAL_AMOUNT.exec(text);
  if (!match) return { ok: false, error: "invalid_price" };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return { ok: true, value: cents };
}

/** The €5 minimum per person, on whole cents. */
export function isAtLeastMinimumPrice(pricePerPersonCents: number): boolean {
  return Number.isSafeInteger(pricePerPersonCents) && pricePerPersonCents >= MIN_PRICE_PER_PERSON_CENTS;
}

/** Felyn's fee on a gross amount: 10%, round half up, in integer arithmetic. */
export function calculatePlatformFeeCents(grossCents: number): number {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) {
    throw new RangeError("grossCents must be a non-negative whole number of cents");
  }
  // gross * 1000 / 10000 = gross / 10; adding half the divisor before the
  // floor rounds an exact half up.
  return Math.floor((grossCents * PLATFORM_FEE_BASIS_POINTS + 5000) / 10000);
}

/** Splits a gross amount into Felyn's fee and the host's nominal share; they always add up to gross. */
export function splitGrossAmount(grossCents: number): { platformFeeCents: number; hostShareCents: number } {
  const platformFeeCents = calculatePlatformFeeCents(grossCents);
  return { platformFeeCents, hostShareCents: grossCents - platformFeeCents };
}

/**
 * Everything the payment needs, from the booking's own price snapshot and guest
 * count. The only place a gross amount is produced.
 */
export function calculateBookingAmounts(input: {
  pricePerPerson: string | number;
  guestCount: number;
  currency: string;
}): MoneyResult<BookingAmounts> {
  if (input.currency.trim().toUpperCase() !== PAYMENT_CURRENCY) return { ok: false, error: "unsupported_currency" };
  const price = priceToCents(input.pricePerPerson);
  if (!price.ok) return price;
  if (!isAtLeastMinimumPrice(price.value)) return { ok: false, error: "price_below_minimum" };
  if (!Number.isSafeInteger(input.guestCount) || input.guestCount < 1) return { ok: false, error: "invalid_guest_count" };
  const grossCents = price.value * input.guestCount;
  if (!Number.isSafeInteger(grossCents) || grossCents > STRIPE_MAX_AMOUNT_CENTS) return { ok: false, error: "amount_too_large" };
  const { platformFeeCents, hostShareCents } = splitGrossAmount(grossCents);
  return {
    ok: true,
    value: {
      currency: PAYMENT_CURRENCY,
      pricePerPersonCents: price.value,
      guestCount: input.guestCount,
      grossCents,
      platformFeeCents,
      hostShareCents,
    },
  };
}

/** A safe, user-facing sentence for each error (no amounts or internals). */
export function getMoneyErrorMessage(error: MoneyError): string {
  switch (error) {
    case "price_below_minimum":
      return "This experience is priced below the €5 per person minimum, so it can't be paid for online.";
    case "invalid_guest_count":
      return "This booking's guest count isn't valid.";
    case "amount_too_large":
      return "This booking's total is too large to pay online. Please contact Felyn support.";
    case "unsupported_currency":
      return "This experience isn't priced in euros, so it can't be paid for online.";
    default:
      return "This booking's price isn't valid.";
  }
}
