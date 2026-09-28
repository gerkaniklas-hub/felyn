"use server";

import { redirect } from "next/navigation";
import { PREFERRED_TIME_PATTERN } from "@/lib/matching/slot-availability";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EXPERIENCE_IMAGES_BUCKET, experienceImagePathFromPublicUrl } from "@/lib/storage/experience-images";
import { ATTRIBUTE_TYPES, type AttributeType } from "./experience-attribute-options";

export type ExperienceFormState = { error?: string; ok?: boolean };
export type ActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";
const NOT_YOUR_EXPERIENCE_ERROR = "That experience isn't yours to manage.";

/**
 * Stage 3: every write below resolves the caller's OWN providers.id
 * strictly from their session (never from client input) — mirroring
 * getProviderIdentity's own "providers.user_id = userId" lookup. Returns
 * null if this account isn't linked to a provider profile at all.
 */
async function resolveOwnProviderId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase.from("providers").select("id").eq("user_id", user.id).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

function parseCoreFields(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const shortDescription = String(formData.get("shortDescription") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const cuisine = String(formData.get("cuisine") ?? "").trim();
  const pricePerPerson = Number(formData.get("pricePerPerson") ?? "");
  const minGuests = Number(formData.get("minGuests") ?? "");
  const maxGuests = Number(formData.get("maxGuests") ?? "");
  const durationMinutes = Number(formData.get("durationMinutes") ?? "");

  if (!title) return { error: "Please give this experience a title." } as const;
  if (!["food", "drink", "food_drink"].includes(category)) {
    return { error: "Please choose a category." } as const;
  }
  if (!Number.isFinite(pricePerPerson) || pricePerPerson < 0) {
    return { error: "Enter a valid price per person." } as const;
  }
  if (!Number.isInteger(minGuests) || minGuests < 1) {
    return { error: "Enter a valid minimum number of guests." } as const;
  }
  if (!Number.isInteger(maxGuests) || maxGuests < minGuests) {
    return { error: "Maximum guests must be at least the minimum." } as const;
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return { error: "Enter a valid duration in minutes." } as const;
  }

  return {
    values: {
      title,
      short_description: shortDescription || null,
      description: description || null,
      category,
      cuisine: cuisine || null,
      price_per_person: pricePerPerson,
      min_guests: minGuests,
      max_guests: maxGuests,
      duration_minutes: durationMinutes,
    },
  } as const;
}

/**
 * New experiences always start as a draft (published defaults to false at
 * the DB level, and this insert never sets it) — invisible to
 * getPublishedExperiences/the hard filter until explicitly published via
 * setExperiencePublished. On success, redirects to the edit page so the
 * host can add photos/attributes/availability, which all need a real
 * experience_id to attach to.
 */
export async function createExperience(
  _prevState: ExperienceFormState,
  formData: FormData,
): Promise<ExperienceFormState> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { error: "This account isn't linked to a Felyn provider profile yet." };

  const parsed = parseCoreFields(formData);
  if ("error" in parsed) return { error: parsed.error };

  const { data, error } = await supabase
    .from("experiences")
    .insert({ ...parsed.values, provider_id: providerId })
    .select("id")
    .single();

  if (error || !data) return { error: GENERIC_ERROR };

  redirect(`/provider/experiences/${data.id}/edit?created=1`);
}

/** Edits the core fields of one of the caller's OWN experiences. Never touches `published` — see setExperiencePublished. */
export async function updateExperience(
  _prevState: ExperienceFormState,
  formData: FormData,
): Promise<ExperienceFormState> {
  const experienceId = String(formData.get("experienceId") ?? "").trim();
  if (!experienceId) return { error: GENERIC_ERROR };

  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { error: "This account isn't linked to a Felyn provider profile yet." };

  const parsed = parseCoreFields(formData);
  if ("error" in parsed) return { error: parsed.error };

  const { data, error } = await supabase
    .from("experiences")
    .update(parsed.values)
    .eq("id", experienceId)
    .eq("provider_id", providerId)
    .select("id")
    .maybeSingle();

  if (error || !data) return { error: NOT_YOUR_EXPERIENCE_ERROR };

  return { ok: true };
}

export type PublishResult =
  | { ok: true }
  | { ok: false; error: string; reason?: "no_photos" | "no_availability" };

