import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingItemStatus, CancelledBy, CancelReason, DeclineReason } from "./booking-status";
import type { PlannedMoment } from "./plan";
import { normalizeTime } from "./slot-availability";

export type GuestExperienceItem = {
  id: string;
  /** null for a request made without a trip (0026). */
  stayId: string | null;
  /** The linked stay's name, or null when the request has no trip. */
  stayPropertyName: string | null;
  experienceId: string;
  experienceTitle: string;
  experienceImageUrl: string | null;
  providerDisplayName: string;
  plannedDate: string;
  plannedMoment: PlannedMoment;
  /** 'HH:MM' — the guest's requested time, or null on old requests (see getBookingTimeLabel, plan.ts, for the display fallback). */
  preferredTime: string | null;
  /** 0033: the authoritative start once the host has accepted (null before, and on bookings accepted before 0033) — see getBookingStartTime. */
  confirmedStartAt: string | null;
  guestCount: number;
  pricePerPerson: number;
  currency: string;
  status: BookingItemStatus;
  declineReason: DeclineReason | null;
  createdAt: string;
  /** Booking-lifecycle milestone: set only once status is CANCELLED — see booking-status.ts. */
  cancelledBy: CancelledBy | null;
  cancellationReason: CancelReason | null;
  cancellationNote: string | null;
};

/**
 * Milestone 1: every experience the signed-in guest has ever requested,
 * across every stay and every booking request — not just the single active
 * (REQUESTED/CONFIRMED) request per stay that getActiveBookingRequest
 * returns. This is the data source for the dedicated /experiences overview.
 * Reuses the existing booking_requests/booking_request_items tables and
 * their "Users manage their own..." RLS policies (0005) — no new table, no
 * parallel history model.
 *
 * A "completed" bucket is deliberately NOT included here yet: it depends on
 * the completed_at column proposed for the automatic-completion milestone,
 * which has not been migrated in. Once that lands, this file gets a small
 * follow-up, not a redesign.
 *
 * Pass `stayId` to scope this to one stay's experiences only (the stay
 * overview page) instead of every stay the guest has ever added. RLS
 * already restricts booking_requests to the signed-in guest's own rows;
 * the explicit `.eq("user_id", ...)` here is the same belt-and-braces
 * pattern the rest of this codebase uses on top of RLS, not a substitute
 * for it.
 */
