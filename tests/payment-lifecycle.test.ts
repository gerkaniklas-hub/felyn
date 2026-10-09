import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { BookingItemStatus } from "../src/lib/matching/booking-status";
import {
  getGuestPaymentDisplayState,
  getHostTransferEligibility,
  parseCheckoutReturn,
  type HostTransferInput,
} from "../src/lib/payments/lifecycle";

const ALL_STATUSES: BookingItemStatus[] = [
  "REQUESTED",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "DECLINED",
  "WITHDRAWN",
  "CANCELLED",
  "PAYMENT_EXPIRED",
];

test("a Checkout success redirect never confirms a booking by itself", () => {
  assert.equal(getGuestPaymentDisplayState("AWAITING_PAYMENT", "success"), "processing");
  for (const status of ALL_STATUSES) {
    if (status === "CONFIRMED") continue;
    assert.notEqual(getGuestPaymentDisplayState(status, "success"), "confirmed", status);
  }
  // only the database status makes it confirmed, whatever the return said
  for (const checkoutReturn of ["success", "cancelled", null] as const) {
    assert.equal(getGuestPaymentDisplayState("CONFIRMED", checkoutReturn), "confirmed");
  }
});

test("guest payment states per booking status", () => {
  assert.equal(getGuestPaymentDisplayState("AWAITING_PAYMENT", null), "payment_required");
  assert.equal(getGuestPaymentDisplayState("AWAITING_PAYMENT", "cancelled"), "payment_not_completed");
  assert.equal(getGuestPaymentDisplayState("PAYMENT_EXPIRED", "success"), "payment_expired");
  assert.equal(getGuestPaymentDisplayState("REQUESTED", "success"), "not_payable");
  assert.equal(getGuestPaymentDisplayState("CANCELLED", null), "not_payable");
});

test("the checkout return parameter accepts only the two known values", () => {
  assert.equal(parseCheckoutReturn("success"), "success");
  assert.equal(parseCheckoutReturn("cancelled"), "cancelled");
  for (const value of [undefined, "", "SUCCESS", "paid", ["success"], "confirmed"]) {
    assert.equal(parseCheckoutReturn(value), null);
  }
});

test("exhaustively: only a CONFIRMED booking shows as confirmed, whatever Checkout's return says", () => {
  // Every status x every possible return value, including garbage a guest could type into the URL.
  for (const status of ALL_STATUSES) {
    for (const raw of ["success", "cancelled", undefined, "", "confirmed", "paid", ["success"], "success&status=CONFIRMED"]) {
      const shown = getGuestPaymentDisplayState(status, parseCheckoutReturn(raw));
      assert.equal(shown === "confirmed", status === "CONFIRMED", `${status} + ${JSON.stringify(raw)} -> ${shown}`);
    }
  }
});

const ELIGIBLE: HostTransferInput = {
  bookingStatus: "CONFIRMED",
  completedAt: "2026-10-18T00:01:00Z",
  transferReleasedAt: "2026-10-25T00:01:00Z",
  transferBlocked: false,
  paymentCaptured: true,
  hostShareCents: 30600,
  refundedCents: 0,
  disputed: false,
  transferAlreadyCreated: false,
};

test("a completed, released, captured, untouched booking is eligible for its host share", () => {
  assert.deepEqual(getHostTransferEligibility(ELIGIBLE), { eligible: true, amountCents: 30600 });
});

test("no host transfer before the experience is completed", () => {
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, completedAt: null, transferReleasedAt: null }), {
    eligible: false,
    reason: "not_completed",
  });
});

test("completion alone releases nothing: no transfer until the database's release gate has released it", () => {
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, transferReleasedAt: null }), { eligible: false, reason: "awaiting_release" });
  // a blocked transfer stays blocked even if it had been released before
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, transferBlocked: true }), { eligible: false, reason: "blocked" });
  // a release recorded on a booking that isn't completed (impossible in 0036) still isn't enough
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, completedAt: null }), { eligible: false, reason: "not_completed" });
});

test("captured payment alone is not enough; every other condition blocks the transfer", () => {
  for (const status of ALL_STATUSES.filter((s) => s !== "CONFIRMED")) {
    assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, bookingStatus: status }), { eligible: false, reason: "booking_not_confirmed" });
  }
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, paymentCaptured: false }), { eligible: false, reason: "payment_not_captured" });
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, refundedCents: 100 }), { eligible: false, reason: "refunded" });
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, disputed: true }), { eligible: false, reason: "disputed" });
  assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, transferAlreadyCreated: true }), { eligible: false, reason: "already_transferred" });
  for (const hostShareCents of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(getHostTransferEligibility({ ...ELIGIBLE, hostShareCents }), { eligible: false, reason: "invalid_amount" });
  }
});

test("the shared reasons are the database's own (0036 booking_payment_transfer_blocker)", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "supabase", "migrations", "0036_stripe_payments.sql"), "utf8");
  const blocker = sql.slice(sql.indexOf("create function public.booking_payment_transfer_blocker"), sql.indexOf("-- ── Stripe event deduplication"));
  const dbReasons = [...blocker.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
  // App-only reasons (payment_not_captured, invalid_amount): the database expresses
  // these through the payment status (confirmed implies captured) and its amount constraints.
  const shared = ["already_transferred", "booking_not_confirmed", "not_completed", "disputed", "refunded", "blocked", "awaiting_release"];
  for (const reason of shared) assert.ok(dbReasons.includes(reason), `database lacks ${reason}`);
  // ...in the same order
  assert.deepEqual(dbReasons.filter((r) => shared.includes(r)), shared);
});
