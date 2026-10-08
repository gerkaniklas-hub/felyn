"use server";

import { getHardFilteredExperiences } from "@/lib/matching/hard-filter";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  GUEST_CANCEL_REASONS,
  CANCELLATION_NOTE_MAX_LENGTH,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
  type CancelledBy,
  type CancelReason,
  type DeclineReason,
} from "./booking-status";
import { HOST_NOTE_MAX_LENGTH, PLANNED_MOMENTS, getPlannedMomentLabel, type PlannedMoment } from "./plan";
import { getGuestCountRange, isAvailableAt, isPreferredTimeAllowed, normalizeTime } from "./slot-availability";
import { formatDayLabel } from "./timeline";
import { assertGuestJourney } from "@/lib/journey-server";
import { scheduleEmailDispatch } from "@/lib/email/dispatcher";

export type SubmitBookingRequestItem = {
  experienceId: string;
  plannedDate: string;
  plannedMoment: PlannedMoment;
  /** The guest's own group size for THIS experience (not necessarily the stay's). */
  guestCount: number;
  /** 'HH:MM' preference, or null for none. Never a confirmed appointment. */
  preferredTime: string | null;
  /** Optional plain-text note for the provider. */
  hostNote: string | null;
};

export type SubmitBookingRequestResult =
  | {
      ok: true;
      requestId: string;
      /** The WHOLE active request's estimated total after this submission (not just the new items). */
      estimatedTotal: number;
      currency: string;
      /** How many items this submission added. */
      itemCount: number;
      /** True when the items were appended to an already-active request rather than starting a new one. */
      addedToExistingRequest: boolean;
    }
  | { ok: false; error: string };

export type ActiveBookingRequestItem = {
  id: string;
  experienceId: string;
  plannedDate: string;
  plannedMoment: PlannedMoment;
  guestCount: number;
  pricePerPerson: number;
  /** 'HH:MM' preference, or null. */
  preferredTime: string | null;
  hostNote: string | null;
  /** P1.1: independent of the parent request's status — see booking-status.ts. */
  status: BookingItemStatus;
  /**
   * P1.3: the structured reason only — set only when DECLINED. The
   * provider's free-text `decline_note` stays provider/internal-facing and
   * is never selected here.
   */
  declineReason: DeclineReason | null;
  /** When this item was added — lets the guest/provider tell newer additions from earlier ones. */
  createdAt: string;
  /** Stage 2c-B: set only when DECLINED — anchors the 30-day messaging window (see getMessagingWindowState). */
  decidedAt: string | null;
  /** Booking-lifecycle milestone: set only when CANCELLED — see booking-status.ts. */
  cancelledAt: string | null;
  cancelledBy: CancelledBy | null;
  cancellationReason: CancelReason | null;
  cancellationNote: string | null;
};

export type ActiveBookingRequest = {
  id: string;
  status: ActiveBookingRequestStatus;
  estimatedTotal: number;
  items: ActiveBookingRequestItem[];
};

