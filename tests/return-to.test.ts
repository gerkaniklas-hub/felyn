import assert from "node:assert/strict";
import { test } from "node:test";
import { journeyForLoginDestination } from "../src/lib/journey";
import { safeReturnTo } from "../src/lib/return-to";

const ITEM = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

test("guest login accepts guest pages, including email CTA targets", () => {
  assert.equal(safeReturnTo(`/bookings/${ITEM}`, "guest"), `/bookings/${ITEM}`);
  assert.equal(safeReturnTo("/experiences", "guest"), "/experiences");
  assert.equal(safeReturnTo("/home", "guest"), "/home");
});

test("host login accepts provider pages, including email CTA targets", () => {
  assert.equal(safeReturnTo(`/provider/requests/${ITEM}`, "host"), `/provider/requests/${ITEM}`);
  assert.equal(safeReturnTo("/provider/requests", "host"), "/provider/requests");
  assert.equal(safeReturnTo("/provider", "host"), "/provider");
});

test("journeys stay separate", () => {
  assert.equal(safeReturnTo(`/provider/requests/${ITEM}`, "guest"), null);
  assert.equal(safeReturnTo(`/bookings/${ITEM}`, "host"), null);
  assert.equal(safeReturnTo("/host/apply", "host"), null);
  assert.equal(safeReturnTo("/providerx", "host"), null);
  assert.equal(safeReturnTo("/bookingsx/1", "guest"), null);
});

test("external, protocol-relative, encoded and traversal destinations are rejected", () => {
  const bad = [
    "https://evil.example/bookings/1",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "/bookings//evil.example",
    "/bookings/../provider",
    "/bookings/%2F%2Fevil.example",
    "/bookings/1?next=https://evil.example",
    "/bookings/1#frag",
    "/bookings/1:2",
    "javascript:alert(1)",
    " /bookings/1",
    "/bookings/1\n",
    "bookings/1",
    "/",
    "",
  ];
  for (const value of bad) assert.equal(safeReturnTo(value, "guest"), null, value);
  assert.equal(safeReturnTo("//evil.example/provider", "host"), null);
});

test("non-strings and over-long values are rejected", () => {
  assert.equal(safeReturnTo(undefined, "guest"), null);
  assert.equal(safeReturnTo(null, "guest"), null);
  assert.equal(safeReturnTo(["/bookings/1"], "guest"), null);
  assert.equal(safeReturnTo(`/bookings/${"a".repeat(200)}`, "guest"), null);
});

test("the journey cookie is still decided by the login's base destination", () => {
  assert.equal(journeyForLoginDestination("/home"), "guest");
  assert.equal(journeyForLoginDestination("/host/apply"), "host");
});
