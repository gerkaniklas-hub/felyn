import type { SupabaseClient } from "@supabase/supabase-js";
import type { Location } from "@/lib/locations";
import { todayISODate } from "@/lib/onboarding/stay-dates";
import type { ExperienceAttribute, ExperienceCategory, MatchedAvailability, MatchedExperience } from "./hard-filter";

/**
 * /explore: a lightweight, stay-independent list of every published
 * experience — no hard filter (group size/budget/dates/location) and no AI
 * ranking, just "what's on Felyn". Reuses the same guest-readable M4
 * tables/RLS policies as hard-filter.ts and provider-profile.ts.
 *
 * `availability` is loaded (the guest-readable experience_availability rows)
 * for the "Request experience" form; `service_location` only matters for
 * stay-based planning and is a harmless placeholder here.
 */
export async function getPublishedExperiences(supabase: SupabaseClient): Promise<MatchedExperience[]> {
  const { data: experienceRows } = await supabase
    .from("experiences")
    .select(
      "id, provider_id, title, short_description, description, category, cuisine, price_per_person, currency, min_guests, max_guests, duration_minutes",
    )
    .eq("published", true)
    .order("created_at", { ascending: false });

  type ExperienceRow = {
    id: string;
    provider_id: string;
    title: string;
    short_description: string | null;
    description: string | null;
    category: ExperienceCategory;
    cuisine: string | null;
    price_per_person: number;
    currency: string;
    min_guests: number;
    max_guests: number;
    duration_minutes: number;
  };
  const experiences = (experienceRows as ExperienceRow[] | null) ?? [];
  if (experiences.length === 0) return [];

  const experienceIds = experiences.map((exp) => exp.id);
  const providerIds = [...new Set(experiences.map((exp) => exp.provider_id))];

  const [attributesRes, galleryRes, providersRes, languagesRes, availabilityRes] = await Promise.all([
    supabase
      .from("experience_attributes")
      .select("experience_id, attribute_type, attribute_value")
      .in("experience_id", experienceIds),
    supabase
      .from("experience_gallery")
      .select("experience_id, image_url, caption, sort_order")
      .in("experience_id", experienceIds)
      .order("sort_order", { ascending: true }),
    supabase
      .from("provider_public_profiles")
      .select("id, display_name, profile_photo_url, bio, base_location")
      .in("id", providerIds),
    supabase.from("provider_languages").select("provider_id, language").in("provider_id", providerIds),
    // For "Request experience": which dates and times of day can be requested (slot-availability.ts).
    supabase
      .from("experience_availability")
      .select("experience_id, available_from, available_until, start_time, end_time, max_bookings")
      .in("experience_id", experienceIds),
  ]);

  type AttributeRow = { experience_id: string; attribute_type: string; attribute_value: string };
  type GalleryRow = { experience_id: string; image_url: string; caption: string | null; sort_order: number };
  type ProviderRow = {
    id: string;
    display_name: string;
    profile_photo_url: string | null;
    bio: string | null;
    base_location: string | null;
  };
  type LanguageRow = { provider_id: string; language: string };
  type AvailabilityRow = MatchedAvailability & { experience_id: string };
  const availabilityByExperience = new Map<string, MatchedAvailability[]>();
  for (const row of (availabilityRes.data as AvailabilityRow[] | null) ?? []) {
    const { experience_id: experienceId, ...window } = row;
    const list = availabilityByExperience.get(experienceId) ?? [];
    list.push(window);
    availabilityByExperience.set(experienceId, list);
  }

  const attributesByExperience = new Map<string, ExperienceAttribute[]>();
  for (const row of (attributesRes.data as AttributeRow[] | null) ?? []) {
    const list = attributesByExperience.get(row.experience_id) ?? [];
    list.push({ attribute_type: row.attribute_type, attribute_value: row.attribute_value });
    attributesByExperience.set(row.experience_id, list);
  }

  // Rows arrive ordered by sort_order, so the first one seen per experience
  // is its primary image (same convention as hard-filter.ts). Grouped here
  // (rather than reduced to just the primary) so the full gallery is
  // available too, e.g. for the guest-facing detail gallery.
  const galleryByExperience = new Map<string, { image_url: string; caption: string | null }[]>();
  for (const row of (galleryRes.data as GalleryRow[] | null) ?? []) {
    const list = galleryByExperience.get(row.experience_id) ?? [];
    list.push({ image_url: row.image_url, caption: row.caption });
    galleryByExperience.set(row.experience_id, list);
  }

  const providerById = new Map(
    ((providersRes.data as ProviderRow[] | null) ?? []).map((row) => [row.id, row]),
  );

  const languagesByProvider = new Map<string, string[]>();
  for (const row of (languagesRes.data as LanguageRow[] | null) ?? []) {
    const list = languagesByProvider.get(row.provider_id) ?? [];
    list.push(row.language);
    languagesByProvider.set(row.provider_id, list);
  }

  const results: MatchedExperience[] = [];
  for (const exp of experiences) {
    const provider = providerById.get(exp.provider_id);
    if (!provider) continue; // no public profile visible -> can't safely surface this experience

    const gallery = galleryByExperience.get(exp.id) ?? [];

    results.push({
      id: exp.id,
      provider_id: exp.provider_id,
      title: exp.title,
      short_description: exp.short_description,
      description: exp.description,
      category: exp.category,
      cuisine: exp.cuisine,
      price_per_person: exp.price_per_person,
      currency: exp.currency,
      min_guests: exp.min_guests,
      max_guests: exp.max_guests,
      duration_minutes: exp.duration_minutes,
      image_url: gallery[0]?.image_url ?? null,
      gallery,
      attributes: attributesByExperience.get(exp.id) ?? [],
      provider: {
        id: provider.id,
        display_name: provider.display_name,
        profile_photo_url: provider.profile_photo_url,
        bio: provider.bio,
        base_location: provider.base_location,
        languages: languagesByProvider.get(exp.provider_id) ?? [],
      },
      service_location: { location_text: provider.base_location ?? "", is_current: true },
      availability: availabilityByExperience.get(exp.id) ?? [],
    });
  }

  return results;
}

