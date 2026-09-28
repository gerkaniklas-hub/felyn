import type { SupabaseClient } from "@supabase/supabase-js";

export type ProviderGalleryImage = {
  image_url: string;
  caption: string | null;
};

export type ProviderOtherExperience = {
  id: string;
  title: string;
  price_per_person: number;
  currency: string;
  image_url: string | null;
};

export type ProviderProfile = {
  id: string;
  display_name: string;
  profile_photo_url: string | null;
  bio: string | null;
  base_location: string | null;
  languages: string[];
  specialties: string[];
  gallery: ProviderGalleryImage[];
  otherExperiences: ProviderOtherExperience[];
};

/**
 * RLS-safe provider profile for the M6 provider focus panel. Reads only
 * from provider_public_profiles (never the private `providers` table) plus
 * the same guest-readable M4 tables hard-filter.ts already uses — no
 * schema changes, no new tables, no user_id/verification_status exposed.
 */
export async function getProviderProfile(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ProviderProfile | null> {
  const [profileRes, languagesRes, galleryRes, experiencesRes] = await Promise.all([
    supabase
      .from("provider_public_profiles")
      .select("id, display_name, profile_photo_url, bio, base_location")
      .eq("id", providerId)
      .maybeSingle(),
    supabase.from("provider_languages").select("language").eq("provider_id", providerId),
    supabase
      .from("provider_gallery")
      .select("image_url, caption, sort_order")
      .eq("provider_id", providerId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("experiences")
      .select("id, title, price_per_person, currency")
      .eq("provider_id", providerId)
      .eq("published", true),
  ]);

  type ProfileRow = {
    id: string;
    display_name: string;
    profile_photo_url: string | null;
    bio: string | null;
    base_location: string | null;
  };
  const profile = profileRes.data as ProfileRow | null;
  if (!profile) return null;

  const languages = ((languagesRes.data as { language: string }[] | null) ?? []).map(
    (row) => row.language,
  );
  const gallery = (
    (galleryRes.data as { image_url: string; caption: string | null }[] | null) ?? []
  ).map((row) => ({ image_url: row.image_url, caption: row.caption }));

  type ExperienceRow = { id: string; title: string; price_per_person: number; currency: string };
  const experienceRows = (experiencesRes.data as ExperienceRow[] | null) ?? [];
  const experienceIds = experienceRows.map((row) => row.id);

  // .in() with an empty array simply matches nothing, so these are safe to
  // run unconditionally rather than branching on experienceIds.length.
  const [attributesRes, experienceGalleryRes] = await Promise.all([
    supabase
      .from("experience_attributes")
      .select("attribute_value")
      .in("experience_id", experienceIds)
      .eq("attribute_type", "specialty"),
    supabase
      .from("experience_gallery")
      .select("experience_id, image_url, sort_order")
      .in("experience_id", experienceIds)
      .order("sort_order", { ascending: true }),
  ]);

  const specialties = [
    ...new Set(
      ((attributesRes.data as { attribute_value: string }[] | null) ?? []).map(
        (row) => row.attribute_value,
      ),
    ),
  ];

  const primaryImageByExperience = new Map<string, string>();
  for (const row of (experienceGalleryRes.data as
    | { experience_id: string; image_url: string; sort_order: number }[]
    | null) ?? []) {
    if (!primaryImageByExperience.has(row.experience_id)) {
      primaryImageByExperience.set(row.experience_id, row.image_url);
    }
  }

  return {
    id: profile.id,
    display_name: profile.display_name,
    profile_photo_url: profile.profile_photo_url,
    bio: profile.bio,
    base_location: profile.base_location,
    languages,
    specialties,
    gallery,
    otherExperiences: experienceRows.map((row) => ({
      id: row.id,
      title: row.title,
      price_per_person: row.price_per_person,
      currency: row.currency,
      image_url: primaryImageByExperience.get(row.id) ?? null,
    })),
  };
}
