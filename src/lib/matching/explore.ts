import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExperienceAttribute, ExperienceCategory, MatchedExperience } from "./hard-filter";

/**
 * /explore: a lightweight, stay-independent list of every published
 * experience — no hard filter (group size/budget/dates/location) and no AI
 * ranking, just "what's on Felyn". Reuses the same guest-readable M4
 * tables/RLS policies as hard-filter.ts and provider-profile.ts.
 *
 * MatchedExperience's `service_location`/`availability` only matter for
 * stay-based planning (M5.1's hard filter, the planner's date picker) —
 * neither is rendered by ExperienceCard/ExperienceFocus/ProviderFocus, so
 * they're filled with harmless placeholders here rather than queried.
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

  const [attributesRes, galleryRes, providersRes, languagesRes] = await Promise.all([
    supabase
      .from("experience_attributes")
      .select("experience_id, attribute_type, attribute_value")
      .in("experience_id", experienceIds),
    supabase
      .from("experience_gallery")
      .select("experience_id, image_url, sort_order")
      .in("experience_id", experienceIds)
      .order("sort_order", { ascending: true }),
    supabase
      .from("provider_public_profiles")
      .select("id, display_name, profile_photo_url, bio, base_location")
      .in("id", providerIds),
    supabase.from("provider_languages").select("provider_id, language").in("provider_id", providerIds),
  ]);

  type AttributeRow = { experience_id: string; attribute_type: string; attribute_value: string };
  type GalleryRow = { experience_id: string; image_url: string; sort_order: number };
  type ProviderRow = {
    id: string;
    display_name: string;
    profile_photo_url: string | null;
    bio: string | null;
    base_location: string | null;
  };
  type LanguageRow = { provider_id: string; language: string };

  const attributesByExperience = new Map<string, ExperienceAttribute[]>();
  for (const row of (attributesRes.data as AttributeRow[] | null) ?? []) {
    const list = attributesByExperience.get(row.experience_id) ?? [];
    list.push({ attribute_type: row.attribute_type, attribute_value: row.attribute_value });
    attributesByExperience.set(row.experience_id, list);
  }

  // Rows arrive ordered by sort_order, so the first one seen per experience
  // is its primary image (same convention as hard-filter.ts).
  const primaryImageByExperience = new Map<string, string>();
  for (const row of (galleryRes.data as GalleryRow[] | null) ?? []) {
    if (!primaryImageByExperience.has(row.experience_id)) {
      primaryImageByExperience.set(row.experience_id, row.image_url);
    }
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
      image_url: primaryImageByExperience.get(exp.id) ?? null,
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
      availability: [],
    });
  }

  return results;
}
