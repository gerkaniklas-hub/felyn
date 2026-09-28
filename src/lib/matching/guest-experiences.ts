import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingItemStatus, CancelledBy, CancelReason, DeclineReason } from "./booking-status";
import type { PlannedMoment } from "./plan";

export type GuestExperienceItem = {
  id: string;
  stayId: string;
  stayPropertyName: string;
  experienceId: string;
  experienceTitle: string;
  providerDisplayName: string;
  plannedDate: string;
  plannedMoment: PlannedMoment;
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
  const requests = (requestRows as { id: string; stay_id: string }[] | null) ?? [];
  if (requests.length === 0) return [];

  const requestIds = requests.map((r) => r.id);
  const stayIdByRequest = new Map(requests.map((r) => [r.id, r.stay_id]));
  const stayIds = [...new Set(requests.map((r) => r.stay_id))];

  const [itemsRes, staysRes] = await Promise.all([
    supabase
      .from("booking_request_items")
      .select(
        "id, booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status, decline_reason, created_at, cancelled_by, cancellation_reason, cancellation_note",
      )
      .in("booking_request_id", requestIds)
      .order("planned_date", { ascending: false }),
    supabase.from("stays").select("id, property_name").in("id", stayIds),
  ]);

  type ItemRow = {
    id: string;
    booking_request_id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
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
  const { data: providerRows } =
    providerIds.length > 0
      ? await supabase.from("provider_public_profiles").select("id, display_name").in("id", providerIds)
      : { data: [] as { id: string; display_name: string }[] };
  const providerNameById = new Map(
    ((providerRows as { id: string; display_name: string }[] | null) ?? []).map((p) => [p.id, p.display_name]),
  );

  // A since-unpublished experience falls outside "Guests read published
  // experiences" (0002) and won't resolve here — the item still gets a
  // row (guest history is never silently dropped), just with a fallback
  // title rather than a broken page.
  return items.map((item) => {
    const experience = experienceById.get(item.experience_id);
    const stayId = stayIdByRequest.get(item.booking_request_id)!;
    return {
      id: item.id,
      stayId,
      stayPropertyName: stayNameById.get(stayId) ?? "Your stay",
      experienceId: item.experience_id,
      experienceTitle: experience?.title ?? "Experience no longer available",
      providerDisplayName: experience ? (providerNameById.get(experience.provider_id) ?? "Felyn host") : "Felyn host",
      plannedDate: item.planned_date,
      plannedMoment: item.planned_moment,
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
