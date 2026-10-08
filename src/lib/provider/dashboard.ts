import type { SupabaseClient } from "@supabase/supabase-js";
import {
  NO_TRIP_LINKED_LABEL,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
  type CancelledBy,
  type CancelReason,
  type DeclineReason,
} from "@/lib/matching/booking-status";
import type { PlannedMoment } from "@/lib/matching/plan";
import { normalizeTime } from "@/lib/matching/slot-availability";
import { DIETARY_TYPES, OCCASIONS, type DietaryType, type Occasion } from "@/lib/onboarding/constants";

export type ProviderIdentity = {
  id: string;
  displayName: string;
  profilePhotoUrl: string | null;
  bio: string | null;
  baseLocation: string | null;
  languages: string[];
  specialties: string[];
  publishedExperienceCount: number;
};

/**
 * P1: the signed-in provider's OWN record — looked up strictly by
 * `providers.user_id = userId` (RLS-scoped by the existing "Providers
 * manage their own profile" policy, so this can only ever return that
 * user's own row). Never falls back to a seeded/other provider. Reads
 * directly from `providers`/`provider_languages`/`experiences` rather than
 * the guest-facing `provider_public_profiles` view, since that view hides
 * providers with zero published experiences — the dashboard must still
 * show a provider's own profile before they've published anything.
 */
