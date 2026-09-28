import type { DietaryType } from "@/lib/onboarding/constants";
import { satisfiesDietaryRequirements } from "./filters";
import type { ExperienceCategory, MatchedExperience } from "./hard-filter";

/**
 * Client-side marketplace filters layered on TOP of the M5.1 hard-filtered
 * pool the planner already has loaded — narrowing what's displayed, never
 * re-querying Supabase or calling OpenAI again (see StayPlanner). Budget
 * bounds are `null` until the guest touches the slider, meaning "no extra
 * cap" (the pool's own min/max — see getPriceBounds).
 */

export type DiscoveryDietaryOption = "vegetarian" | "vegan" | "gluten_free" | "dairy_free" | "allergies_other";

export const DISCOVERY_DIETARY_OPTIONS: { value: DiscoveryDietaryOption; label: string }[] = [
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "gluten_free", label: "Gluten-free" },
  { value: "dairy_free", label: "Dairy-free" },
  { value: "allergies_other", label: "Allergies / other" },
];

// "allergies_other" maps to BOTH unverifiable stay dietary types at once —
// same honesty rule as DIETARY_ATTRIBUTE_MAP in filters.ts: since neither
// has a matching experience_attributes tag, satisfiesDietaryRequirements
// always excludes every experience once this is selected, rather than
// guessing at compatibility Felyn has no data to back up.
const DIETARY_OPTION_REQUIREMENT_TYPES: Record<DiscoveryDietaryOption, DietaryType[]> = {
  vegetarian: ["vegetarian"],
  vegan: ["vegan"],
  gluten_free: ["gluten_free"],
  dairy_free: ["dairy_free"],
  allergies_other: ["allergy", "other"],
};

export type DiscoveryFiltersState = {
  /** null = the pool's own minimum (see getPriceBounds) — no extra floor set by the guest. */
  minBudget: number | null;
  /** null = the pool's own maximum — no extra ceiling set by the guest. */
  maxBudget: number | null;
  dietary: Set<DiscoveryDietaryOption>;
  experienceTypes: Set<ExperienceCategory>;
};

export function createDefaultDiscoveryFilters(): DiscoveryFiltersState {
  return { minBudget: null, maxBudget: null, dietary: new Set(), experienceTypes: new Set() };
}

export type PriceBounds = { min: number; max: number };

/** Derives the slider's min/max straight from the stay's own eligible pool — never invented. */
export function getPriceBounds(experiences: MatchedExperience[]): PriceBounds {
  if (experiences.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const experience of experiences) {
    if (experience.price_per_person < min) min = experience.price_per_person;
    if (experience.price_per_person > max) max = experience.price_per_person;
  }
  return { min, max };
}

export function experienceMatchesFilters(
  experience: MatchedExperience,
  filters: DiscoveryFiltersState,
  priceBounds: PriceBounds,
): boolean {
  const min = filters.minBudget ?? priceBounds.min;
  const max = filters.maxBudget ?? priceBounds.max;
  if (experience.price_per_person < min || experience.price_per_person > max) return false;

  if (filters.experienceTypes.size > 0 && !filters.experienceTypes.has(experience.category)) return false;

  if (filters.dietary.size > 0) {
    const requiredTypes = [...filters.dietary].flatMap((option) => DIETARY_OPTION_REQUIREMENT_TYPES[option]);
    const dietaryTags = experience.attributes
      .filter((attr) => attr.attribute_type === "dietary")
      .map((attr) => attr.attribute_value);
    if (!satisfiesDietaryRequirements(requiredTypes, dietaryTags)) return false;
  }

  return true;
}

export function isDiscoveryFiltersActive(filters: DiscoveryFiltersState, priceBounds: PriceBounds): boolean {
  return (
    filters.dietary.size > 0 ||
    filters.experienceTypes.size > 0 ||
    (filters.minBudget != null && filters.minBudget > priceBounds.min) ||
    (filters.maxBudget != null && filters.maxBudget < priceBounds.max)
  );
}

/** How many separate filter groups are narrowing results (budget counts as one) — for the "Filters · 2" button badge. */
export function countActiveFilters(filters: DiscoveryFiltersState, priceBounds: PriceBounds): number {
  const budgetActive =
    (filters.minBudget != null && filters.minBudget > priceBounds.min) ||
    (filters.maxBudget != null && filters.maxBudget < priceBounds.max);
  return (budgetActive ? 1 : 0) + filters.dietary.size + filters.experienceTypes.size;
}