const ACTIVE_STATUSES: ActiveBookingRequestStatus[] = ["REQUESTED", "CONFIRMED"];
const ITEM_ACTIVE_STATUSES: BookingItemStatus[] = ["REQUESTED", "CONFIRMED"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RACE_ERROR = "Something changed while you were requesting. Please refresh and try again.";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** Plain text only: control characters dropped, trimmed, length-capped. Rendered as text everywhere (never as HTML). */
function normalizeHostNote(note: string | null): { ok: true; value: string | null } | { ok: false } {
  if (note == null) return { ok: true, value: null };
  const cleaned = note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (cleaned.length > HOST_NOTE_MAX_LENGTH) return { ok: false };
  return { ok: true, value: cleaned.length > 0 ? cleaned : null };
}

/**
 * Server-side entry point for "Request these experiences" — for BOTH the
 * guest's first request and every later addition. The database allows only
 * ONE active (REQUESTED/CONFIRMED) request per stay (0006's partial unique
 * index), so when one already exists the new items are APPENDED to it as
 * new booking_request_items (status REQUESTED, independent of every other
 * item's status) — never a second request, and no existing item is touched.
 * The request's estimated_total is recomputed from the database afterwards.
 *
 * Nothing the client sends is trusted beyond "which experience, when, how
 * many, what time, what note": price comes from a fresh read of the
 * experiences (via the same hard filter the planner uses), the stay's
 * ownership is re-verified via the RLS-scoped getStay, and each item's date,
 * moment, guest count, time preference and note are validated here.
 */
export async function submitBookingRequest(
  stayId: string,
  items: SubmitBookingRequestItem[],
): Promise<SubmitBookingRequestResult> {
  await assertGuestJourney();
  if (items.length === 0) {
    return { ok: false, error: "Select at least one experience before requesting." };
  }

  const seenSlots = new Set<string>();
  for (const item of items) {
    const key = `${item.plannedDate}|${item.plannedMoment}`;
    if (seenSlots.has(key)) {
      return {
        ok: false,
        error: "Two or more experiences share the same date and moment — resolve that before requesting.",
      };
    }
    seenSlots.add(key);
  }

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in to request experiences." };
  }

  const stay = await getStay(supabase, stayId);
  if (!stay) {
    return { ok: false, error: "We couldn't find this stay." };
  }

  // Authoritative experience data (price, group limits, availability) — the
  // same RLS-scoped hard filter the planner itself is built from.
  const eligible = await getHardFilteredExperiences(supabase, stay.id);
  const experienceById = new Map(eligible.map((experience) => [experience.id, experience]));

  const itemsToInsert: {
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    guest_count: number;
    price_per_person: number;
    preferred_time: string | null;
    host_note: string | null;
  }[] = [];

  for (const item of items) {
    const experience = experienceById.get(item.experienceId);
    if (!experience) {
      return { ok: false, error: "One or more of your selected experiences is no longer available." };
    }
    if (
      !DATE_PATTERN.test(item.plannedDate) ||
      item.plannedDate < stay.check_in ||
      item.plannedDate >= stay.check_out ||
      !PLANNED_MOMENTS.some((m) => m.value === item.plannedMoment)
    ) {
      return { ok: false, error: `${experience.title} has a date or time of day outside your stay.` };
    }
    if (!isAvailableAt(experience, item.plannedDate, item.plannedMoment)) {
      return {
        ok: false,
        error: `${experience.title} isn't available on ${formatDayLabel(item.plannedDate)} in the ${getPlannedMomentLabel(item.plannedMoment).toLowerCase()}.`,
      };
    }

    const range = getGuestCountRange(experience, stay.guest_count);
    if (!Number.isInteger(item.guestCount) || item.guestCount < range.min || item.guestCount > range.max) {
      return { ok: false, error: `${experience.title} needs between ${range.min} and ${range.max} guests.` };
    }

    if (
      item.preferredTime != null &&
      !isPreferredTimeAllowed(experience, item.plannedDate, item.plannedMoment, item.preferredTime)
    ) {
      return {
        ok: false,
        error: `The preferred time for ${experience.title} doesn't match its date and time of day.`,
      };
    }

    const note = normalizeHostNote(item.hostNote);
    if (!note.ok) {
      return {
        ok: false,
        error: `Your note for ${experience.title} is too long (max ${HOST_NOTE_MAX_LENGTH} characters).`,
      };
    }

    itemsToInsert.push({
      experience_id: experience.id,
      planned_date: item.plannedDate,
      planned_moment: item.plannedMoment,
      guest_count: item.guestCount,
      price_per_person: experience.price_per_person,
      preferred_time: item.preferredTime,
      host_note: note.value,
    });
  }

  const currency = experienceById.get(items[0].experienceId)?.currency ?? "EUR";

  /** Only the columns a guest may write (0031) — the database sets price_per_person from the experience itself. */
  const insertRows = (bookingRequestId: string) =>
    itemsToInsert.map((row) => ({
      booking_request_id: bookingRequestId,
      experience_id: row.experience_id,
      planned_date: row.planned_date,
      planned_moment: row.planned_moment,
      guest_count: row.guest_count,
      preferred_time: row.preferred_time,
      host_note: row.host_note,
    }));

  /** Appends to an already-active request this guest owns; recomputes its total from the database. */
  async function appendToRequest(requestId: string): Promise<SubmitBookingRequestResult> {
    // A new item must not land on a slot another ACTIVE item already holds —
    // the same "one experience per date+moment within a request" rule the
    // first submission has always enforced. Declined/withdrawn items free their slot.
    const { data: activeRows } = await supabase
      .from("booking_request_items")
      .select("planned_date, planned_moment")
      .eq("booking_request_id", requestId)
      .in("status", ITEM_ACTIVE_STATUSES);
    const taken = new Set(
      ((activeRows as { planned_date: string; planned_moment: string }[] | null) ?? []).map(
        (row) => `${row.planned_date}|${row.planned_moment}`,
      ),
    );
    for (const row of itemsToInsert) {
      if (taken.has(`${row.planned_date}|${row.planned_moment}`)) {
        return {
          ok: false,
          error: `You already have an experience requested for ${formatDayLabel(row.planned_date)} in the ${getPlannedMomentLabel(row.planned_moment).toLowerCase()}. Withdraw it first, or choose another moment.`,
        };
      }
    }

    const { error: insertError } = await supabase.from("booking_request_items").insert(insertRows(requestId));
    if (insertError) {
      return { ok: false, error: "We couldn't add these to your request. Please try again." };
    }

    const estimatedTotal = await readEstimatedTotal(supabase, requestId);
    scheduleEmailDispatch();
    return {
      ok: true,
      requestId,
      estimatedTotal,
      currency,
      itemCount: itemsToInsert.length,
      addedToExistingRequest: true,
    };
  }

  async function findOwnActiveRequestId(): Promise<string | null> {
    const { data: existing } = await supabase
      .from("booking_requests")
      .select("id, user_id")
      .eq("stay_id", stay!.id)
      .in("status", ACTIVE_STATUSES)
      .maybeSingle();
    return existing && existing.user_id === user!.id ? existing.id : null;
  }

  const existingRequestId = await findOwnActiveRequestId();
  if (existingRequestId) return appendToRequest(existingRequestId);

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .insert({ user_id: user.id, stay_id: stay.id })
    .select("id")
    .single();

  if (requestError || !request) {
    if (requestError?.code === "23505") {
      // Lost a race with another submission for this same stay: that one is
      // the active request now, so add to it instead of failing.
      const racedRequestId = await findOwnActiveRequestId();
      return racedRequestId ? appendToRequest(racedRequestId) : { ok: false, error: RACE_ERROR };
    }
    return { ok: false, error: "We couldn't submit your request. Please try again." };
  }

  const { error: itemsError } = await supabase.from("booking_request_items").insert(insertRows(request.id));

  if (itemsError) {
    await supabase.from("booking_requests").delete().eq("id", request.id);
    return { ok: false, error: "We couldn't submit your request. Please try again." };
  }

  const estimatedTotal = await readEstimatedTotal(supabase, request.id);

  scheduleEmailDispatch();
  return {
    ok: true,
    requestId: request.id,
    estimatedTotal,
    currency,
    itemCount: itemsToInsert.length,
    addedToExistingRequest: false,
  };
}

