import type { SupabaseClient } from "@supabase/supabase-js";

export type ProviderServiceLocation = {
  id: string;
  locationText: string;
};

/**
 * Stage 5 (planner discovery fix): the signed-in provider's own CURRENT
 * service location, if any. getHardFilteredExperiences (the planner's hard
 * filter) requires a service_locations row — active during the guest's
 * stay and sharing a meaningful word with the stay's location text — for
 * EVERY one of a provider's experiences to ever appear there; getPublishedExperiences
 * (Explore) has no such requirement, which is why a published experience
 * can show in Explore yet never appear in the planner. This table (0002)
 * already has full owner RLS ("Providers manage their own service
 * locations") — no migration needed, only a UI to actually write to it,
 * which never existed anywhere in the app until now.
 */
export async function getProviderServiceLocation(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ProviderServiceLocation | null> {
  const { data } = await supabase
    .from("service_locations")
    .select("id, location_text")
    .eq("provider_id", providerId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as { id: string; location_text: string } | null;
  return row ? { id: row.id, locationText: row.location_text } : null;
}
