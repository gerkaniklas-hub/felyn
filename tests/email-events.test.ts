import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkEventStillCurrent,
  ctaPathFor,
  EMAIL_EVENT_TYPES,
  isExpired,
  MAX_ATTEMPTS,
  MAX_EVENT_AGE_MS,
  RESEND_IDEMPOTENCY_WINDOW_MS,
  parsePayload,
  recipientRoleFor,
  retryDelayMs,
  type CurrentBookingState,
} from "../src/lib/email/events";

const A = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const B = "4f1c2a9e-1b2c-4d5e-8f90-123456789abc";

function state(requestStatus: string, ...items: [string, string | null][]): CurrentBookingState {
  return {
    requestStatus,
    items: items.map(([status, cancelledBy], i) => ({ id: `i${i}`, status: status as never, cancelledBy: cancelledBy as never })),
  };
}

test("recipient role follows the event suffix (same rule as 0028)", () => {
  assert.deepEqual(
    EMAIL_EVENT_TYPES.map(recipientRoleFor),
    ["guest", "host", "guest", "guest", "host", "guest", "guest", "host"],
  );
});

test("status re-check: request created", () => {
  assert.equal(checkEventStillCurrent("request_created_guest", state("REQUESTED", ["REQUESTED", null])).current, true);
  assert.deepEqual(checkEventStillCurrent("request_created_guest", state("REQUESTED", ["WITHDRAWN", null])), {
    current: false,
    reason: "no_active_items",
  });
  assert.deepEqual(checkEventStillCurrent("request_created_guest", state("WITHDRAWN", ["REQUESTED", null])), {
    current: false,
    reason: "request_withdrawn",
  });
  assert.equal(checkEventStillCurrent("request_created_host", state("REQUESTED", ["CONFIRMED", null], ["REQUESTED", null])).current, true);
  assert.equal(checkEventStillCurrent("request_created_host", state("REQUESTED", ["CONFIRMED", null])).current, false);
});

test("status re-check: decisions and cancellation direction", () => {
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("REQUESTED", ["CONFIRMED", null])).current, true);
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("REQUESTED", ["CANCELLED", "provider"])).current, false);
  assert.equal(checkEventStillCurrent("request_declined_guest", state("REQUESTED", ["DECLINED", null])).current, true);
  assert.equal(checkEventStillCurrent("request_declined_guest", state("REQUESTED", ["CONFIRMED", null])).current, false);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_guest_host", state("REQUESTED", ["CANCELLED", "guest"])).current, true);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_guest_guest", state("REQUESTED", ["CANCELLED", "guest"])).current, true);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_guest_host", state("REQUESTED", ["CANCELLED", "provider"])).current, false);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_host_guest", state("REQUESTED", ["CANCELLED", "provider"])).current, true);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_host_guest", state("REQUESTED", ["CANCELLED", "guest"])).current, false);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_host_host", state("REQUESTED", ["CANCELLED", "provider"])).current, true);
  assert.equal(checkEventStillCurrent("booking_cancelled_by_host_host", state("REQUESTED", ["CANCELLED", "guest"])).current, false);
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("REQUESTED")).current, false);
});

test("CTA paths use existing routes and never invent one", () => {
  assert.equal(ctaPathFor("request_created_guest", [A]), `/bookings/${A}`);
  assert.equal(ctaPathFor("request_created_guest", [A, B]), "/experiences");
  assert.equal(ctaPathFor("request_confirmed_guest", [A]), `/bookings/${A}`);
  assert.equal(ctaPathFor("request_created_host", [A]), `/provider/requests/${A}`);
  assert.equal(ctaPathFor("request_created_host", [A, B]), "/provider/requests");
  assert.equal(ctaPathFor("booking_cancelled_by_guest_host", [A]), `/provider/requests/${A}`);
  assert.equal(ctaPathFor("booking_cancelled_by_host_guest", ["not-a-uuid/../x"]), "/experiences");
});

test("retry backoff grows and is bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelayMs), [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 10_800_000]);
});

test("events older than 23 hours expire", () => {
  assert.equal(MAX_EVENT_AGE_MS, 23 * 60 * 60 * 1000);
  const now = new Date("2030-01-03T00:00:00Z");
  const hours = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
  assert.equal(isExpired(hours(22), now), false);
  assert.equal(isExpired(hours(22.99), now), false);
  assert.equal(isExpired(hours(23.01), now), true);
  assert.equal(isExpired(hours(30), now), true);
  assert.equal(isExpired(new Date(now.getTime() - MAX_EVENT_AGE_MS + 1000).toISOString(), now), false);
  assert.equal(isExpired(new Date(now.getTime() - MAX_EVENT_AGE_MS - 1000).toISOString(), now), true);
  assert.equal(isExpired("not a date", now), true);
});

test("every attempt stays inside Resend's 24-hour idempotency window", () => {
  assert.ok(MAX_EVENT_AGE_MS < RESEND_IDEMPOTENCY_WINDOW_MS);
  // Worst case for a healthy system: every retry delay, plus a 10-minute lease
  // (0028 claim_email_outbox) and a 5-minute sweep interval before each attempt.
  let elapsed = 0;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) elapsed += retryDelayMs(attempt) + 10 * 60_000 + 5 * 60_000;
  assert.ok(elapsed < MAX_EVENT_AGE_MS, `retry schedule needs ${elapsed} ms`);
});

test("payload parsing accepts 0028's snapshot and rejects malformed rows", () => {
  const parsed = parsePayload({
    items: [
      { title: "Paella", planned_date: "2030-06-01", planned_moment: "evening", preferred_time: "19:30", guest_count: 2, price_per_person: 40, currency: "EUR", host_display_name: "Maria" },
    ],
    guest_first_name: "Ana",
    stay_town: "Adeje",
    cancellation_reason: "CHANGE_OF_PLANS",
  });
  assert.ok(parsed);
  assert.equal(parsed.items[0].preferredTime, "19:30");
  assert.equal(parsed.cancellationReason, "CHANGE_OF_PLANS");
  assert.equal(parsePayload({ items: [] }), null);
  assert.equal(parsePayload({ items: [{ title: "x", planned_date: "2030-06-01", planned_moment: "night", guest_count: 1 }] }), null);
  assert.equal(parsePayload(null), null);
  const hostView = parsePayload({ items: [{ title: "x", planned_date: "2030-06-01", planned_moment: "morning", guest_count: 1 }], cancellation_reason: "free text" });
  assert.ok(hostView);
  assert.equal(hostView.items[0].pricePerPerson, null);
  assert.equal(hostView.cancellationReason, null);
});
