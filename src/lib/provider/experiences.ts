import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExperienceCategory } from "@/lib/matching/hard-filter";
import { normalizeTime } from "@/lib/matching/slot-availability";
import type { AttributeType } from "./experience-attribute-options";

export type ProviderExperienceListItem = {
  id: string;
  title: string;
  category: ExperienceCategory;
  pricePerPerson: number;
  currency: string;
  published: boolean;
  primaryImageUrl: string | null;
  minGuests: number;
  maxGuests: number;
  durationMinutes: number;
  createdAt: string;
};

/**
 * Stage 3: the signed-in provider's OWN experiences — every one, published
 * or draft, scoped strictly by provider_id (also RLS-enforced by "Providers
 * manage their own experiences", 0002 — this explicit filter is defense in
 * depth, matching how getProviderIdentity/getProviderRequestItems already
 * scope every dashboard query).
 */
export async function getProviderExperienceList(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ProviderExperienceListItem[]> {
  const { data: experienceRows } = await supabase
    .from("experiences")
    .select(
      "id, title, category, price_per_person, currency, published, min_guests, max_guests, duration_minutes, created_at",
    )
    .eq("provider_id", providerId)
    .order("created_at", { ascending: false });

  type Row = {
    id: string;
    title: string;
    category: ExperienceCategory;
    price_per_person: number;
    currency: string;
    published: boolean;
    min_guests: number;
    max_guests: number;
    duration_minutes: number;
    created_at: string;
  };
  const experiences = (experienceRows as Row[] | null) ?? [];
  if (experiences.length === 0) return [];

  const experienceIds = experiences.map((row) => row.id);
  const { data: galleryRows } = await supabase
    .from("experience_gallery")
    .select("experience_id, image_url, sort_order")
    .in("experience_id", experienceIds)
    .order("sort_order", { ascending: true });

  const primaryImageByExperience = new Map<string, string>();
  for (const row of (galleryRows as { experience_id: string; image_url: string }[] | null) ?? []) {
    if (!primaryImageByExperience.has(row.experience_id)) {
      primaryImageByExperience.set(row.experience_id, row.image_url);
    }
  }

  return experiences.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    pricePerPerson: row.price_per_person,
    currency: row.currency,
    published: row.published,
    primaryImageUrl: primaryImageByExperience.get(row.id) ?? null,
    minGuests: row.min_guests,
    maxGuests: row.max_guests,
    durationMinutes: row.duration_minutes,
    createdAt: row.created_at,
  }));
}

export type ProviderExperienceGalleryImage = {
  id: string;
  imageUrl: string;
  caption: string | null;
  sortOrder: number;
};

export type ProviderExperienceAvailabilityWindow = {
  id: string;
  availableFrom: string;
  availableUntil: string;
  startTime: string | null;
  endTime: string | null;
};

export type ProviderExperienceDetail = {
  id: string;
  title: string;
  shortDescription: string | null;
  description: string | null;
  category: ExperienceCategory;
  cuisine: string | null;
  pricePerPerson: number;
  currency: string;
  minGuests: number;
  maxGuests: number;
  durationMinutes: number;
  published: boolean;
  attributes: { type: AttributeType; value: string }[];
  gallery: ProviderExperienceGalleryImage[];
  availability: ProviderExperienceAvailabilityWindow[];
};

/**
 * One of the signed-in provider's OWN experiences, in full — used by the
 * edit page. Returns null if the experience doesn't exist OR belongs to a
 * different provider (the explicit `.eq("provider_id", providerId)` means
 * this can never leak another provider's draft; RLS would independently
 * block it too).
 */
export async function getProviderExperienceDetail(
  supabase: SupabaseClient,
  providerId: string,
  experienceId: string,
): Promise<ProviderExperienceDetail | null> {
  const { data: experience } = await supabase
    .from("experiences")
    .select(
      "id, title, short_description, description, category, cuisine, price_per_person, currency, min_guests, max_guests, duration_minutes, published",
    )
    .eq("id", experienceId)
    .eq("provider_id", providerId)
    .maybeSingle();

  if (!experience) return null;

  const [attributesRes, galleryRes, availabilityRes] = await Promise.all([
    supabase
      .from("experience_attributes")
      .select("attribute_type, attribute_value")
      .eq("experience_id", experienceId),
    supabase
      .from("experience_gallery")
      .select("id, image_url, caption, sort_order")
      .eq("experience_id", experienceId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("experience_availability")
      .select("id, available_from, available_until, start_time, end_time")
      .eq("experience_id", experienceId)
      .order("available_from", { ascending: true }),
  ]);

  const attributes = (
    (attributesRes.data as { attribute_type: AttributeType; attribute_value: string }[] | null) ?? []
  ).map((row) => ({ type: row.attribute_type, value: row.attribute_value }));

  const gallery = (
    (galleryRes.data as { id: string; image_url: string; caption: string | null; sort_order: number }[] | null) ?? []
  ).map((row) => ({ id: row.id, imageUrl: row.image_url, caption: row.caption, sortOrder: row.sort_order }));

  const availability = (
    (availabilityRes.data as
      | {
          id: string;
          available_from: string;
          available_until: string;
          start_time: string | null;
          end_time: string | null;
        }[]
      | null) ?? []
  ).map((row) => ({
    id: row.id,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
  }));

  return {
    id: experience.id,
    title: experience.title,
    shortDescription: experience.short_description,
    description: experience.description,
    category: experience.category,
    cuisine: experience.cuisine,
    pricePerPerson: experience.price_per_person,
    currency: experience.currency,
    minGuests: experience.min_guests,
    maxGuests: experience.max_guests,
    durationMinutes: experience.duration_minutes,
    published: experience.published,
    attributes,
    gallery,
    availability,
  };
}