export async function getProviderIdentity(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderIdentity | null> {
  const { data: provider } = await supabase
    .from("providers")
    .select("id, display_name, profile_photo_url, bio, base_location")
    .eq("user_id", userId)
    .maybeSingle();

  if (!provider) return null;

  const [languagesRes, experiencesRes] = await Promise.all([
    supabase.from("provider_languages").select("language").eq("provider_id", provider.id),
    supabase.from("experiences").select("id, published").eq("provider_id", provider.id),
  ]);

  const languages = ((languagesRes.data as { language: string }[] | null) ?? []).map(
    (row) => row.language,
  );

  const experienceRows = (experiencesRes.data as { id: string; published: boolean }[] | null) ?? [];
  const publishedIds = experienceRows.filter((row) => row.published).map((row) => row.id);

  const { data: attributeRows } =
    publishedIds.length > 0
      ? await supabase
          .from("experience_attributes")
          .select("attribute_value")
          .in("experience_id", publishedIds)
          .eq("attribute_type", "specialty")
      : { data: [] as { attribute_value: string }[] };

  const specialties = [...new Set(((attributeRows as { attribute_value: string }[] | null) ?? []).map((row) => row.attribute_value))];

  return {
    id: provider.id,
    displayName: provider.display_name,
    profilePhotoUrl: provider.profile_photo_url,
    bio: provider.bio,
    baseLocation: provider.base_location,
    languages,
    specialties,
    publishedExperienceCount: publishedIds.length,
  };
}

/** P1.4: WITHDRAWN never reaches the provider at all — see getProviderRequestItems. */
export type ProviderVisibleItemStatus = Exclude<BookingItemStatus, "WITHDRAWN">;

/** One stay's dietary requirement, plain-labelled for display — never tied to a specific guest's name. */
export type ProviderDietaryRequirement = { label: string; guestCount: number | null; notes: string | null };

export type ProviderRequestItem = {
  itemId: string;
  requestId: string;
  /** P1.1: this ITEM's own status — independent of the parent request's status (see booking-status.ts). */
  status: ProviderVisibleItemStatus;
  /**
   * Booking-lifecycle milestone: widened to include "WITHDRAWN" — a
   * CONFIRMED or DECLINED item stays visible here (see
   * getProviderRequestItems) even after the guest withdraws the whole
   * parent request, so this field must be able to say so honestly rather
   * than pretend the parent is still REQUESTED/CONFIRMED. Not currently
   * read by any UI, but the type should never lie about what's possible.
   */
  requestStatus: ActiveBookingRequestStatus | "WITHDRAWN";
  stayName: string;
  /** The stay's free-text location (see 0007's "Providers view stays with their requests" — already readable). */
  stayLocation: string;
  /**
   * The guest's own first name, as they entered it at signup — resolved via
   * the narrowly-scoped `get_guest_first_names_for_provider` RPC (0013).
   * Never a full name, email, phone or any other account field. Null when
   * unavailable (e.g. the guest never set one, or the RPC/migration isn't
   * present yet) — the UI falls back to the stay name, never a placeholder.
   */
  guestFirstName: string | null;
  /** Human labels for the stay's selected occasions (see onboarding/constants.ts) — empty if none given. */
  occasionLabels: string[];
  /** The stay's dietary requirements — relevant context for catering, not tied to any one guest's identity. */
  dietary: ProviderDietaryRequirement[];
  plannedDate: string;
  plannedMoment: PlannedMoment;
  /** This item's OWN group size — may be smaller than the stay's guest count. */
  guestCount: number;
  /** 'HH:MM' the guest would prefer — a preference only, never a confirmed appointment. */
  preferredTime: string | null;
  /** The guest's optional plain-text note for this experience. Visible only to this experience's provider (and the guest). */
  hostNote: string | null;
  /** When this item was added to the request — later additions arrive after the original submission. */
  requestedAt: string;
  experienceTitle: string;
  experienceImageUrl: string | null;
  pricePerPerson: number;
  currency: string;
  /** P1.2: set only once status is DECLINED — see booking-status.ts. */
  declineReason: DeclineReason | null;
  declineNote: string | null;
  /** Stage 2c-B: set only once status is DECLINED — anchors the 30-day messaging window (see getMessagingWindowState). */
  decidedAt: string | null;
  /**
   * 0033 acceptance snapshot, set together when the host accepts and never
   * changed afterwards; null before acceptance and on bookings accepted
   * before 0033. confirmedStartAt is the authoritative start instant;
   * acceptedDurationMinutes the experience's length that was agreed.
   */
  acceptedAt: string | null;
  confirmedStartAt: string | null;
  acceptedDurationMinutes: number | null;
  /** Booking-lifecycle milestone: set only once status is CANCELLED — see booking-status.ts. */
  cancelledAt: string | null;
  cancelledBy: CancelledBy | null;
  cancellationReason: CancelReason | null;
  cancellationNote: string | null;
};

/**
 * The host Messages inbox's item shape: a ProviderRequestItem that may also
 * be WITHDRAWN, kept only as read-only conversation history (see
 * getProviderMessagingItems). Never used by the Requests/Dashboard/Calendar
 * surfaces, which keep the narrower ProviderRequestItem.
 */
export type ProviderMessagingItem = Omit<ProviderRequestItem, "status"> & { status: BookingItemStatus };

/**
 * P1/P1.1: every booking_request_item for experiences belonging to this
 * provider. Each item's OWN `status` (REQUESTED/CONFIRMED/DECLINED, from
 * 0009) is what the dashboard/calendar/requests pages actually group and
 * act on — the parent request's status is never written to by any
 * provider action (see lib/provider/actions.ts), it's only used here to
 * decide inclusion.
 *
 * Booking-lifecycle milestone: inclusion rule, per item —
 *   - WITHDRAWN items are never shown (guest's own per-item "never mind",
 *     unchanged from before).
 *   - CONFIRMED and DECLINED items are shown REGARDLESS of the parent
 *     request's status. A provider's own decision is permanent history —
 *     if the guest later withdraws the rest of their plan, an experience
 *     this provider already confirmed doesn't stop being their
 *     commitment, and one they already declined doesn't stop being their
 *     own past decision. This mirrors deleteStay's existing reasoning
 *     (src/app/home/actions.ts) that a decided item under an otherwise-
 *     withdrawn request is real marketplace history, not something that
 *     should vanish — that logic already assumes this state exists on
 *     the guest side; this is the provider-side equivalent.
 *   - A still-pending (REQUESTED) item is shown only while its parent
 *     request is still REQUESTED/CONFIRMED (unchanged from before) — once
 *     the guest withdraws the whole request, an item nobody ever decided
 *     on is no longer something to act on, and correctly disappears.
 *
 * Filtered explicitly by experience_id in this query (not left to RLS
 * alone), with the provider SELECT/UPDATE policies (0007/0009) as the
 * database-level backstop — a provider can never see or change another
 * provider's items even if this filter were ever removed. This function is
 * the single shared source for every host-facing booking surface (dashboard,
 * requests list, item detail, calendar) — fixing it here fixes all of them at
 * once. Host Messages uses getProviderMessagingItems below instead: the same
 * items plus WITHDRAWN ones, as read-only conversation history.
 */
export async function getProviderRequestItems(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ProviderRequestItem[]> {
  const items = await loadProviderItems(supabase, providerId, { includeWithdrawn: false });
  return items.filter((item): item is ProviderRequestItem => item.status !== "WITHDRAWN");
}

/**
 * Host Messages only: everything getProviderRequestItems returns, plus the
 * provider's WITHDRAWN items, so a conversation the guest had with the host
 * before withdrawing stays readable as history (whether one item or the
 * whole request was withdrawn). Sending stays impossible: the 0014/0021
 * messages INSERT policies never allow WITHDRAWN, and the inbox shows such a
 * conversation as closed (getMessagingWindowState). Nothing else may use
 * this — withdrawn items must stay out of Requests, Dashboard and Calendar.
 */
export async function getProviderMessagingItems(
  supabase: SupabaseClient,
  providerId: string,
): Promise<ProviderMessagingItem[]> {
  return loadProviderItems(supabase, providerId, { includeWithdrawn: true });
}

async function loadProviderItems(
  supabase: SupabaseClient,
  providerId: string,
  { includeWithdrawn }: { includeWithdrawn: boolean },
): Promise<ProviderMessagingItem[]> {
  const { data: experienceRows } = await supabase
    .from("experiences")
    .select("id, title, currency")
    .eq("provider_id", providerId);

  type ExperienceRow = { id: string; title: string; currency: string };
  const experiences = (experienceRows as ExperienceRow[] | null) ?? [];
  if (experiences.length === 0) return [];

  const experienceById = new Map(experiences.map((row) => [row.id, row]));
  const experienceIds = experiences.map((row) => row.id);

  const [itemsRes, galleryRes] = await Promise.all([
    supabase
      .from("booking_request_items")
      .select(
        "id, booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time, host_note, status, decline_reason, decline_note, decided_at, created_at, cancelled_at, cancelled_by, cancellation_reason, cancellation_note, accepted_at, confirmed_start_at, duration_minutes",
      )
      .in("experience_id", experienceIds),
    supabase
      .from("experience_gallery")
      .select("experience_id, image_url, sort_order")
      .in("experience_id", experienceIds)
      .order("sort_order", { ascending: true }),
  ]);

  type ItemRow = {
    id: string;
    booking_request_id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    guest_count: number;
    price_per_person: number;
    preferred_time: string | null;
    host_note: string | null;
    status: BookingItemStatus;
    decline_reason: DeclineReason | null;
    decline_note: string | null;
    decided_at: string | null;
    accepted_at: string | null;
    confirmed_start_at: string | null;
    duration_minutes: number | null;
    created_at: string;
    cancelled_at: string | null;
    cancelled_by: CancelledBy | null;
    cancellation_reason: CancelReason | null;
    cancellation_note: string | null;
  };
  const items = (itemsRes.data as ItemRow[] | null) ?? [];
  if (items.length === 0) return [];

  // Rows arrive ordered by sort_order, so the first one seen per experience is its primary image.
  const primaryImageByExperience = new Map<string, string>();
  for (const row of (galleryRes.data as { experience_id: string; image_url: string }[] | null) ?? []) {
    if (!primaryImageByExperience.has(row.experience_id)) {
      primaryImageByExperience.set(row.experience_id, row.image_url);
    }
  }

  // Booking-lifecycle milestone: no longer filtered to REQUESTED/CONFIRMED
  // here — a WITHDRAWN parent must still be readable so a CONFIRMED/
  // DECLINED item under it can stay visible (see the per-item rule below
  // and this function's own doc comment).
  const requestIds = [...new Set(items.map((row) => row.booking_request_id))];
  const { data: requestRows } = await supabase
    .from("booking_requests")
    .select("id, status, stay_id")
    .in("id", requestIds);

  // stay_id is null for a guest's request made without a trip (0026).
  type RequestRow = { id: string; status: ActiveBookingRequestStatus | "WITHDRAWN"; stay_id: string | null };
  const requests = (requestRows as RequestRow[] | null) ?? [];
  if (requests.length === 0) return [];
  const requestById = new Map(requests.map((row) => [row.id, row]));

  const stayIds = [...new Set(requests.map((row) => row.stay_id).filter((id): id is string => id !== null))];
  const staylessRequestIds = requests.filter((row) => row.stay_id === null).map((row) => row.id);
  const [stayRowsRes, occasionRowsRes, dietaryRowsRes, guestNamesRes, staylessGuestNamesRes] = await Promise.all([
    supabase.from("stays").select("id, property_name, location_text").in("id", stayIds),
    // Additive provider SELECT policy from 0013 — see that migration's comment.
    supabase.from("stay_occasions").select("stay_id, occasion").in("stay_id", stayIds),
    supabase.from("stay_dietary_requirements").select("stay_id, type, guest_count, notes").in("stay_id", stayIds),
    // Narrowly-scoped RPC from 0013 — returns a row only for a stay this
    // provider genuinely has a booking on (enforced by auth.uid() inside the
    // function, never by this array). Tolerates 0013 not being applied yet —
    // a failed call just means no guest names are shown — but logs it
    // rather than failing silently: this exact gap (a missing/erroring
    // migration masquerading as "no data") is what let this go unnoticed
    // until it was actually investigated. Occasion/dietary get the same
    // treatment for the same reason.
    supabase.rpc("get_guest_first_names_for_provider", { stay_ids: stayIds }),
    // Requests without a trip have no stay to look the guest up by: 0026's
    // request-keyed RPC, scoped the same way (only requests this provider
    // hosts, enforced inside the function). Only called when such requests exist.
    staylessRequestIds.length > 0
      ? supabase.rpc("get_guest_first_names_for_provider_requests", { request_ids: staylessRequestIds })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (occasionRowsRes.error) console.error("getProviderRequestItems: stay_occasions query failed", occasionRowsRes.error);
  if (dietaryRowsRes.error) console.error("getProviderRequestItems: stay_dietary_requirements query failed", dietaryRowsRes.error);
  if (guestNamesRes.error) console.error("getProviderRequestItems: get_guest_first_names_for_provider RPC failed", guestNamesRes.error);
  if (staylessGuestNamesRes.error) {
    console.error("getProviderRequestItems: get_guest_first_names_for_provider_requests RPC failed", staylessGuestNamesRes.error);
  }
  const guestFirstNameByStaylessRequest = new Map(
    ((staylessGuestNamesRes.data as { booking_request_id: string; first_name: string | null }[] | null) ?? []).map((row) => [
      row.booking_request_id,
      row.first_name,
    ]),
  );

  type StayRow = { id: string; property_name: string; location_text: string };
  const stayById = new Map(((stayRowsRes.data as StayRow[] | null) ?? []).map((row) => [row.id, row]));

  const occasionLabelsByStay = new Map<string, string[]>();
  for (const row of (occasionRowsRes.data as { stay_id: string; occasion: Occasion }[] | null) ?? []) {
    const label = OCCASIONS.find((o) => o.value === row.occasion)?.label ?? row.occasion;
    const list = occasionLabelsByStay.get(row.stay_id) ?? [];
    list.push(label);
    occasionLabelsByStay.set(row.stay_id, list);
  }

  const dietaryByStay = new Map<string, ProviderDietaryRequirement[]>();
  for (const row of (dietaryRowsRes.data as
    | { stay_id: string; type: DietaryType; guest_count: number | null; notes: string | null }[]
    | null) ?? []) {
    const label = DIETARY_TYPES.find((d) => d.value === row.type)?.label ?? row.type;
    const list = dietaryByStay.get(row.stay_id) ?? [];
    list.push({ label, guestCount: row.guest_count, notes: row.notes });
    dietaryByStay.set(row.stay_id, list);
  }

  const guestFirstNameByStay = new Map(
    ((guestNamesRes.data as { stay_id: string; first_name: string | null }[] | null) ?? []).map((row) => [
      row.stay_id,
      row.first_name,
    ]),
  );

  const results: ProviderMessagingItem[] = [];
  for (const item of items) {
    // P1.4: a guest-withdrawn item never reaches the provider's booking
    // surfaces — not the dashboard, not Requests, not the calendar. Unlike
    // DECLINED (a provider decision worth keeping visible as their own
    // history), WITHDRAWN is the guest's own "never mind" before anyone acted
    // on it. Only host Messages asks for it (includeWithdrawn), as history.
    if (item.status === "WITHDRAWN" && !includeWithdrawn) continue;
    const request = requestById.get(item.booking_request_id);
    if (!request) continue; // orphaned row — shouldn't happen, defensive only

    // Booking-lifecycle milestone: see getProviderRequestItems' doc comment
    // for the full rule. A decided item (CONFIRMED/DECLINED) is permanent
    // history and stays visible no matter what the guest does to the rest
    // of the request; a still-pending (REQUESTED) item is only shown while
    // its parent request is still active. A WITHDRAWN item (only reaching
    // here for Messages) is history too, even under a withdrawn request.
    const parentIsActive = request.status === "REQUESTED" || request.status === "CONFIRMED";
    const itemIsHistory =
      item.status === "CONFIRMED" || item.status === "DECLINED" || item.status === "CANCELLED" || item.status === "WITHDRAWN";
    if (!parentIsActive && !itemIsHistory) continue;

    const experience = experienceById.get(item.experience_id);
    if (!experience) continue;
    const stay = request.stay_id ? stayById.get(request.stay_id) : undefined;

    results.push({
      itemId: item.id,
      requestId: request.id,
      status: item.status,
      requestStatus: request.status,
      stayName: request.stay_id ? (stay?.property_name ?? "A Felyn stay") : NO_TRIP_LINKED_LABEL,
      stayLocation: stay?.location_text ?? "",
      guestFirstName: request.stay_id
        ? (guestFirstNameByStay.get(request.stay_id) ?? null)
        : (guestFirstNameByStaylessRequest.get(request.id) ?? null),
      occasionLabels: request.stay_id ? (occasionLabelsByStay.get(request.stay_id) ?? []) : [],
      dietary: request.stay_id ? (dietaryByStay.get(request.stay_id) ?? []) : [],
      plannedDate: item.planned_date,
      plannedMoment: item.planned_moment,
      guestCount: item.guest_count,
      preferredTime: normalizeTime(item.preferred_time),
      hostNote: item.host_note,
      requestedAt: item.created_at,
      experienceTitle: experience.title,
      experienceImageUrl: primaryImageByExperience.get(item.experience_id) ?? null,
      pricePerPerson: item.price_per_person,
      currency: experience.currency,
      declineReason: item.decline_reason,
      declineNote: item.decline_note,
      decidedAt: item.decided_at,
      acceptedAt: item.accepted_at,
      confirmedStartAt: item.confirmed_start_at,
      acceptedDurationMinutes: item.duration_minutes,
      cancelledAt: item.cancelled_at,
      cancelledBy: item.cancelled_by,
      cancellationReason: item.cancellation_reason,
      cancellationNote: item.cancellation_note,
    });
  }

  return results;
}
