import type { SupabaseClient } from "@supabase/supabase-js";
import type { Occasion } from "./constants";
import type {
  Stay,
  StayDietaryRequirement,
  StayOccasion,
  StayPreferences,
} from "./types";

/**
 * Fetches a stay by id, scoped to the current user by RLS — a stay
 * belonging to someone else (or a bad id) simply comes back null, which
 * every onboarding page treats the same way: redirect to start over.
 */
export async function getStay(
  supabase: SupabaseClient,
  stayId: string,
): Promise<Stay | null> {
  const { data } = await supabase
    .from("stays")
    .select("*")
    .eq("id", stayId)
    .maybeSingle();
  return (data as Stay | null) ?? null;
}

export async function getStayOccasions(
  supabase: SupabaseClient,
  stayId: string,
): Promise<Occasion[]> {
  const { data } = await supabase
    .from("stay_occasions")
    .select("occasion")
    .eq("stay_id", stayId);
  return ((data as StayOccasion[] | null) ?? []).map((row) => row.occasion);
}

export async function getStayPreferences(
  supabase: SupabaseClient,
  stayId: string,
): Promise<StayPreferences | null> {
  const { data } = await supabase
    .from("stay_preferences")
    .select("*")
    .eq("stay_id", stayId)
    .maybeSingle();
  return (data as StayPreferences | null) ?? null;
}

export async function getStayDietaryRequirements(
  supabase: SupabaseClient,
  stayId: string,
): Promise<StayDietaryRequirement[]> {
  const { data } = await supabase
    .from("stay_dietary_requirements")
    .select("*")
    .eq("stay_id", stayId);
  return (data as StayDietaryRequirement[] | null) ?? [];
}
