import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_EVENT_TYPES, parsePayload, type EmailPayload } from "../src/lib/email/events";
import { renderBookingEmail } from "../src/lib/email/templates/booking-emails";
import { sanitizeSubject } from "../src/lib/email/templates/document";

const ITEM = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const CTA = `https://app.felyn.eu/bookings/${ITEM}`;

function payload(extra: Record<string, unknown> = {}): EmailPayload {
  const parsed = parsePayload({
    items: [
      { title: "Paella <Feast>", planned_date: "2030-06-01", planned_moment: "evening", preferred_time: "19:30", guest_count: 2, price_per_person: 40, currency: "EUR", host_display_name: "Maria" },
    ],
    guest_first_name: "Ana",
    stay_town: "Adeje",
    ...extra,
  });
  assert.ok(parsed);
  return parsed;
}

test("every event renders subject, html and text with the CTA", async () => {
  for (const type of EMAIL_EVENT_TYPES) {
    const email = await renderBookingEmail(type, payload({ cancellation_reason: "CHANGE_OF_PLANS" }), CTA);
    assert.ok(email.subject.length > 0, type);
    assert.ok(email.text.includes(CTA), type);
    assert.ok(email.html.includes(CTA), type);
    assert.ok(email.text.includes("Saturday, 1 June 2030"), type);
  }
});

test("request sent to the guest says it is NOT confirmed and keeps the time a preference", async () => {
  const email = await renderBookingEmail("request_created_guest", payload(), CTA);
  assert.match(email.text, /not a confirmation yet/);
  assert.match(email.text, /preferred time 19:30/);
  assert.equal(email.subject, "Request sent – awaiting the host");
  assert.match(email.text, /€80\.00/);
});

test("host emails show the guest's first name and town, never a price", async () => {
  const email = await renderBookingEmail("request_created_host", payload(), CTA);
  assert.match(email.text, /Ana/);
  assert.match(email.text, /Adeje/);
  assert.doesNotMatch(email.text, /€|Estimated price/);
});

test("cancellation emails state who cancelled", async () => {
  const byGuestToHost = await renderBookingEmail("booking_cancelled_by_guest_host", payload({ cancellation_reason: "CHANGE_OF_PLANS" }), CTA);
  assert.equal(byGuestToHost.subject, "Ana cancelled Paella <Feast>");
  assert.match(byGuestToHost.text, /Ana has cancelled/);
  assert.match(byGuestToHost.text, /Reason given: Change of plans/);

  const byHostToGuest = await renderBookingEmail("booking_cancelled_by_host_guest", payload({ cancellation_reason: "UNABLE_TO_PROVIDE_EXPERIENCE" }), CTA);
  assert.equal(byHostToGuest.subject, "Maria had to cancel Paella <Feast>");
  assert.match(byHostToGuest.text, /Maria has had to cancel/);

  const receipt = await renderBookingEmail("booking_cancelled_by_guest_guest", payload({ cancellation_reason: "CHANGE_OF_PLANS" }), CTA);
  assert.equal(receipt.subject, "Cancellation confirmed: Paella <Feast>");
  assert.match(receipt.text, /You have cancelled/);

  const hostReceipt = await renderBookingEmail("booking_cancelled_by_host_host", payload({ cancellation_reason: "UNABLE_TO_PROVIDE_EXPERIENCE" }), CTA);
  assert.equal(hostReceipt.subject, "Cancellation confirmed: Paella <Feast>");
  assert.match(hostReceipt.text, /You have cancelled this confirmed booking, and Ana has been informed/);
  assert.match(hostReceipt.text, /Reason given: /);
  assert.doesNotMatch(hostReceipt.text, /€|Estimated price/);

  const other = await renderBookingEmail("booking_cancelled_by_guest_host", payload({ cancellation_reason: "OTHER" }), CTA);
  assert.doesNotMatch(other.text, /Reason given/);
});

test("no ids in visible text apart from the CTA link, and user text is escaped in HTML", async () => {
  const email = await renderBookingEmail("request_confirmed_guest", payload(), CTA);
  assert.equal(email.text.split(ITEM).length - 1, 1);
  assert.ok(email.html.includes("Paella &lt;Feast&gt;"));
  assert.ok(!email.html.includes("<Feast>"));
});

test("subjects are single-line", () => {
  assert.equal(sanitizeSubject("New request:\r\nBcc: x@y.z"), "New request: Bcc: x@y.z");
  assert.ok(sanitizeSubject("x".repeat(400)).length <= 150);
});

test("subjects use the agreed wording", async () => {
  assert.equal((await renderBookingEmail("request_created_host", payload(), CTA)).subject, "New request: Paella <Feast>");
  assert.equal((await renderBookingEmail("request_confirmed_guest", payload(), CTA)).subject, "You're booked: Paella <Feast>");
  assert.equal((await renderBookingEmail("request_declined_guest", payload(), CTA)).subject, "About your Paella <Feast> request");
  const noNames = payload({ guest_first_name: null, items: [{ title: "Surf", planned_date: "2030-06-01", planned_moment: "morning", guest_count: 1 }] });
  assert.equal((await renderBookingEmail("booking_cancelled_by_guest_host", noNames, CTA)).subject, "A guest cancelled Surf");
  assert.equal((await renderBookingEmail("booking_cancelled_by_host_guest", noNames, CTA)).subject, "Your host had to cancel Surf");
});

test("html is the branded, email-safe layout", async () => {
  for (const type of EMAIL_EVENT_TYPES) {
    const { html } = await renderBookingEmail(type, payload({ cancellation_reason: "CHANGE_OF_PLANS" }), CTA);
    assert.match(html, /^<!DOCTYPE html/i, type);
    assert.ok(html.includes('Felyn<span style="color:#d9a441">.</span>'), type);
    assert.ok(html.includes("background-color:#16233d"), type); // navy primary button
    assert.ok(!html.includes("var(--") && !html.includes('class="'), type); // no CSS variables, no Tailwind classes
    assert.doesNotMatch(html, /<script/i, type);
  }
});
