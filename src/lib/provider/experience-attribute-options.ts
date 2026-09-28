import { OCCASIONS } from "@/lib/onboarding/constants";

/** Exactly the six values 0002's own check constraint allows on experience_attributes.attribute_type. */
export const ATTRIBUTE_TYPES = ["atmosphere", "setting", "style", "occasion", "specialty", "dietary"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export const ATTRIBUTE_TYPE_LABELS: Record<AttributeType, string> = {
  atmosphere: "Atmosphere",
  setting: "Setting",
  style: "Style",
  occasion: "Occasion",
  specialty: "Specialty",
  dietary: "Dietary",
};

/**
 * The ONLY four dietary tags satisfiesDietaryRequirements (filters.ts) will
 * ever match against a guest's stated dietary requirement — see
 * DIETARY_ATTRIBUTE_MAP there. A dietary attribute_value outside this exact
 * list is not a validation error (the DB doesn't constrain attribute_value
 * at all), but it would silently never match any guest's hard filter, so
 * the host UI deliberately offers ONLY these four as checkboxes rather than
 * free text for this one attribute_type.
 */
export const DIETARY_ATTRIBUTE_TAGS: { value: string; label: string }[] = [
  { value: "vegetarian-friendly", label: "Vegetarian-friendly" },
  { value: "vegan-friendly", label: "Vegan-friendly" },
  { value: "gluten-free-friendly", label: "Gluten-free-friendly" },
  { value: "dairy-free-friendly", label: "Dairy-free-friendly" },
];

/**
 * Every other attribute_type is a free-text "soft" signal only ever read by
 * soft-rank.ts's AI ranking (see SOFT_ATTRIBUTE_TYPES there) — there is no
 * fixed vocabulary to enforce. These suggested chips are pulled from the
 * values already in use by the seeded demo catalogue (0003), plus, for
 * "occasion" specifically, the SAME vocabulary already collected from
 * guests during onboarding (OCCASIONS) so a host's occasion tags actually
 * line up with what guests picked. A host can also add any custom value
 * beyond these suggestions.
 */
export const SUGGESTED_ATTRIBUTE_VALUES: Record<Exclude<AttributeType, "dietary">, string[]> = {
  atmosphere: ["celebratory", "intimate", "relaxed", "social"],
  setting: ["indoor", "outdoor"],
  style: ["educational", "family-style", "interactive", "premium"],
  occasion: OCCASIONS.map((o) => o.value),
  specialty: ["bbq", "mediterranean", "paella", "pasta", "seafood", "sushi", "tapas", "wine"],
};

/** Loose slug normalization for a host's custom (non-suggested) tag value. */
export function normalizeAttributeValue(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
