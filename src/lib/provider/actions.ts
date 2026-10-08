"use server";

import { PROVIDER_CANCEL_REASONS, CANCELLATION_NOTE_MAX_LENGTH, type CancelReason, type DeclineReason } from "@/lib/matching/booking-status";
import { scheduleEmailDispatch } from "@/lib/email/dispatcher";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ProviderItemActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't update this request. It may already have been decided, or it isn't yours to manage.";
const OVERLAPPING_BOOKING_ERROR =
  "This experience overlaps another confirmed booking. Message the guest to suggest another time — they can withdraw and request again.";
const UNACCEPTABLE_REQUEST_ERROR =
  "This request can't be confirmed because it has no start time (or the experience has no valid duration). Message the guest and ask them to send a new request with a time.";

/**
 * P1.1/P1.2: a provider deciding on ONE of their own booking_request_items.
 * Never touches booking_requests.status — the aggregate request stays
 * exactly as it was (see 0009's migration note). Since 0031 no client may
 * UPDATE booking_request_items directly: the transition runs in the database
 * function booking_item_confirm, which only moves a still-REQUESTED item of
 * one of the caller's own experiences (whose request is still active) and
 * returns false otherwise — never another provider's data, and the item can
 * be decided only once. Since 0033 the same function also records the
 * acceptance snapshot — accepted_at, confirmed_start_at (the requested
 * Tenerife start as a real instant) and duration_minutes — in the same
 * update; nothing here supplies those values. Since 0034 it also refuses an
 * acceptance that would overlap another of this host's confirmed bookings,
 * serialized per host in the database (no check here is authoritative). The database trigger from 0009
 * creates the guest-facing notification as a side effect; nothing here
 * writes to `notifications` directly.
 */
export async function confirmBookingRequestItem(itemId: string): Promise<ProviderItemActionResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  const { data, error } = await supabase.rpc("booking_item_confirm", { p_item_id: itemId });

  // 22023: 0033 refused to accept without a complete snapshot — a request made
  // before start times were required, or an experience without a valid duration.
  if (error?.code === "22023") {
    return { ok: false, error: UNACCEPTABLE_REQUEST_ERROR };
  }
  // 23P01: 0034 refused because the booking would overlap one of this host's
  // confirmed bookings. The request stays REQUESTED, untouched.
  if (error?.code === "23P01") {
    return { ok: false, error: OVERLAPPING_BOOKING_ERROR };
  }
  if (error || data !== true) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();
  return { ok: true };
}

/**
 * P1.2: declining captures a structured reason (+ optional free-text note)
 * for future product/ops analysis (see 0010) — stored on the same row,
 * through the same ownership/state guard as confirm above (database
 * function booking_item_decline, 0031).
 *
 * Stage 2c-B: the decline also writes decided_at, the anchor for the 30-day
 * post-decision messaging window (0021) — set by the database function from
 * the database clock, in the same one-shot REQUESTED -> DECLINED update, so
 * it can only ever be written once per item.
 */
export async function declineBookingRequestItem(
  itemId: string,
  reason: DeclineReason,
  note?: string,
): Promise<ProviderItemActionResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  const { data, error } = await supabase.rpc("booking_item_decline", {
    p_item_id: itemId,
    p_reason: reason,
    p_note: note?.trim() ?? null,
  });

  if (error || data !== true) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();
  return { ok: true };
}

/**
 * Booking-lifecycle milestone: the provider cancels ONE already-CONFIRMED
 * item — immediate, no acceptance step. Ownership and state are checked by
 * the database function booking_item_cancel_as_host (0031), exactly like
 * confirm/decline above — never a separate ownership pre-check query. Every
 * failure path (item not theirs, item no longer CONFIRMED) returns the same
 * GENERIC_ERROR — never reveals which. status/cancelled_at/cancelled_by/
 * cancellation_reason/cancellation_note are written together in the one
 * guarded update; the parent booking_request's own status is never touched,
 * and its estimated_total is recomputed by the database (0031's
 * booking_request_items_sync_total trigger), since a cancelled item's price
 * no longer applies.
 */
export async function cancelBookingRequestItemAsProvider(
  itemId: string,
  reason: CancelReason,
  note?: string,
): Promise<ProviderItemActionResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in." };
  }

  if (!PROVIDER_CANCEL_REASONS.some((r) => r.value === reason)) {
    return { ok: false, error: "Please choose a valid cancellation reason." };
  }

  const trimmedCancelNote = note?.trim();
  if (trimmedCancelNote && trimmedCancelNote.length > CANCELLATION_NOTE_MAX_LENGTH) {
    return { ok: false, error: `Note is too long (max ${CANCELLATION_NOTE_MAX_LENGTH} characters).` };
  }

  const { data, error } = await supabase.rpc("booking_item_cancel_as_host", {
    p_item_id: itemId,
    p_reason: reason,
    p_note: trimmedCancelNote ?? null,
  });

  if (error || data !== true) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();

  return { ok: true };
}
