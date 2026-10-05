import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORT_ERROR_CODES } from "@/lib/support/constants";
import { getSupportErrorMessage } from "@/lib/support/errors";
import {
  getContactAgainHref,
  getSupportStatusNote,
  getSupportSubtitle,
  matchesSupportQuery,
  mergeByRecency,
  SUPPORT_RESOLVED_CAPTION,
} from "@/lib/support/inbox";

const ITEM = "11111111-1111-4111-8111-111111111111";

test("subtitle: topic for general help, topic and experience for a booking", () => {
  assert.equal(getSupportSubtitle({ category: "payment", bookingItemId: null, experienceTitle: null }), "Payment");
  assert.equal(
    getSupportSubtitle({ category: "booking", bookingItemId: ITEM, experienceTitle: "Dinner Experience" }),
    "Booking · Dinner Experience",
  );
  assert.equal(
    getSupportSubtitle({ category: "technical_issue", bookingItemId: ITEM, experienceTitle: null }),
    "Technical issue · Your booking",
  );
});

test("status words only where useful, never database values", () => {
  assert.equal(getSupportStatusNote("OPEN"), null);
  assert.equal(getSupportStatusNote("RESOLVED"), "Resolved");
  assert.equal(getSupportStatusNote("CLOSED"), "Closed");
  assert.match(SUPPORT_RESOLVED_CAPTION, /^Felyn Team marked this conversation as resolved\. Reply to reopen it\.$/);
});

test("Contact Felyn again starts a new conversation in the right place", () => {
  assert.equal(getContactAgainHref(null), "/help");
  assert.equal(getContactAgainHref(ITEM), `/bookings/${ITEM}?help=1`);
});

test("inbox search finds Felyn Team rows by name, topic and experience", () => {
  const row = { category: "cancellation" as const, experienceTitle: "Sunset Sailing" };
  assert.ok(matchesSupportQuery(row, ""));
  assert.ok(matchesSupportQuery(row, "felyn team"));
  assert.ok(matchesSupportQuery(row, "cancel"));
  assert.ok(matchesSupportQuery(row, "SUNSET"));
  assert.ok(!matchesSupportQuery(row, "maria"));
});

test("merge: newest first across both kinds, booking order preserved on ties", () => {
  const bookings = [
    { id: "b1", at: "2026-10-05T10:00:00Z" },
    { id: "b2", at: "2026-10-03T10:00:00Z" },
    { id: "b3", at: "" }, // no messages yet
  ];
  const support = [
    { id: "s1", at: "2026-10-04T10:00:00Z" },
    { id: "s2", at: "2026-10-06T10:00:00Z" },
  ];
  const merged = mergeByRecency(bookings, (b) => b.at, support, (s) => s.at);
  assert.deepEqual(
    merged.map((r) => `${r.kind}:${r.value.id}`),
    ["support:s2", "booking:b1", "support:s1", "booking:b2", "booking:b3"],
  );
  const onlyBookings = mergeByRecency(bookings, (b) => b.at, [] as typeof support, (s) => s.at);
  assert.deepEqual(onlyBookings.map((r) => r.value.id), ["b1", "b2", "b3"]);
});

test("database error codes become friendly messages; raw errors never pass through", () => {
  assert.match(getSupportErrorMessage(SUPPORT_ERROR_CODES.CLOSED, "send"), /closed/i);
  assert.equal(getSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_FOUND, "open"), "We couldn't find that booking on your account.");
  assert.equal(getSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_FOUND, "send"), "This conversation isn't available.");
  assert.match(getSupportErrorMessage(SUPPORT_ERROR_CODES.INVALID_INPUT, "open"), /2,000/);
  assert.match(getSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_ALLOWED, "open"), /sign in/i);
  for (const code of [undefined, null, "", "XX000", "PGRST202"]) {
    assert.match(getSupportErrorMessage(code, "open"), /^We couldn't send your message to Felyn\. Please try again\.$/);
  }
});