/**
 * M7.2: the stay's current active (REQUESTED or CONFIRMED) request, if any
 * — the DB's partial unique index guarantees at most one. Returns null for
 * no active request (including a withdrawn one), which the planner treats
 * as "nothing requested yet". RLS on both tables already scopes this to the
 * signed-in guest's own rows.
 */
export async function getActiveBookingRequest(stayId: string): Promise<ActiveBookingRequest | null> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();

  const { data: request } = await supabase
    .from("booking_requests")
    .select("id, status, estimated_total")
    .eq("stay_id", stayId)
    .in("status", ACTIVE_STATUSES)
    .maybeSingle();

  if (!request) return null;

  const { data: itemRows } = await supabase
    .from("booking_request_items")
    .select(
      "id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time, host_note, status, decline_reason, decided_at, created_at, cancelled_at, cancelled_by, cancellation_reason, cancellation_note",
    )
    .eq("booking_request_id", request.id)
    .order("created_at", { ascending: true });

  type ItemRow = {
    id: string;
    experience_id: string;
    planned_date: string;
    planned_moment: PlannedMoment;
    guest_count: number;
    price_per_person: number;
    preferred_time: string | null;
    host_note: string | null;
    status: BookingItemStatus;
    decline_reason: DeclineReason | null;
    decided_at: string | null;
    created_at: string;
    cancelled_at: string | null;
    cancelled_by: CancelledBy | null;
    cancellation_reason: CancelReason | null;
    cancellation_note: string | null;
  };

  return {
    id: request.id,
    status: request.status as ActiveBookingRequestStatus,
    estimatedTotal: request.estimated_total,
    items: ((itemRows as ItemRow[] | null) ?? []).map((row) => ({
      id: row.id,
      experienceId: row.experience_id,
      plannedDate: row.planned_date,
      plannedMoment: row.planned_moment,
      guestCount: row.guest_count,
      pricePerPerson: row.price_per_person,
      preferredTime: normalizeTime(row.preferred_time),
      hostNote: row.host_note,
      status: row.status,
      declineReason: row.decline_reason,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      cancelledBy: row.cancelled_by,
      cancellationReason: row.cancellation_reason,
      cancellationNote: row.cancellation_note,
    })),
  };
}

/**
 * The request's estimated_total only ever reflects items that are still
 * REQUESTED or CONFIRMED — a DECLINED, WITHDRAWN or CANCELLED item's price
 * no longer applies. Since 0031 the database keeps it current itself (the
 * booking_request_items_sync_total trigger, on every item insert and status
 * change; clients can no longer write it), so this only reads it back. Each
 * item contributes its OWN price_per_person × its OWN guest_count.
 */