/**
 * Publishing/unpublishing is deliberately separate from the edit form — an
 * instant, single-purpose toggle. Flipping `published` is all this does;
 * guests' getPublishedExperiences/hard-filter queries already filter on
 * this exact column, so the effect is immediate with no other change
 * needed anywhere guest-facing.
 *
 * Publishing (not unpublishing) is server-side gated on having at least
 * one gallery photo AND at least one availability window — this is the
 * actual enforcement point; the edit page's own reminder banners are only
 * a UI convenience mirroring the same two rules, never the real boundary
 * (same "UI convenience, DB/server authoritative" pattern already used for
 * the messaging window, see booking-status.ts). `reason` lets the UI point
 * the host at exactly which requirement is unmet. Unpublishing has no
 * requirements at all and never touches any booking data — it only ever
 * flips this one column.
 */
export async function setExperiencePublished(experienceId: string, published: boolean): Promise<PublishResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  if (published) {
    const [galleryCount, availabilityCount] = await Promise.all([
      supabase.from("experience_gallery").select("id", { count: "exact", head: true }).eq("experience_id", experienceId),
      supabase
        .from("experience_availability")
        .select("id", { count: "exact", head: true })
        .eq("experience_id", experienceId),
    ]);
    if ((galleryCount.count ?? 0) === 0) {
      return { ok: false, error: "Add at least one photo before publishing.", reason: "no_photos" };
    }
    if ((availabilityCount.count ?? 0) === 0) {
      return {
        ok: false,
        error: "Add at least one availability window before publishing.",
        reason: "no_availability",
      };
    }
  }

  const { data, error } = await supabase
    .from("experiences")
    .update({ published })
    .eq("id", experienceId)
    .eq("provider_id", providerId)
    .select("id")
    .maybeSingle();

  if (error || !data) return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  return { ok: true };
}

/**
 * Deletes one of the caller's OWN experiences, best-effort cleaning up its
 * storage objects afterwards. `booking_request_items.experience_id` is
 * declared `ON DELETE RESTRICT` (0005, deliberately — see that migration's
 * own comment): if any booking, of ANY status, has ever referenced this
 * experience, Postgres rejects the delete outright with a foreign-key
 * violation (SQLSTATE 23503) rather than losing booking history. That is
 * treated here as an expected, handled outcome — never a bug — and
 * surfaced as a friendly message pointing the host at unpublishing
 * instead. No booking data is ever touched by this function, in either
 * outcome.
 */
export async function deleteExperience(experienceId: string): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };

  // Fetched before the delete purely for best-effort storage cleanup after
  // a successful delete — never used to decide whether the delete may
  // proceed (the database's own RESTRICT constraint is the real gate).
  const { data: galleryRows } = await supabase
    .from("experience_gallery")
    .select("image_url")
    .eq("experience_id", experienceId);

  const { data, error } = await supabase
    .from("experiences")
    .delete()
    .eq("id", experienceId)
    .eq("provider_id", providerId)
    .select("id")
    .maybeSingle();

  if (error) {
    // 23503 = foreign_key_violation. Matched primarily by SQLSTATE code
    // (what PostgREST/supabase-js actually surfaces on `error.code`); the
    // message substring is a defensive fallback only, not the primary
    // detection path.
    const isForeignKeyViolation =
      (error as { code?: string }).code === "23503" ||
      /foreign key/i.test((error as { message?: string }).message ?? "");
    if (isForeignKeyViolation) {
      return {
        ok: false,
        error:
          "This experience has existing booking history and can't be deleted. Unpublish it instead — that removes it from Explore while keeping past bookings intact.",
      };
    }
    return { ok: false, error: GENERIC_ERROR };
  }
  if (!data) return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };

  // Best-effort only: experience_gallery rows are already gone (0002's
  // experience_gallery FK is ON DELETE CASCADE), but the underlying
  // storage objects are a separate system the DB delete never touches.
  // A failure here leaves a harmless orphaned file, never a correctness
  // problem, so its result is intentionally not checked.
  const paths = ((galleryRows as { image_url: string }[] | null) ?? [])
    .map((row) => experienceImagePathFromPublicUrl(row.image_url))
    .filter((path): path is string => path != null);
  if (paths.length > 0) {
    await supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).remove(paths);
  }

  return { ok: true };
}

