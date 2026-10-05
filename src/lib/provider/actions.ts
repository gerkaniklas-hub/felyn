"use server";

import { recalculateEstimatedTotal } from "@/lib/matching/booking-requests";
import { PROVIDER_CANCEL_REASONS, CANCELLATION_NOTE_MAX_LENGTH, type CancelledBy, type CancelReason, type DeclineReason } from "@/lib/matching/booking-status";
import { scheduleEmailDispatch } from "@/lib/email/dispatcher";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ProviderItemActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't update this request. It may already have been decided, or it isn't yours to manage.";

/**
 * P1.1/P1.2: a provider deciding on ONE of their own booking_request_items.
 * Never touches booking_requests.status — the aggregate request stays
 * exactly as it was (see 0009's migration note). Ownership is enforced two
 * ways: the `.eq("status", "REQUESTED")` guard only lets a still-pending
 * item be decided once, and the "Providers update items for their
 * experiences" RLS policy (0009) means the update simply matches zero rows
 * — never another provider's data — if this item doesn't belong to the
 * caller's own experiences. The database trigger from 0009 creates the
 * guest-facing notification as a side effect of this update; nothing here
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

  const { data, error } = await supabase
    .from("booking_request_items")
    .update({ status: "CONFIRMED" })
    .eq("id", itemId)
    .eq("status", "REQUESTED")
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();
  return { ok: true };
}

/**
 * P1.2: declining now captures a structured reason (+ optional free-text
 * note) for future product/ops analysis (see 0010) — stored on the same
 * row, scoped by the same RLS/ownership guard as confirm above.
 *
 * Stage 2c-B: also writes decided_at, the anchor for the 30-day
 * post-decision messaging window (0021). Set only inside this same
 * guarded update — the `.eq("status","REQUESTED")` guard already makes
 * REQUESTED -> DECLINED a one-shot transition per row (a failed/zero-row
 * update returns GENERIC_ERROR before this ever runs again), so
 * decided_at can only ever be written once per item, the same way
 * cancelled_at already is for cancellation. No other transition, and no
 * unrelated update to an already-decided row, ever touches this column.
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

  const trimmedNote = note?.trim();

  const { data, error } = await supabase
    .from("booking_request_items")
    .update({
      status: "DECLINED",
      decline_reason: reason,
      decline_note: trimmedNote ? trimmedNote : null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("status", "REQUESTED")
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: GENERIC_ERROR };
  }

  scheduleEmailDispatch();
  return { ok: true };
}

/**
 * Booking-lifecycle milestone: the provider cancels ONE already-CONFIRMED
 * item — immediate, no acceptance step. Relies on RLS alone for ownership
 * (the existing "Providers update items for their experiences" policy,
 * 0009), exactly like confirmBookingRequestItem/declineBookingRequestItem
 * above — never a separate ownership pre-check query, matching this
 * file's own established pattern rather than booking-requests.ts's more
 * defensive guest-side shape. Every failure path (item not theirs, item no
 * longer CONFIRMED) returns the same GENERIC_ERROR — never reveals which.
 * status/cancelled_at/cancelled_by/cancellation_reason/cancellation_note
 * are written together in the one guarded update; the parent
 * booking_request's own status is never touched. The guest's
 * estimated_total is recalculated afterwards via the shared helper (now
 * exported from booking-requests.ts) since a cancelled item's price no
 * longer applies — the same side effect withdrawal/guest-cancellation
 * already has.
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

  const cancelledBy: CancelledBy = "provider";
  const { data: cancelData, error: cancelError } = await supabase
    .from("booking_request_items")
    .update({
      status: "CANCELLED",
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
      cancellation_note: trimmedCancelNote ? trimmedCancelNote : null,
    })
    .eq("id", itemId)
    .eq("status", "CONFIRMED")
    .select("id, booking_request_id")
    .maybeSingle();

  if (cancelError || !cancelData) {
    return { ok: false, error: GENERIC_ERROR };
  }

  await recalculateEstimatedTotal(supabase, cancelData.booking_request_id);
  scheduleEmailDispatch();

  return { ok: true };
}