export async function getGuestExperiences(
  supabase: SupabaseClient,
  stayId?: string,
): Promise<GuestExperienceItem[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  let requestQuery = supabase.from("booking_requests").select("id, stay_id").eq("user_id", user.id);
  if (stayId) requestQuery = requestQuery.eq("stay_id", stayId);
  const { data: requestRows } = await requestQuery;
  const requests = (requestRows as { id: string; stay_id: string | null }[] | null) ?? [];
  if (requests.length === 0) return [];

  const requestIds = requests.map((r) => r.id);
  const stayIdByRequest = new Map(requests.map((r) => [r.id, r.stay_id]));
  const stayIds = [...new Set(requests.map((r) => r.stay_id).filter((id): id is string => id !== null))];

  const [itemsRes, staysRes] = await Promise.all([
    supabase
      .from("booking_request_items")
      .select(
        "id, booking_request_id, experience_id, planned_date, planned_moment, preferred_time, guest_count, price_per_person, status, decline_reason, created_at, cancelled_by, cancellation_reason, cancellation_note, confirmed_start_at",
      )
      .in("booking_request_id", requestIds)
      .order("planned_date", { ascending: false }),
    stayIds.length > 0
      ? supabase.from("stays").select("id, property_name").in("id", stayIds)
      : Promise.resolve({ data: [] as { id: string; property_name: string }[] }),
  ]);

  type ItemRow = {
    id: string;
    booking_request_id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    preferred_time: string | null;
    confirmed_start_at: string | null;
    guest_count: number;
    price_per_person: number;
    status: BookingItemStatus;
    decline_reason: DeclineReason | null;
    created_at: string;
    cancelled_by: CancelledBy | null;
    cancellation_reason: CancelReason | null;
    cancellation_note: string | null;
  };
  const items = (itemsRes.data as ItemRow[] | null) ?? [];
  if (items.length === 0) return [];

  const stayNameById = new Map(
    ((staysRes.data as { id: string; property_name: string }[] | null) ?? []).map((s) => [s.id, s.property_name]),
  );

  const experienceIds = [...new Set(items.map((i) => i.experience_id))];
  const { data: experienceRows } = await supabase
    .from("experiences")
    .select("id, title, provider_id, currency")
    .in("id", experienceIds);
  type ExperienceRow = { id: string; title: string; provider_id: string; currency: string };
  const experiences = (experienceRows as ExperienceRow[] | null) ?? [];
  const experienceById = new Map(experiences.map((e) => [e.id, e]));

  const providerIds = [...new Set(experiences.map((e) => e.provider_id))];
  const [providerRes, galleryRes] = await Promise.all([
    providerIds.length > 0
      ? supabase.from("provider_public_profiles").select("id, display_name").in("id", providerIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    experienceIds.length > 0
      ? supabase
          .from("experience_gallery")
          .select("experience_id, image_url, sort_order")
          .in("experience_id", experienceIds)
          .order("sort_order", { ascending: true })
      : Promise.resolve({ data: [] as { experience_id: string; image_url: string; sort_order: number }[] }),
  ]);
  const providerNameById = new Map(
    ((providerRes.data as { id: string; display_name: string }[] | null) ?? []).map((p) => [p.id, p.display_name]),
  );
  // Rows arrive ordered by sort_order, so the first one seen per experience is its primary image (same convention as explore.ts/hard-filter.ts).
  const primaryImageByExperience = new Map<string, string>();
  for (const row of (galleryRes.data as { experience_id: string; image_url: string }[] | null) ?? []) {
    if (!primaryImageByExperience.has(row.experience_id)) {
      primaryImageByExperience.set(row.experience_id, row.image_url);
    }
  }

  // A since-unpublished experience falls outside "Guests read published
  // experiences" (0002) and won't resolve here — the item still gets a
  // row (guest history is never silently dropped), just with a fallback
  // title rather than a broken page.
  return items.map((item) => {
    const experience = experienceById.get(item.experience_id);
    const stayId = stayIdByRequest.get(item.booking_request_id) ?? null;
    return {
      id: item.id,
      stayId,
      stayPropertyName: stayId ? (stayNameById.get(stayId) ?? "Your stay") : null,
      experienceId: item.experience_id,
      experienceTitle: experience?.title ?? "Experience no longer available",
      experienceImageUrl: primaryImageByExperience.get(item.experience_id) ?? null,
      providerDisplayName: experience ? (providerNameById.get(experience.provider_id) ?? "Felyn host") : "Felyn host",
      plannedDate: item.planned_date,
      plannedMoment: item.planned_moment,
      preferredTime: normalizeTime(item.preferred_time),
      confirmedStartAt: item.confirmed_start_at,
      guestCount: item.guest_count,
      pricePerPerson: item.price_per_person,
      currency: experience?.currency ?? "EUR",
      status: item.status,
      declineReason: item.decline_reason,
      createdAt: item.created_at,
      cancelledBy: item.cancelled_by,
      cancellationReason: item.cancellation_reason,
      cancellationNote: item.cancellation_note,
    };
  });
}

export type GuestExperienceDetail = GuestExperienceItem & {
  hostNote: string | null;
  /** For "Message host" (the existing booking conversation): the host's public profile, null once the experience is unreadable. */
  providerId: string | null;
  providerPhotoUrl: string | null;
  /** Anchors of the messaging window (getMessagingWindowState): set only when DECLINED / CANCELLED respectively. */
  decidedAt: string | null;
  cancelledAt: string | null;
  /**
   * The catalogue experience's own richer details — description, category,
   * duration, the full photo gallery — when they're still readable. This
   * is null (not an error) once an experience has since been unpublished:
   * "Guests read published experiences" (0002) then excludes it, exactly
   * the same "since-unpublished" case getGuestExperiences already handles
   * for the title/image above. The booking's own snapshot fields (title,
   * image, price, date/time/guests/status) are unaffected either way —
   * they come from booking_request_items, which the guest owns regardless
   * of the experience's current publish state.
   */
  experience: {
    shortDescription: string | null;
    description: string | null;
    category: string;
    cuisine: string | null;
    durationMinutes: number;
    gallery: { image_url: string; caption: string | null }[];
  } | null;
};

/**
 * One booking, in full, for the guest's own booking-detail page
 * (/experiences/[itemId]). Ownership is enforced by RLS alone here (no
 * explicit user_id filter is possible before the row is even fetched) —
 * "Guests view their own booking request items" (0031; 0005 before) means a guest can
 * only ever receive their OWN item; an itemId for someone else's booking
 * simply resolves to null, exactly like getProviderRequestItems already
 * relies on RLS for the equivalent provider-side lookup.
 */
export async function getGuestExperienceDetail(
  supabase: SupabaseClient,
  itemId: string,
): Promise<GuestExperienceDetail | null> {
  const { data: itemRow } = await supabase
    .from("booking_request_items")
    .select(
      "id, booking_request_id, experience_id, planned_date, planned_moment, preferred_time, guest_count, price_per_person, status, decline_reason, host_note, created_at, decided_at, cancelled_at, cancelled_by, cancellation_reason, cancellation_note, confirmed_start_at",
    )
    .eq("id", itemId)
    .maybeSingle();

  type ItemRow = {
    id: string;
    booking_request_id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    preferred_time: string | null;
    confirmed_start_at: string | null;
    guest_count: number;
    price_per_person: number;
    status: BookingItemStatus;
    decline_reason: DeclineReason | null;
    host_note: string | null;
    created_at: string;
    decided_at: string | null;
    cancelled_at: string | null;
    cancelled_by: CancelledBy | null;
    cancellation_reason: CancelReason | null;
    cancellation_note: string | null;
  };
  const item = itemRow as ItemRow | null;
  if (!item) return null;

  const { data: requestRow } = await supabase
    .from("booking_requests")
    .select("stay_id")
    .eq("id", item.booking_request_id)
    .maybeSingle();
  if (!requestRow) return null; // shouldn't happen — the parent request must exist for this item to
  const stayId = (requestRow as { stay_id: string | null }).stay_id;

  const [stayRes, experienceRes] = await Promise.all([
    stayId
      ? supabase.from("stays").select("property_name").eq("id", stayId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("experiences")
      .select("title, short_description, description, category, cuisine, duration_minutes, provider_id, currency")
      .eq("id", item.experience_id)
      .maybeSingle(),
  ]);

  const stayPropertyName = stayId
    ? ((stayRes.data as { property_name: string } | null)?.property_name ?? "Your stay")
    : null;
  type ExperienceRow = {
    title: string;
    short_description: string | null;
    description: string | null;
    category: string;
    cuisine: string | null;
    duration_minutes: number;
    provider_id: string;
    currency: string;
  };
  const experience = experienceRes.data as ExperienceRow | null;

  let providerDisplayName = "Felyn host";
  let providerPhotoUrl: string | null = null;
  let galleryRows: { image_url: string; caption: string | null }[] = [];
  let experienceImageUrl: string | null = null;

  if (experience) {
    const [providerRes, galleryRes] = await Promise.all([
      supabase
        .from("provider_public_profiles")
        .select("display_name, profile_photo_url")
        .eq("id", experience.provider_id)
        .maybeSingle(),
      supabase
        .from("experience_gallery")
        .select("image_url, caption, sort_order")
        .eq("experience_id", item.experience_id)
        .order("sort_order", { ascending: true }),
    ]);
    const provider = providerRes.data as { display_name: string; profile_photo_url: string | null } | null;
    providerDisplayName = provider?.display_name ?? "Felyn host";
    providerPhotoUrl = provider?.profile_photo_url ?? null;
    galleryRows = ((galleryRes.data as { image_url: string; caption: string | null }[] | null) ?? []).map((row) => ({
      image_url: row.image_url,
      caption: row.caption,
    }));
    experienceImageUrl = galleryRows[0]?.image_url ?? null;
  }

  return {
    id: item.id,
    stayId,
    stayPropertyName,
    experienceId: item.experience_id,
    experienceTitle: experience?.title ?? "Experience no longer available",
    experienceImageUrl,
    providerDisplayName,
    plannedDate: item.planned_date,
    plannedMoment: item.planned_moment,
    preferredTime: normalizeTime(item.preferred_time),
      confirmedStartAt: item.confirmed_start_at,
    guestCount: item.guest_count,
    pricePerPerson: item.price_per_person,
    currency: experience?.currency ?? "EUR",
    status: item.status,
    declineReason: item.decline_reason,
    createdAt: item.created_at,
    cancelledBy: item.cancelled_by,
    cancellationReason: item.cancellation_reason,
    cancellationNote: item.cancellation_note,
    hostNote: item.host_note,
    providerId: experience?.provider_id ?? null,
    providerPhotoUrl,
    decidedAt: item.decided_at,
    cancelledAt: item.cancelled_at,
    experience: experience
      ? {
          shortDescription: experience.short_description,
          description: experience.description,
          category: experience.category,
          cuisine: experience.cuisine,
          durationMinutes: experience.duration_minutes,
          gallery: galleryRows,
        }
      : null,
  };
}
