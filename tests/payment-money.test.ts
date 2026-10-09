import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_PRICE_PER_PERSON_CENTS,
  STRIPE_MAX_AMOUNT_CENTS,
  calculateBookingAmounts,
  calculatePlatformFeeCents,
  getMoneyErrorMessage,
  priceToCents,
  splitGrossAmount,
} from "../src/lib/payments/money";

const EUR = "EUR";

test("database prices become whole cents without float arithmetic", () => {
  assert.deepEqual(priceToCents("85.00"), { ok: true, value: 8500 });
  assert.deepEqual(priceToCents("19.9"), { ok: true, value: 1990 });
  assert.deepEqual(priceToCents("5"), { ok: true, value: 500 });
  assert.deepEqual(priceToCents(85.5), { ok: true, value: 8550 });
  // 0.1 + 0.2 style values: read from their decimal text, never multiplied
  assert.deepEqual(priceToCents(19.99), { ok: true, value: 1999 });
  assert.deepEqual(priceToCents(" 12.34 "), { ok: true, value: 1234 });
  assert.deepEqual(priceToCents("99999999.99"), { ok: true, value: 9_999_999_999 });
});

test("malformed prices are rejected", () => {
  for (const bad of ["", "-5.00", "5.001", "1e3", "abc", "5,00", ".50", "5.", "123456789.00", Number.NaN, Infinity, -1, 1e21]) {
    assert.deepEqual(priceToCents(bad as string | number), { ok: false, error: "invalid_price" }, String(bad));
  }
});

test("fee is exactly 10% when the gross is a multiple of 10 cents", () => {
  assert.deepEqual(splitGrossAmount(34000), { platformFeeCents: 3400, hostShareCents: 30600 });
  assert.deepEqual(splitGrossAmount(500), { platformFeeCents: 50, hostShareCents: 450 });
  assert.deepEqual(splitGrossAmount(0), { platformFeeCents: 0, hostShareCents: 0 });
});

test("fractional-cent fees round to the nearest cent, an exact half rounding up", () => {
  // 10% of 1001..1009 cents = 100.1 .. 100.9
  const fees = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009].map(calculatePlatformFeeCents);
  assert.deepEqual(fees, [100, 100, 100, 100, 101, 101, 101, 101, 101]);
  assert.equal(calculatePlatformFeeCents(5), 1); // 0.5 -> 1
  assert.equal(calculatePlatformFeeCents(4), 0); // 0.4 -> 0
  assert.equal(calculatePlatformFeeCents(1995), 200); // 199.5 -> 200
  assert.equal(calculatePlatformFeeCents(STRIPE_MAX_AMOUNT_CENTS), 10_000_000); // 9999999.9 -> 10000000
});

test("fee + host share always equals the gross amount", () => {
  for (let gross = 0; gross <= 20000; gross += 1) {
    const { platformFeeCents, hostShareCents } = splitGrossAmount(gross);
    assert.equal(platformFeeCents + hostShareCents, gross);
    assert.ok(Number.isSafeInteger(platformFeeCents) && Number.isSafeInteger(hostShareCents));
    // never further than half a cent from exactly 10%
    assert.ok(Math.abs(platformFeeCents * 10 - gross) <= 5, `gross ${gross}`);
  }
});

test("the fee function refuses non-integer or negative cents", () => {
  for (const bad of [-1, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculatePlatformFeeCents(bad), RangeError);
  }
});

test("booking amounts: price per person x guest count, then the split", () => {
  assert.deepEqual(calculateBookingAmounts({ pricePerPerson: "85.00", guestCount: 4, currency: EUR }), {
    ok: true,
    value: { currency: "EUR", pricePerPersonCents: 8500, guestCount: 4, grossCents: 34000, platformFeeCents: 3400, hostShareCents: 30600 },
  });
  // a fractional-cent fee: 3 x 33.35 = 100.05 -> fee 10.005 -> 10.01
  const odd = calculateBookingAmounts({ pricePerPerson: "33.35", guestCount: 3, currency: "eur" });
  assert.ok(odd.ok);
  assert.equal(odd.value.grossCents, 10005);
  assert.equal(odd.value.platformFeeCents, 1001);
  assert.equal(odd.value.hostShareCents, 9004);
});

test("the €5 per person minimum: exactly €5 is allowed, a cent less is not", () => {
  assert.equal(MIN_PRICE_PER_PERSON_CENTS, 500);
  const atMinimum = calculateBookingAmounts({ pricePerPerson: "5.00", guestCount: 1, currency: EUR });
  assert.ok(atMinimum.ok);
  assert.equal(atMinimum.value.grossCents, 500);
  for (const price of ["4.99", "0", "0.00", 0]) {
    assert.deepEqual(calculateBookingAmounts({ pricePerPerson: price, guestCount: 10, currency: EUR }), {
      ok: false,
      error: "price_below_minimum",
    });
  }
});

test("invalid guest counts are rejected", () => {
  for (const guestCount of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.deepEqual(calculateBookingAmounts({ pricePerPerson: "50.00", guestCount, currency: EUR }), {
      ok: false,
      error: "invalid_guest_count",
    });
  }
});

test("only euros are accepted", () => {
  assert.deepEqual(calculateBookingAmounts({ pricePerPerson: "50.00", guestCount: 2, currency: "USD" }), {
    ok: false,
    error: "unsupported_currency",
  });
});

test("a gross amount above Stripe's maximum is refused; exactly the maximum is allowed", () => {
  assert.deepEqual(calculateBookingAmounts({ pricePerPerson: "999999.99", guestCount: 2, currency: EUR }), {
    ok: false,
    error: "amount_too_large",
  });
  const max = calculateBookingAmounts({ pricePerPerson: "999999.99", guestCount: 1, currency: EUR });
  assert.ok(max.ok);
  assert.equal(max.value.grossCents, STRIPE_MAX_AMOUNT_CENTS);
});

test("error messages are user-safe sentences", () => {
  for (const error of ["invalid_price", "price_below_minimum", "invalid_guest_count", "amount_too_large", "unsupported_currency"] as const) {
    const message = getMoneyErrorMessage(error);
    assert.ok(message.length > 10 && !message.includes("_"), error);
  }
});