function isValidAttributeType(value: string): value is AttributeType {
  return (ATTRIBUTE_TYPES as readonly string[]).includes(value);
}

/**
 * Verifies experienceId belongs to the caller's own provider before any
 * availability/gallery/attribute mutation below — defense in depth on top
 * of each table's own RLS (0002), matching this project's established
 * "explicit provider_id filter AND RLS, never RLS alone" convention.
 */
async function ownsExperience(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  providerId: string,
  experienceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("experiences")
    .select("id")
    .eq("id", experienceId)
    .eq("provider_id", providerId)
    .maybeSingle();
  return data != null;
}

export type AvailabilityFormState = { error?: string; ok?: boolean };

/**
 * Intentionally simple MVP availability (matches 0002's own comment on
 * experience_availability): add a date window, optionally narrowed to a
 * start/end time-of-day and a max_bookings cap. Dates and times are plain
 * calendar dates / times-of-day with no timezone conversion — the same
 * convention already used for planned_date/preferred_time elsewhere in
 * this app (see booking-status.ts's own note: Atlantic/Canary-local
 * formatting belongs only in DISPLAY, never in storage/comparison). A host
 * entering "18:00" means 18:00 Tenerife local time, exactly as a guest's
 * preferred_time already does.
 */
export async function addAvailabilityWindow(
  _prevState: AvailabilityFormState,
  formData: FormData,
): Promise<AvailabilityFormState> {
  const experienceId = String(formData.get("experienceId") ?? "").trim();
  const availableFrom = String(formData.get("availableFrom") ?? "").trim();
  const availableUntil = String(formData.get("availableUntil") ?? "").trim();
  const startTimeRaw = String(formData.get("startTime") ?? "").trim();
  const endTimeRaw = String(formData.get("endTime") ?? "").trim();
  const maxBookingsRaw = String(formData.get("maxBookings") ?? "").trim();

  if (!experienceId || !availableFrom || !availableUntil) {
    return { error: "Please fill in the date range." };
  }
  if (availableUntil < availableFrom) {
    return { error: "The end date can't be before the start date." };
  }

  const startTime = startTimeRaw || null;
  const endTime = endTimeRaw || null;
  if ((startTime && !endTime) || (!startTime && endTime)) {
    return { error: "Please provide both a start and end time, or leave both blank." };
  }
  if (startTime && endTime) {
    if (!PREFERRED_TIME_PATTERN.test(startTime) || !PREFERRED_TIME_PATTERN.test(endTime)) {
      return { error: "Times must be in HH:MM format." };
    }
    if (endTime <= startTime) {
      return { error: "The end time must be after the start time." };
    }
  }

  let maxBookings: number | null = null;
  if (maxBookingsRaw) {
    maxBookings = Number(maxBookingsRaw);
    if (!Number.isInteger(maxBookings) || maxBookings <= 0) {
      return { error: "Max bookings must be a positive whole number." };
    }
  }

  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { error } = await supabase.from("experience_availability").insert({
    experience_id: experienceId,
    available_from: availableFrom,
    available_until: availableUntil,
    start_time: startTime,
    end_time: endTime,
    max_bookings: maxBookings,
  });

  if (error) return { error: GENERIC_ERROR };
  return { ok: true };
}

/** Removes one availability window. Does not touch any booking — this table has no relationship to booking_request_items at all. */
export async function removeAvailabilityWindow(availabilityId: string, experienceId: string): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { error } = await supabase
    .from("experience_availability")
    .delete()
    .eq("id", availabilityId)
    .eq("experience_id", experienceId);

  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

/**
 * Toggles ONE attribute tag on/off for an experience. `experience_attributes`
 * has a unique(experience_id, attribute_type, attribute_value) constraint
 * (0002), so adding an already-present tag is a harmless no-op (23505
 * unique_violation is swallowed) rather than an error.
 */
