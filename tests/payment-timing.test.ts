import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKOUT_EXPIRY_BEFORE_DUE_MS,
  CHECKOUT_EXPIRY_MARGIN_MS,
  MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS,
  MIN_TIME_TO_START_CHECKOUT_MS,
  STRIPE_CHECKOUT_MIN_EXPIRY_MS,
  calculatePaymentDueAtMs,
  getAcceptancePaymentWindow,
  getCheckoutWindow,
  getCheckoutWindowErrorMessage,
} from "../src/lib/payments/timing";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 17, 10, 0, 0); // a whole second

test("the buffers are the agreed values", () => {
  assert.equal(MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS, 60 * MIN);
  assert.equal(MIN_TIME_TO_START_CHECKOUT_MS, 41 * MIN);
  assert.equal(CHECKOUT_EXPIRY_BEFORE_DUE_MS, 10 * MIN);
  assert.equal(STRIPE_CHECKOUT_MIN_EXPIRY_MS, 30 * MIN);
  assert.equal(CHECKOUT_EXPIRY_MARGIN_MS, 1 * MIN);
  // even at the cutoff, the session expires a full minute clear of Stripe's minimum
  assert.equal(MIN_TIME_TO_START_CHECKOUT_MS - CHECKOUT_EXPIRY_BEFORE_DUE_MS, STRIPE_CHECKOUT_MIN_EXPIRY_MS + CHECKOUT_EXPIRY_MARGIN_MS);
  // the cutoff never exceeds the time a freshly accepted booking gets
  assert.ok(MIN_TIME_TO_START_CHECKOUT_MS < MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS);
});

test("payment_due_at follows 0035: the earlier of +24h and start - 2h", () => {
  assert.equal(calculatePaymentDueAtMs(NOW, NOW + 3 * 24 * HOUR), NOW + 24 * HOUR);
  assert.equal(calculatePaymentDueAtMs(NOW, NOW + 10 * HOUR), NOW + 8 * HOUR);
  assert.equal(calculatePaymentDueAtMs(NOW, NOW + 26 * HOUR), NOW + 24 * HOUR);
});

test("acceptance needs at least 60 minutes to pay: above, exactly at and below the threshold", () => {
  // start in 4h -> due in 2h
  assert.deepEqual(getAcceptancePaymentWindow(NOW, NOW + 4 * HOUR), { ok: true, paymentDueAtMs: NOW + 2 * HOUR });
  // start in 3h -> due in exactly 60 min: allowed
  assert.deepEqual(getAcceptancePaymentWindow(NOW, NOW + 3 * HOUR), { ok: true, paymentDueAtMs: NOW + HOUR });
  // one millisecond less: refused
  assert.deepEqual(getAcceptancePaymentWindow(NOW, NOW + 3 * HOUR - 1), {
    ok: false,
    error: "too_late_to_accept",
    paymentDueAtMs: NOW + HOUR - 1,
  });
  // the experience already started: refused
  assert.equal(getAcceptancePaymentWindow(NOW, NOW - HOUR).ok, false);
});

test("plenty of time: Checkout expires 10 minutes before the deadline", () => {
  const due = NOW + 8 * HOUR;
  assert.deepEqual(getCheckoutWindow(NOW, due), {
    ok: true,
    expiresAtMs: due - 10 * MIN,
    expiresAtUnixSeconds: (due - 10 * MIN) / 1000,
  });
});

test("exactly 41 minutes left: allowed, expiring 31 minutes out (a minute clear of Stripe's minimum)", () => {
  const result = getCheckoutWindow(NOW, NOW + 41 * MIN);
  assert.ok(result.ok);
  assert.equal(result.expiresAtMs, NOW + 31 * MIN);
  assert.equal(result.expiresAtMs - NOW, STRIPE_CHECKOUT_MIN_EXPIRY_MS + CHECKOUT_EXPIRY_MARGIN_MS);
});

test("under 41 minutes left: no new Checkout session (40 minutes, the old cutoff, included)", () => {
  assert.deepEqual(getCheckoutWindow(NOW, NOW + 41 * MIN - 1), { ok: false, error: "too_late_to_start_checkout" });
  assert.deepEqual(getCheckoutWindow(NOW, NOW + 40 * MIN), { ok: false, error: "too_late_to_start_checkout" });
  assert.deepEqual(getCheckoutWindow(NOW, NOW + 20 * MIN), { ok: false, error: "too_late_to_start_checkout" });
  assert.deepEqual(getCheckoutWindow(NOW, NOW + 1), { ok: false, error: "too_late_to_start_checkout" });
});

test("at or after the deadline: refused as passed", () => {
  assert.deepEqual(getCheckoutWindow(NOW, NOW), { ok: false, error: "payment_deadline_passed" });
  assert.deepEqual(getCheckoutWindow(NOW, NOW - HOUR), { ok: false, error: "payment_deadline_passed" });
});

test("expiry is rounded down to whole seconds and never under Stripe's minimum", () => {
  // a deadline with milliseconds (Postgres now() has microseconds)
  const due = NOW + 2 * HOUR + 999;
  const result = getCheckoutWindow(NOW, due);
  assert.ok(result.ok);
  assert.equal(result.expiresAtUnixSeconds, Math.floor((due - 10 * MIN) / 1000));
  assert.ok(result.expiresAtMs <= due - 10 * MIN);
  // at exactly 41 minutes with a sub-second "now", rounding down still leaves more
  // than Stripe's minimum (the margin absorbs it)
  const edge = getCheckoutWindow(NOW + 500, NOW + 500 + 41 * MIN);
  assert.ok(edge.ok);
  assert.ok(edge.expiresAtMs - (NOW + 500) > 30 * MIN);
  // every window from the cutoff up is allowed and satisfies Stripe's bounds with the margin
  for (let left = 41 * MIN; left <= 24 * HOUR; left += 7 * MIN + 123) {
    const window = getCheckoutWindow(NOW + 250, NOW + 250 + left);
    assert.ok(window.ok, `refused with ${left} ms left`);
    assert.ok(window.expiresAtMs - (NOW + 250) >= 30 * MIN + 59 * 1000);
    assert.ok(window.expiresAtMs - (NOW + 250) <= 24 * HOUR);
    assert.ok(window.expiresAtMs <= NOW + 250 + left - 10 * MIN);
  }
});

test("a deadline beyond 24h is capped at Stripe's 24-hour maximum", () => {
  const result = getCheckoutWindow(NOW, NOW + 30 * HOUR);
  assert.ok(result.ok);
  assert.equal(result.expiresAtMs, NOW + 24 * HOUR);
});

test("invalid instants are refused safely", () => {
  assert.deepEqual(getCheckoutWindow(Number.NaN, NOW), { ok: false, error: "invalid_time" });
  assert.deepEqual(getCheckoutWindow(NOW, Number.NaN), { ok: false, error: "invalid_time" });
  for (const error of ["invalid_time", "payment_deadline_passed", "too_late_to_start_checkout"] as const) {
    assert.ok(!getCheckoutWindowErrorMessage(error).includes("_"));
  }
});
