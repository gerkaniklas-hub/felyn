/**
 * Minimal validation for the M5.1 hard-filter predicates in filters.ts.
 *
 * Uses Node's built-in test runner (`node --test`) — no new dependency, no
 * bundler needed. Run with:
 *   node --test src/lib/matching/filters.test.mjs
 *
 * Plain .mjs (not .ts) on purpose: Node's ESM loader requires an explicit
 * file extension on relative imports, but this project's tsconfig
 * (moduleResolution "bundler") doesn't allow importing with a literal ".ts"
 * extension. Since tsconfig's `include` only matches .ts/.tsx/.mts, a plain
 * .mjs file sits outside TypeScript's project scope entirely, so it can
 * import "./filters.ts" directly without conflicting with `tsc --noEmit`.
 *
 * These are pure-function tests only. They deliberately do NOT hit a live
 * Supabase project: the guest-read RLS policies from 0002 require a real
 * signed-in `auth.uid()` session, which a standalone script has no way to
 * establish outside of a real request/cookie context. Instead, the fixture
 * values below are copied directly from the actual M4b demo seed
 * (0003_seed_demo_experiences.sql) — Maria's "Sunset Seafood Dinner" and
 * "Canarian Tapas & Mojo Night", and Lucas's temporary Ibiza service
 * location — so this proves the filter logic behaves correctly against the
 * real demo data's real values, just without the network round trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityOverlapsStay,
  groupSizeFits,
  locationTextMatches,
  priceFitsBudget,
  satisfiesDietaryRequirements,
  serviceLocationActiveDuring,
} from "./filters.ts";

// Fixtures pulled straight from 0003_seed_demo_experiences.sql.
const SUNSET_SEAFOOD_DINNER = {
  minGuests: 2,
  maxGuests: 8,
  pricePerPerson: 65.0,
  dietaryTags: ["pescatarian-friendly"],
  availableFrom: "2026-10-01",
  availableUntil: "2027-06-30",
};

const CANARIAN_TAPAS_NIGHT = {
  dietaryTags: ["vegetarian-friendly"],
};

const MARIA_SERVICE_LOCATION = "Costa Adeje & Los Cristianos, Tenerife";
const LUCAS_IBIZA_SERVICE_LOCATION = {
  text: "Ibiza, Spain (summer season)",
  startsAt: "2027-06-01",
  endsAt: "2027-09-15",
};

test("groupSizeFits: guest count within/outside min-max", () => {
  assert.equal(groupSizeFits(SUNSET_SEAFOOD_DINNER.minGuests, SUNSET_SEAFOOD_DINNER.maxGuests, 4), true);
  assert.equal(groupSizeFits(SUNSET_SEAFOOD_DINNER.minGuests, SUNSET_SEAFOOD_DINNER.maxGuests, 2), true);
  assert.equal(groupSizeFits(SUNSET_SEAFOOD_DINNER.minGuests, SUNSET_SEAFOOD_DINNER.maxGuests, 8), true);
  assert.equal(groupSizeFits(SUNSET_SEAFOOD_DINNER.minGuests, SUNSET_SEAFOOD_DINNER.maxGuests, 10), false);
  assert.equal(groupSizeFits(SUNSET_SEAFOOD_DINNER.minGuests, SUNSET_SEAFOOD_DINNER.maxGuests, 1), false);
});

test("priceFitsBudget: fixed range includes/excludes, flexible always includes", () => {
  const price = SUNSET_SEAFOOD_DINNER.pricePerPerson; // 65.00
  assert.equal(priceFitsBudget(price, 50, 75, false), true);
  assert.equal(priceFitsBudget(price, 30, 50, false), false); // too expensive for this bracket
  assert.equal(priceFitsBudget(price, 150, null, false), false); // "150+" bracket, price too low
  assert.equal(priceFitsBudget(price, null, null, true), true); // flexible never excludes
  assert.equal(priceFitsBudget(price, 150, null, true), true); // flexible overrides stale bounds too
});

test("availabilityOverlapsStay: date-range overlap against the real availability window", () => {
  const { availableFrom, availableUntil } = SUNSET_SEAFOOD_DINNER;
  assert.equal(availabilityOverlapsStay(availableFrom, availableUntil, "2026-11-01", "2026-11-08"), true);
  assert.equal(availabilityOverlapsStay(availableFrom, availableUntil, "2026-09-20", "2026-10-05"), true); // straddles start
  assert.equal(availabilityOverlapsStay(availableFrom, availableUntil, "2027-07-01", "2027-07-05"), false); // entirely after
  assert.equal(availabilityOverlapsStay(availableFrom, availableUntil, "2026-08-01", "2026-09-30"), false); // entirely before
});

test("serviceLocationActiveDuring: ongoing vs. Lucas's temporary Ibiza window", () => {
  // Ongoing base location (no bounds) is always active.
  assert.equal(serviceLocationActiveDuring(null, null, "2026-11-01", "2026-11-08"), true);
  // Lucas's Ibiza listing is only active June-Sept 2027.
  const { startsAt, endsAt } = LUCAS_IBIZA_SERVICE_LOCATION;
  assert.equal(serviceLocationActiveDuring(startsAt, endsAt, "2027-07-01", "2027-07-10"), true);
  assert.equal(serviceLocationActiveDuring(startsAt, endsAt, "2026-11-01", "2026-11-08"), false);
});

test("locationTextMatches: shared meaningful word, e.g. Tenerife", () => {
  assert.equal(locationTextMatches(MARIA_SERVICE_LOCATION, "Tenerife"), true);
  assert.equal(locationTextMatches(MARIA_SERVICE_LOCATION, "A villa near Costa Adeje, Tenerife"), true);
  assert.equal(locationTextMatches(MARIA_SERVICE_LOCATION, "Ibiza"), false);
  assert.equal(locationTextMatches(LUCAS_IBIZA_SERVICE_LOCATION.text, "Ibiza Town, Spain"), true);
});

test("satisfiesDietaryRequirements: verifiable types respected, unverifiable types never pass", () => {
  // No requirements -> always compatible.
  assert.equal(satisfiesDietaryRequirements([], SUNSET_SEAFOOD_DINNER.dietaryTags), true);

  // Vegetarian requirement against a pescatarian-only experience -> excluded.
  assert.equal(satisfiesDietaryRequirements(["vegetarian"], SUNSET_SEAFOOD_DINNER.dietaryTags), false);

  // Vegetarian requirement against an experience actually tagged for it -> included.
  assert.equal(satisfiesDietaryRequirements(["vegetarian"], CANARIAN_TAPAS_NIGHT.dietaryTags), true);

  // 'allergy'/'other' have no attribute vocabulary to verify against — must
  // never be falsely marked compatible, even if some dietary tag is present.
  assert.equal(satisfiesDietaryRequirements(["allergy"], SUNSET_SEAFOOD_DINNER.dietaryTags), false);
  assert.equal(satisfiesDietaryRequirements(["other"], CANARIAN_TAPAS_NIGHT.dietaryTags), false);

  // Multiple requirements: every one must be independently verified.
  assert.equal(
    satisfiesDietaryRequirements(["vegetarian", "vegan"], ["vegetarian-friendly"]),
    false, // vegan not verified
  );
  assert.equal(
    satisfiesDietaryRequirements(["vegetarian", "vegan"], ["vegetarian-friendly", "vegan-friendly"]),
    true,
  );
});