export async function toggleExperienceAttribute(
  experienceId: string,
  attributeType: string,
  attributeValue: string,
  enabled: boolean,
): Promise<ActionResult> {
  if (!isValidAttributeType(attributeType)) return { ok: false, error: GENERIC_ERROR };
  const value = attributeValue.trim();
  if (!value) return { ok: false, error: GENERIC_ERROR };

  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  if (enabled) {
    const { error } = await supabase
      .from("experience_attributes")
      .insert({ experience_id: experienceId, attribute_type: attributeType, attribute_value: value });
    if (error && (error as { code?: string }).code !== "23505") {
      return { ok: false, error: GENERIC_ERROR };
    }
    return { ok: true };
  }

  const { error } = await supabase
    .from("experience_attributes")
    .delete()
    .eq("experience_id", experienceId)
    .eq("attribute_type", attributeType)
    .eq("attribute_value", value);
  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

/** Persists one already-uploaded gallery image's DB row. The upload itself happens client-side (RLS-gated) — see ExperienceGalleryManager. */
export async function addExperienceGalleryImage(experienceId: string, imageUrl: string): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { count } = await supabase
    .from("experience_gallery")
    .select("id", { count: "exact", head: true })
    .eq("experience_id", experienceId);

  const { error } = await supabase
    .from("experience_gallery")
    .insert({ experience_id: experienceId, image_url: imageUrl, sort_order: count ?? 0 });
  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

/** Removes one gallery image's DB row and best-effort deletes the underlying storage object. */
export async function removeExperienceGalleryImage(
  galleryId: string,
  experienceId: string,
  imageUrl: string,
): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { error } = await supabase
    .from("experience_gallery")
    .delete()
    .eq("id", galleryId)
    .eq("experience_id", experienceId);
  if (error) return { ok: false, error: GENERIC_ERROR };

  const path = experienceImagePathFromPublicUrl(imageUrl);
  if (path) {
    await supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).remove([path]);
  }
  return { ok: true };
}

/**
 * Makes one gallery image the primary (cover) image — moves it to the
 * front of the order. Primary-image selection is purely a sort_order
 * convention (the lowest sort_order = the primary, consistently in
 * hard-filter.ts/explore.ts/experiences.ts) — no dedicated "is primary"
 * column exists or is needed. Rewrites every row's sort_order to its new
 * position 0..n-1 in one batch, rather than only swapping two rows, so
 * this works correctly regardless of the image's current position.
 */
export async function setExperienceGalleryPrimary(experienceId: string, imageId: string): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { data: rows } = await supabase
    .from("experience_gallery")
    .select("id, sort_order")
    .eq("experience_id", experienceId)
    .order("sort_order", { ascending: true });

  const list = (rows as { id: string; sort_order: number }[] | null) ?? [];
  const target = list.find((row) => row.id === imageId);
  if (!target) return { ok: false, error: GENERIC_ERROR };

  const reordered = [target, ...list.filter((row) => row.id !== imageId)];
  const results = await Promise.all(
    reordered.map((row, index) =>
      row.sort_order === index
        ? Promise.resolve({ error: null })
        : supabase.from("experience_gallery").update({ sort_order: index }).eq("id", row.id),
    ),
  );
  if (results.some((r) => r.error)) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

/** Swaps sort_order between two adjacent gallery rows — the list's "move up"/"move down". */
export async function reorderExperienceGalleryImage(
  experienceId: string,
  imageId: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const providerId = await resolveOwnProviderId(supabase);
  if (!providerId) return { ok: false, error: "This account isn't linked to a Felyn provider profile yet." };
  if (!(await ownsExperience(supabase, providerId, experienceId))) {
    return { ok: false, error: NOT_YOUR_EXPERIENCE_ERROR };
  }

  const { data: rows } = await supabase
    .from("experience_gallery")
    .select("id, sort_order")
    .eq("experience_id", experienceId)
    .order("sort_order", { ascending: true });

  const list = (rows as { id: string; sort_order: number }[] | null) ?? [];
  const index = list.findIndex((row) => row.id === imageId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || swapIndex < 0 || swapIndex >= list.length) return { ok: true }; // already at the edge — no-op

  const a = list[index];
  const b = list[swapIndex];

  const [resA, resB] = await Promise.all([
    supabase.from("experience_gallery").update({ sort_order: b.sort_order }).eq("id", a.id),
    supabase.from("experience_gallery").update({ sort_order: a.sort_order }).eq("id", b.id),
  ]);
  if (resA.error || resB.error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}
