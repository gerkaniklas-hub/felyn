import type { SupabaseClient } from "@supabase/supabase-js";
import { getStay, getStayDietaryRequirements } from "@/lib/onboarding/queries";
import {
  availabilityOverlapsStay,
  groupSizeFits,
  locationTextMatches,
  priceFitsBudget,
  satisfiesDietaryRequirements,
  serviceLocationActiveDuring,
} from "./filters";

export type ExperienceCategory = "food" | "drink" | "food_drink";

export type ExperienceAttribute = {
  attribute_type: string;
  attribute_value: string;
};

export type MatchedProvider = {
  id: string;
  display_name: string;
  profile_photo_url: string | null;
  bio: string | null;
  base_location: string | null;
  languages: string[];
};

export type MatchedServiceLocation = {
  location_text: string;
  is_current: boolean;
};

export type MatchedAvailability = {
  available_from: string;
  available_until: string;
  start_time: string | null;
  end_time: string | null;
  max_bookings: number | null;
};

export type MatchedGalleryImage = {
  image_url: string;
  caption: string | null;
};

export type MatchedExperience = {
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
  /** The experience's own primary gallery image (lowest sort_order), if any — distinct from the provider's personal gallery. Always `gallery[0]?.image_url ?? null`. */
  image_url: string | null;
  /** Every gallery image for this experience, in display order (lowest sort_order first) — the full set the guest-facing detail gallery renders. */
  gallery: MatchedGalleryImage[];
  attributes: ExperienceAttribute[];
  provider: MatchedProvider;
  service_location: MatchedServiceLocation;
  availability: MatchedAvailability[];
};

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

/**
 * Deterministic hard filter for M5.1: given a stay, returns the published
 * experiences that pass every structural constraint (group size, budget,
 * date-overlapping availability, matching service location, and any dietary
 * requirement that existing M4 attribute data can actually verify). No AI,
 * no ranking — this is the eligible set the M5.2 soft-ranking step will
 * work from.
 *
 * Uses the same RLS-scoped Supabase client as the rest of the app (see
 * src/lib/supabase/server.ts): every query here runs as the signed-in
 * guest, so the "Guests read published ..." policies from 0002 are what
 * actually restrict the rows returned — this function does not (and must
 * not) rely on a service-role key.
 */
