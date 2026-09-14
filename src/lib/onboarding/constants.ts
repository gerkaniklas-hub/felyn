export type Occasion =
  | "birthday"
  | "anniversary"
  | "family_trip"
  | "friends_getaway"
  | "couples_trip"
  | "wedding"
  | "team_trip"
  | "reunion"
  | "getting_away"
  | "other";

export const OCCASIONS: { value: Occasion; label: string }[] = [
  { value: "birthday", label: "Birthday" },
  { value: "anniversary", label: "Anniversary" },
  { value: "family_trip", label: "Family trip" },
  { value: "friends_getaway", label: "Friends' getaway" },
  { value: "couples_trip", label: "Couples' trip" },
  { value: "wedding", label: "Wedding / pre-wedding" },
  { value: "team_trip", label: "Team / work trip" },
  { value: "reunion", label: "Reunion" },
  { value: "getting_away", label: "Just getting away" },
  { value: "other", label: "Other" },
];

export type DietaryType =
  | "vegetarian"
  | "vegan"
  | "gluten_free"
  | "dairy_free"
  | "allergy"
  | "other";

export const DIETARY_TYPES: { value: DietaryType; label: string }[] = [
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "gluten_free", label: "Gluten-free" },
  { value: "dairy_free", label: "Dairy-free" },
  { value: "allergy", label: "Allergies" },
  { value: "other", label: "Other" },
];

/** Dietary types that ask for free-text detail alongside the guest count. */
export const DIETARY_TYPES_WITH_NOTES: DietaryType[] = ["allergy", "other"];

export type BudgetOption = {
  value: string;
  label: string;
  min: number | null;
  max: number | null;
  flexible: boolean;
};

export const BUDGET_OPTIONS: BudgetOption[] = [
  { value: "30-50", label: "€30–50 per person", min: 30, max: 50, flexible: false },
  { value: "50-75", label: "€50–75 per person", min: 50, max: 75, flexible: false },
  { value: "75-100", label: "€75–100 per person", min: 75, max: 100, flexible: false },
  { value: "100-150", label: "€100–150 per person", min: 100, max: 150, flexible: false },
  { value: "150+", label: "€150+ per person", min: 150, max: null, flexible: false },
  { value: "flexible", label: "I'm flexible", min: null, max: null, flexible: true },
];
