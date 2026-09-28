import type { DietaryType, Occasion } from "./constants";

export type Stay = {
  id: string;
  user_id: string;
  property_name: string;
  location_text: string;
  check_in: string;
  check_out: string;
  guest_count: number;
  source: "manual" | "upload" | "import_stub";
  budget_min: number | null;
  budget_max: number | null;
  budget_flexible: boolean;
  // M6.5: structured location fields — null until a geocoding provider is
  // configured and actually verifies location_text. Never invented/backfilled.
  formatted_address: string | null;
  locality: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StayOccasion = {
  id: string;
  stay_id: string;
  occasion: Occasion;
};

export type StayPreferences = {
  id: string;
  stay_id: string;
  raw_text: string | null;
};

export type StayDietaryRequirement = {
  id: string;
  stay_id: string;
  type: DietaryType;
  guest_count: number | null;
  notes: string | null;
};