export async function getHardFilteredExperiences(
  supabase: SupabaseClient,
  stayId: string,
): Promise<MatchedExperience[]> {
  const stay = await getStay(supabase, stayId);
  if (!stay) return [];

  const dietaryRequirements = await getStayDietaryRequirements(supabase, stayId);
  const requiredDietaryTypes = dietaryRequirements.map((req) => req.type);

  // Hard-filterable in SQL: published, group size, budget.
  let query = supabase
    .from("experiences")
    .select(
      "id, provider_id, title, short_description, description, category, cuisine, price_per_person, currency, min_guests, max_guests, duration_minutes",
    )
    .eq("published", true)
    .lte("min_guests", stay.guest_count)
    .gte("max_guests", stay.guest_count);

  if (!stay.budget_flexible) {
    if (stay.budget_min != null) query = query.gte("price_per_person", stay.budget_min);
    if (stay.budget_max != null) query = query.lte("price_per_person", stay.budget_max);
  }

  const { data: experienceRows } = await query;
  const experiences = (experienceRows as ExperienceRow[] | null) ?? [];
  if (experiences.length === 0) return [];

  // Defensive re-check in TS (belt-and-braces alongside the SQL filter and
  // the RLS policy — see the same reasoning in queries.ts).
  const guestCountFiltered = experiences.filter((exp) =>
    groupSizeFits(exp.min_guests, exp.max_guests, stay.guest_count) &&
    priceFitsBudget(exp.price_per_person, stay.budget_min, stay.budget_max, stay.budget_flexible),
  );
  if (guestCountFiltered.length === 0) return [];

  const experienceIds = guestCountFiltered.map((exp) => exp.id);
  const providerIds = [...new Set(guestCountFiltered.map((exp) => exp.provider_id))];

  const [attributesRes, availabilityRes, galleryRes, providersRes, languagesRes, locationsRes] =
    await Promise.all([
      supabase
        .from("experience_attributes")
        .select("experience_id, attribute_type, attribute_value")
        .in("experience_id", experienceIds),
      supabase
        .from("experience_availability")
        .select("experience_id, available_from, available_until, start_time, end_time, max_bookings")
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
      supabase
        .from("provider_languages")
        .select("provider_id, language")
        .in("provider_id", providerIds),
      supabase
        .from("service_locations")
        .select("provider_id, location_text, latitude, longitude, starts_at, ends_at, is_current")
        .in("provider_id", providerIds),
    ]);

  type AttributeRow = { experience_id: string; attribute_type: string; attribute_value: string };
  type AvailabilityRow = {
    experience_id: string;
    available_from: string;
    available_until: string;
    start_time: string | null;
    end_time: string | null;
    max_bookings: number | null;
  };
  type ProviderRow = {
    id: string;
    display_name: string;
    profile_photo_url: string | null;
    bio: string | null;
    base_location: string | null;
  };
  type LanguageRow = { provider_id: string; language: string };
  type LocationRow = {
    provider_id: string;
    location_text: string;
    starts_at: string | null;
    ends_at: string | null;
    is_current: boolean;
  };

  type GalleryRow = { experience_id: string; image_url: string; caption: string | null; sort_order: number };

  const attributesByExperience = groupBy(
    (attributesRes.data as AttributeRow[] | null) ?? [],
    (row) => row.experience_id,
  );
  const availabilityByExperience = groupBy(
    (availabilityRes.data as AvailabilityRow[] | null) ?? [],
    (row) => row.experience_id,
  );
  // Rows arrive ordered by sort_order, so the first one seen per experience
  // is its primary image — galleryByExperience preserves that same order
  // for the full gallery.
  const galleryByExperience = groupBy(
    (galleryRes.data as GalleryRow[] | null) ?? [],
    (row) => row.experience_id,
  );
  const providerById = new Map(
    ((providersRes.data as ProviderRow[] | null) ?? []).map((row) => [row.id, row]),
  );
  const languagesByProvider = groupBy(
    (languagesRes.data as LanguageRow[] | null) ?? [],
    (row) => row.provider_id,
  );
  const locationsByProvider = groupBy(
    (locationsRes.data as LocationRow[] | null) ?? [],
    (row) => row.provider_id,
  );

  const results: MatchedExperience[] = [];

  for (const exp of guestCountFiltered) {
    const attributes = attributesByExperience.get(exp.id) ?? [];

    const dietaryTags = attributes
      .filter((attr) => attr.attribute_type === "dietary")
      .map((attr) => attr.attribute_value);
    if (!satisfiesDietaryRequirements(requiredDietaryTypes, dietaryTags)) continue;

    const availability = (availabilityByExperience.get(exp.id) ?? []).filter((slot) =>
      availabilityOverlapsStay(slot.available_from, slot.available_until, stay.check_in, stay.check_out),
    );
    if (availability.length === 0) continue;

    const matchedLocation = (locationsByProvider.get(exp.provider_id) ?? []).find(
      (loc) =>
        serviceLocationActiveDuring(loc.starts_at, loc.ends_at, stay.check_in, stay.check_out) &&
        locationTextMatches(loc.location_text, stay.location_text),
    );
    if (!matchedLocation) continue;

    const provider = providerById.get(exp.provider_id);
    if (!provider) continue; // no public profile visible -> can't safely surface this experience

    const gallery = (galleryByExperience.get(exp.id) ?? []).map((row) => ({
      image_url: row.image_url,
      caption: row.caption,
    }));

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
      attributes: attributes.map((attr) => ({
        attribute_type: attr.attribute_type,
        attribute_value: attr.attribute_value,
      })),
      provider: {
        id: provider.id,
        display_name: provider.display_name,
        profile_photo_url: provider.profile_photo_url,
        bio: provider.bio,
        base_location: provider.base_location,
        languages: (languagesByProvider.get(exp.provider_id) ?? []).map((row) => row.language),
      },
      service_location: {
        location_text: matchedLocation.location_text,
        is_current: matchedLocation.is_current,
      },
      availability: availability.map((slot) => ({
        available_from: slot.available_from,
        available_until: slot.available_until,
        start_time: slot.start_time,
        end_time: slot.end_time,
        max_bookings: slot.max_bookings,
      })),
    });
  }

  return results;
}

function groupBy<T, K>(rows: T[], keyFn: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = map.get(key);
    if (existing) {
      existing.push(row);
    } else {
      map.set(key, [row]);
    }
  }
  return map;
}