async function readEstimatedTotal(supabase: SupabaseServerClient, bookingRequestId: string): Promise<number> {
  const { data } = await supabase
    .from("booking_requests")
    .select("estimated_total")
    .eq("id", bookingRequestId)
    .maybeSingle();
  return Number((data as { estimated_total: number } | null)?.estimated_total ?? 0);
}

export type WithdrawItemResult = { ok: true } | { ok: false; error: string };

/**
 * P1.4: the guest withdraws ONE still-pending item — never the whole
 * request, never a DECLINED/CONFIRMED item. The transition itself runs in
 * the database function booking_item_withdraw (0031), which re-checks
 * ownership and the REQUESTED state — the database's own decision, not just
 * a UI restriction. The reads below only pick the friendlier error message.
 * The item row is kept as history; the total is recomputed by the database.
 */
export async function withdrawBookingRequestItem(itemId: string): Promise<WithdrawItemResult> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  const { data: item } = await supabase
    .from("booking_request_items")
    .select("id, booking_request_id, status")
    .eq("id", itemId)
    .maybeSingle();

  if (!item) {
    return { ok: false, error: "We couldn't find that experience in your request." };
  }

  const { data: request } = await supabase
    .from("booking_requests")
    .select("id, user_id")
    .eq("id", item.booking_request_id)
    .maybeSingle();

  if (!request || request.user_id !== user.id) {
    return { ok: false, error: "We couldn't find that request." };
  }

  const { data: withdrawn, error } = await supabase.rpc("booking_item_withdraw", { p_item_id: itemId });

  if (error || withdrawn !== true) {
    return {
      ok: false,
      error: "We couldn't withdraw this experience. It may already have been decided.",
    };
  }

  return { ok: true };
}

export type CancelItemResult = { ok: true } | { ok: false; error: string };

/**
 * Booking-lifecycle milestone: the guest cancels ONE already-CONFIRMED
 * item — immediate, no acceptance step. Runs in the database function
 * booking_item_cancel_as_guest (0031), which checks the item belongs to one
 * of the caller's own requests and is still CONFIRMED. Every failure path
 * returns the SAME generic message: whether the item doesn't exist, isn't
 * the caller's, or is no longer CONFIRMED, the guest is told only "we
 * couldn't cancel this" — never which of those three it was.
 * status/cancelled_at/cancelled_by/cancellation_reason/cancellation_note
 * are written together in the one guarded update; migration 0019's own
 * CHECK constraints make a partial write of these five fields impossible
 * regardless. The parent booking_request's own status is never touched —
 * only its estimated_total, recomputed by the database, since a cancelled
 * item's price no longer applies.
 */
export async function cancelBookingRequestItemAsGuest(
  itemId: string,
  reason: CancelReason,
  note: string,
): Promise<CancelItemResult> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();
  const GENERIC_ERROR = "We couldn't cancel this experience. It may already have been decided, or it isn't yours to manage.";

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  if (!GUEST_CANCEL_REASONS.some((r) => r.value === reason)) {
    return { ok: false, error: "Please choose a valid cancellation reason." };
  }

  const trimmedNote = note.trim();
  if (trimmedNote.length > CANCELLATION_NOTE_MAX_LENGTH) {
    return { ok: false, error: `Your note is too long (max ${CANCELLATION_NOTE_MAX_LENGTH} characters).` };
  }

  const { data: cancelled, error } = await supabase.rpc("booking_item_cancel_as_guest", {
    p_item_id: itemId,
    p_reason: reason,
    p_note: trimmedNote,
  });

  if (error || cancelled !== true) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();

  return { ok: true };
}

/**
 * M7.2: guest-initiated withdrawal of the whole request. Runs in the
 * database function booking_request_withdraw (0031): scoped to the caller's
 * own request, only from an active status (an already-withdrawn or
 * otherwise-final request just fails harmlessly), and in the SAME
 * transaction every still-REQUESTED item of the request becomes WITHDRAWN —
 * no pending item is left behind. Decided items (CONFIRMED/DECLINED/
 * CANCELLED) keep their status as history. Once withdrawn, the row no longer
 * matches the partial unique index, freeing the stay up for a new request.
 */
export async function withdrawBookingRequest(
  requestId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in to withdraw this request." };
  }

  const { data, error } = await supabase.rpc("booking_request_withdraw", { p_request_id: requestId });

  if (error || data !== true) {
    return { ok: false, error: "We couldn't withdraw this request. Please try again." };
  }

  return { ok: true };
}