/**
 * Explore's location search: every service-area text each provider has
 * (service_locations.location_text, any date range), keyed by provider id.
 * Read through the existing "Guests read service locations of published
 * providers" RLS policy (0002), the same table the stay matcher uses
 * (hard-filter.ts). Free text only: no geocoding. A failed read just means
 * location search falls back to each provider's base_location.
 */
export async function getProviderServiceLocationTexts(
  supabase: SupabaseClient,
  providerIds: string[],
): Promise<Record<string, string[]>> {
  if (providerIds.length === 0) return {};
  const { data } = await supabase
    .from("service_locations")
    .select("provider_id, location_text")
    .in("provider_id", providerIds);

  const byProvider: Record<string, string[]> = {};
  for (const row of (data as { provider_id: string; location_text: string }[] | null) ?? []) {
    (byProvider[row.provider_id] ??= []).push(row.location_text);
  }
  return byProvider;
}

/**
 * Explore's location picker options: Felyn's canonical locations
 * (public.locations, migration 0024), readable by any signed-in user via
 * the "Signed-in users read canonical locations" RLS policy. Shaped for
 * lib/locations.ts. A failed read returns an empty list: the picker then
 * simply offers no places and every other Explore filter keeps working.
 */
export async function getCanonicalLocations(supabase: SupabaseClient): Promise<Location[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, parent_id, region, country, aliases")
    .order("name", { ascending: true });
  if (error) {
    console.error(`explore: locations read failed (code ${error.code ?? "unknown"})`);
    return [];
  }
  type LocationRow = {
    id: string;
    name: string;
    parent_id: string | null;
    region: string | null;
    country: string;
    aliases: string[] | null;
  };
  return ((data as LocationRow[] | null) ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    region: row.region,
    country: row.country,
    aliases: row.aliases ?? [],
  }));
}

/** One of the guest's own stays, for the optional "Add to a trip" choice when requesting an experience. */
export type GuestStayOption = { id: string; name: string; checkIn: string; checkOut: string; guestCount: number };

/**
 * The signed-in guest's own current and upcoming stays, for the "Add to my
 * trip" choice in the Request experience form. RLS ("Users manage their own
 * stays") already limits this to their rows; the explicit user filter is the
 * usual belt-and-braces. Only completed stays, as everywhere else.
 */
export async function getGuestStayOptions(supabase: SupabaseClient): Promise<GuestStayOption[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from("stays")
    .select("id, property_name, check_in, check_out, guest_count")
    .eq("user_id", user.id)
    .not("onboarding_completed_at", "is", null)
    .gte("check_out", todayISODate())
    .order("check_in", { ascending: true });
  type StayRow = { id: string; property_name: string; check_in: string; check_out: string; guest_count: number };
  return ((data as StayRow[] | null) ?? []).map((row) => ({
    id: row.id,
    name: row.property_name,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guestCount: row.guest_count,
  }));
}
