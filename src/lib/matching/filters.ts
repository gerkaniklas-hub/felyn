/**
 * Pure, dependency-free predicates behind the M5.1 hard filter. Kept free of
 * Supabase/Next imports (relative imports only) so this file — and its
 * companion filters.test.ts — can run standalone with plain `node`, no
 * bundler/tsconfig path resolution or live database/auth session required.
 */

export function groupSizeFits(
  minGuests: number,
  maxGuests: number,
  guestCount: number,
): boolean {
  return guestCount >= minGuests && guestCount <= maxGuests;
}

export function priceFitsBudget(
  pricePerPerson: number,
  budgetMin: number | null,
  budgetMax: number | null,
  budgetFlexible: boolean,
): boolean {
  // A flexible budget must never exclude an experience.
  if (budgetFlexible) return true;
  if (budgetMin != null && pricePerPerson < budgetMin) return false;
  if (budgetMax != null && pricePerPerson > budgetMax) return false;
  return true;
}

/** Date-range overlap for `available_from`/`available_until` vs. stay dates. All dates are 'YYYY-MM-DD' strings, which compare correctly with plain string comparison. */
export function availabilityOverlapsStay(
  availableFrom: string,
  availableUntil: string,
  checkIn: string,
  checkOut: string,
): boolean {
  return availableFrom <= checkOut && availableUntil >= checkIn;
}

/**
 * Whether a provider's service_locations row is active at any point during
 * the stay. Null starts_at/ends_at means "no bound on that side" (an
 * ongoing/base location), per the M4 schema's own comments.
 */
export function serviceLocationActiveDuring(
  startsAt: string | null,
  endsAt: string | null,
  checkIn: string,
  checkOut: string,
): boolean {
  if (startsAt != null && startsAt > checkOut) return false;
  if (endsAt != null && endsAt < checkIn) return false;
  return true;
}

const LOCATION_TOKEN_MIN_LENGTH = 4;

function locationTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= LOCATION_TOKEN_MIN_LENGTH),
  );
}

/**
 * Intentionally simple MVP location match: both `service_locations
 * .location_text` and `stays.location_text` are free text (no geocoding
 * exists yet), so this checks for a shared, meaningful word (e.g.
 * "Tenerife") rather than exact equality. Good enough per M4's "do not
 * over-engineer geographic functionality yet" — not a substitute for real
 * geo-matching later.
 */
export function locationTextMatches(
  serviceLocationText: string,
  stayLocationText: string,
): boolean {
  const serviceTokens = locationTokens(serviceLocationText);
  const stayTokens = locationTokens(stayLocationText);
  for (const token of serviceTokens) {
    if (stayTokens.has(token)) return true;
  }
  return false;
}

/**
 * Maps a stay's dietary requirement type to the experience_attributes
 * 'dietary' value that would satisfy it. Deliberately omits 'allergy' and
 * 'other': the M4b demo vocabulary has no attribute that can verify either
 * one, and we must never invent that data or assume compatibility.
 */
export const DIETARY_ATTRIBUTE_MAP: Record<string, string> = {
  vegetarian: "vegetarian-friendly",
  vegan: "vegan-friendly",
  gluten_free: "gluten-free-friendly",
  dairy_free: "dairy-free-friendly",
};

/**
 * True only if every required dietary type has a matching 'dietary'
 * attribute tag on the experience. A requirement type with no entry in
 * DIETARY_ATTRIBUTE_MAP (unverifiable from existing data) always fails
 * this check — the experience is excluded rather than falsely marked
 * compatible.
 */
export function satisfiesDietaryRequirements(
  requiredTypes: readonly string[],
  experienceDietaryTags: readonly string[],
): boolean {
  if (requiredTypes.length === 0) return true;
  const tags = new Set(experienceDietaryTags);
  return requiredTypes.every((type) => {
    const requiredTag = DIETARY_ATTRIBUTE_MAP[type];
    if (!requiredTag) return false;
    return tags.has(requiredTag);
  });
}
