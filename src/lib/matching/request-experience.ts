"use server";

import { scheduleEmailDispatch } from "@/lib/email/dispatcher";
import { assertGuestJourney } from "@/lib/journey-server";
import { todayISODate } from "@/lib/onboarding/stay-dates";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { submitBookingRequest, type SubmitBookingRequestItem } from "./booking-requests";
import { getPublishedExperiences } from "./explore";
import { getHardFilteredExperiences } from "./hard-filter";
import { HOST_NOTE_MAX_LENGTH, PLANNED_MOMENTS, getPlannedMomentLabel } from "./plan";
import { getGuestCountRange, isAvailableAt, isPreferredTimeAllowed } from "./slot-availability";
import { formatDayLabel } from "./timeline";

export type RequestExperienceInput = SubmitBookingRequestItem & {
  /** One of the guest's own stays to add this to, or null to request it without a trip. */
  stayId: string | null;
};

export type RequestExperienceResult = { ok: true; itemId: string } | { ok: false; error: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Request experience" from Explore / Home: one experience line item, with
 * or without a trip. Reuses the existing request system; nothing here is a
 * second booking model.
 *
 * - With a stay: exactly the planner's submitBookingRequest for that stay
 *   (same validation, appended to the stay's one active request or starting
 *   it), so the item shows in that stay's planner as if added there.
 * - Without a stay: a booking_requests row with stay_id = NULL (0026) and
 *   the item, validated with the planner's own rules minus the stay-based
 *   ones: published, available on that date and time of day, the
 *   experience's guest limits, preferred-time and note rules, not in the
 *   past.
 *
 * Returns the new line item's id for its booking detail page (/bookings/<id>).
 */
export async function requestExperience(input: RequestExperienceInput): Promise<RequestExperienceResult> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You need to be signed in to request experiences." };

  const item: SubmitBookingRequestItem = {
    experienceId: input.experienceId,
    plannedDate: input.plannedDate,
    plannedMoment: input.plannedMoment,
    guestCount: input.guestCount,
    preferredTime: input.preferredTime,
    hostNote: input.hostNote,
  };

  if (input.stayId) {
    // Same pool the planner offers for this trip (its location, dates, budget, dietary needs).
    // Checked first only to give a clear message; submitBookingRequest re-checks everything.
    const eligible = await getHardFilteredExperiences(supabase, input.stayId);
    if (!eligible.some((experience) => experience.id === item.experienceId)) {
      return {
        ok: false,
        error: "This experience doesn't fit this trip (its location, dates or trip preferences). You can still request it without a trip.",
      };
    }
    const result = await submitBookingRequest(input.stayId, [item]);
    if (!result.ok) return result;
    const itemId = await findNewItemId(supabase, result.requestId, item);
    return itemId ? { ok: true, itemId } : { ok: false, error: "Your request was sent, but we couldn't open it. See Your experiences." };
  }

  const experience = (await getPublishedExperiences(supabase)).find((candidate) => candidate.id === item.experienceId);
  if (!experience) return { ok: false, error: "This experience is no longer available." };

  if (!DATE_PATTERN.test(item.plannedDate) || item.plannedDate < todayISODate()) {
    return { ok: false, error: "Choose a date from today onwards." };
  }
  if (!PLANNED_MOMENTS.some((moment) => moment.value === item.plannedMoment)) {
    return { ok: false, error: "Choose a time of day." };
  }
  if (!isAvailableAt(experience, item.plannedDate, item.plannedMoment)) {
    return {
      ok: false,
      error: `${experience.title} isn't available on ${formatDayLabel(item.plannedDate)} in the ${getPlannedMomentLabel(item.plannedMoment).toLowerCase()}.`,
    };
  }
  // No stay, so the only cap is the experience's own group size.
  const range = getGuestCountRange(experience, experience.max_guests);
  if (!Number.isInteger(item.guestCount) || item.guestCount < range.min || item.guestCount > range.max) {
    return { ok: false, error: `${experience.title} needs between ${range.min} and ${range.max} guests.` };
  }
  if (item.preferredTime != null && !isPreferredTimeAllowed(experience, item.plannedDate, item.plannedMoment, item.preferredTime)) {
    return { ok: false, error: `The preferred time for ${experience.title} doesn't match its date and time of day.` };
  }
  const note = item.hostNote?.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim() || null;
  if (note && note.length > HOST_NOTE_MAX_LENGTH) {
    return { ok: false, error: `Your note is too long (max ${HOST_NOTE_MAX_LENGTH} characters).` };
  }

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .insert({ user_id: user.id, stay_id: null, estimated_total: experience.price_per_person * item.guestCount })
    .select("id")
    .single();
  if (requestError || !request) return { ok: false, error: "We couldn't send your request. Please try again." };

  const { data: inserted, error: itemError } = await supabase
    .from("booking_request_items")
    .insert({
      booking_request_id: request.id,
      experience_id: experience.id,
      planned_date: item.plannedDate,
      planned_moment: item.plannedMoment,
      guest_count: item.guestCount,
      price_per_person: experience.price_per_person,
      preferred_time: item.preferredTime,
      host_note: note,
    })
    .select("id")
    .single();
  if (itemError || !inserted) {
    await supabase.from("booking_requests").delete().eq("id", request.id);
    return { ok: false, error: "We couldn't send your request. Please try again." };
  }
  scheduleEmailDispatch();
  return { ok: true, itemId: inserted.id as string };
}

/** The line item submitBookingRequest just added (the request may already hold others). */
async function findNewItemId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  requestId: string,
  item: SubmitBookingRequestItem,
): Promise<string | null> {
  const { data } = await supabase
    .from("booking_request_items")
    .select("id")
    .eq("booking_request_id", requestId)
    .eq("experience_id", item.experienceId)
    .eq("planned_date", item.plannedDate)
    .eq("planned_moment", item.plannedMoment)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
