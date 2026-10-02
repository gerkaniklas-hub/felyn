/**
 * M7.2: shared wording/tone for a stay's active booking request status.
 * Plain module (no "use server"/"use client") so both the server-side
 * booking-requests actions and client planner components can import it.
 */
export type ActiveBookingRequestStatus = "REQUESTED" | "CONFIRMED";

export function getRequestStatusLabel(status: ActiveBookingRequestStatus): string {
  return status === "CONFIRMED" ? "Confirmed" : "Requested";
}

export function getRequestStatusCaption(status: ActiveBookingRequestStatus): string {
  return status === "CONFIRMED" ? "Confirmed" : "Pending confirmation";
}

export function getRequestStatusTone(status: ActiveBookingRequestStatus): "gold" | "sky" {
  return status === "CONFIRMED" ? "sky" : "gold";
}

/**
 * P1.1: per booking_request_item status — independent of the parent
 * request's status. A provider confirming/declining ONE item never
 * touches ActiveBookingRequestStatus above. P1.4 adds WITHDRAWN: the
 * guest's own individual "never mind" for a still-REQUESTED item — the row
 * is never deleted, same as a DECLINED one (see 0011).
 */
export type BookingItemStatus = "REQUESTED" | "CONFIRMED" | "DECLINED" | "WITHDRAWN" | "CANCELLED";

export function getItemStatusLabel(status: BookingItemStatus): string {
  switch (status) {
    case "CONFIRMED":
      return "Confirmed";
    case "DECLINED":
      return "Declined";
    case "WITHDRAWN":
      return "Withdrawn";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "Requested";
  }
}

/**
 * A planner item is either a persisted booking_request_item (with its own
 * BookingItemStatus) or a "DRAFT": added to the plan on the guest's device
 * but not yet requested. DRAFT is purely client-side and never stored.
 */
export type PlanItemStatus = BookingItemStatus | "DRAFT";

/** Draft and pending/confirmed items occupy their date+moment; declined/withdrawn/cancelled ones free it. */
export function isSlotOccupyingStatus(status: PlanItemStatus): boolean {
  return status !== "DECLINED" && status !== "WITHDRAWN" && status !== "CANCELLED";
}

/** All-caps wording for the guest planner, matching the product spec exactly (e.g. "AWAITING CONFIRMATION"). */
export function getGuestItemStatusLabel(status: BookingItemStatus): string {
  switch (status) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "DECLINED":
      return "DECLINED";
    case "WITHDRAWN":
      return "WITHDRAWN";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "AWAITING CONFIRMATION";
  }
}

export function getItemStatusTone(status: BookingItemStatus): "gold" | "sky" | "navy" {
  switch (status) {
    case "CONFIRMED":
      return "sky";
    case "DECLINED":
    case "WITHDRAWN":
    case "CANCELLED":
      return "navy";
    default:
      return "gold";
  }
}

/**
 * A purely DISPLAY-level aggregate across a request's items — never
 * persisted (booking_requests.status is never derived/overwritten from
 * this). Used only to give the guest's overall plan status line an honest
 * caption once items start diverging.
 */
export type AggregateItemStage = "requested" | "partially_confirmed" | "confirmed" | "declined" | "cancelled";

export function deriveAggregateItemStage(statuses: BookingItemStatus[]): AggregateItemStage {
  if (statuses.length === 0) return "requested";
  // WITHDRAWN is the guest's own doing, never a provider decision, and
  // CANCELLED (booking-lifecycle milestone) is a later reversal of an
  // already-CONFIRMED item — none of the three inactive statuses count as
  // "still active", so any one of them alone can't flip the overall
  // caption away from what the remaining active items actually show.
  const inactive = (s: BookingItemStatus) => s === "DECLINED" || s === "WITHDRAWN" || s === "CANCELLED";
  const allInactive = statuses.every(inactive);
  if (allInactive) {
    // If every item is inactive, prefer the more specific/recent-feeling
    // outcome when more than one kind is present: a cancellation is a
    // later, more deliberate event than a decline, so it wins the caption
    // when both exist on an otherwise fully-inactive request.
    if (statuses.some((s) => s === "CANCELLED")) return "cancelled";
    if (statuses.some((s) => s === "DECLINED")) return "declined";
    return "requested";
  }
  const active = statuses.filter((s) => !inactive(s));
  if (active.length > 0 && active.every((s) => s === "CONFIRMED")) return "confirmed";
  if (active.some((s) => s === "CONFIRMED")) return "partially_confirmed";
  return "requested";
}

export function getAggregateItemStageCaption(stage: AggregateItemStage): string {
  switch (stage) {
    case "confirmed":
      return "Confirmed";
    case "partially_confirmed":
      return "Partially confirmed";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending confirmation";
  }
}

/**
 * Booking-lifecycle milestone: the same badge tone PlanStatus.tsx already
 * used for this exact stage, now hoisted here so every surface showing an
 * aggregate status (the planner, Home, the stay overview) reads it from one
 * place instead of each keeping its own copy.
 */
export function getAggregateItemStageTone(stage: AggregateItemStage): "gold" | "sky" | "navy" {
  switch (stage) {
    case "confirmed":
    case "partially_confirmed":
      return "sky";
    case "declined":
    case "cancelled":
      return "navy";
    default:
      return "gold";
  }
}

/**
 * P1.2: structured reason a provider gives when declining an item — stored
 * on booking_request_items (see 0010) for future product/ops analysis.
 * P1.3 surfaces this reason to the guest too (so they understand why
 * before replacing it); only the provider's free-text decline_note stays
 * provider/internal-facing (see getActiveBookingRequest, which never
 * selects that column).
 */
export type DeclineReason =
  | "double_booking"
  | "no_longer_available"
  | "cannot_accommodate"
  | "unavailable_for_date"
  | "other";

export const DECLINE_REASONS: { value: DeclineReason; label: string }[] = [
  { value: "double_booking", label: "Double booking" },
  { value: "no_longer_available", label: "No longer available" },
  { value: "cannot_accommodate", label: "Cannot accommodate this request" },
  { value: "unavailable_for_date", label: "Experience unavailable for this date/time" },
  { value: "other", label: "Other" },
];

export function getDeclineReasonLabel(reason: DeclineReason | null): string | null {
  return DECLINE_REASONS.find((r) => r.value === reason)?.label ?? null;
}

/**
 * Booking-lifecycle milestone (cancellation): who performed the
 * cancellation — stored verbatim in booking_request_items.cancelled_by
 * (migration 0018), constrained there to exactly these two values.
 */
export type CancelledBy = "guest" | "provider";

/**
 * Structured cancellation reason, stored in
 * booking_request_items.cancellation_reason (migration 0019). The exact
 * value sets below match 0019's combined actor-aware CHECK constraint
 * verbatim — do not add, remove, or rename a value here without a
 * matching migration, and vice versa.
 */
export type CancelReason =
  | "CHANGE_OF_PLANS"
  | "NO_LONGER_NEEDED"
  | "DATE_OR_TIME_NO_LONGER_WORKS"
  | "UNEXPECTED_CIRCUMSTANCES"
  | "UNABLE_TO_PROVIDE_EXPERIENCE"
  | "OTHER";

export const GUEST_CANCEL_REASONS: { value: CancelReason; label: string }[] = [
  { value: "CHANGE_OF_PLANS", label: "Change of plans" },
  { value: "NO_LONGER_NEEDED", label: "No longer needed" },
  { value: "DATE_OR_TIME_NO_LONGER_WORKS", label: "Date or time no longer works" },
  { value: "UNEXPECTED_CIRCUMSTANCES", label: "Unexpected circumstances" },
  { value: "OTHER", label: "Other" },
];

export const PROVIDER_CANCEL_REASONS: { value: CancelReason; label: string }[] = [
  { value: "DATE_OR_TIME_NO_LONGER_WORKS", label: "Date or time no longer works" },
  { value: "UNABLE_TO_PROVIDE_EXPERIENCE", label: "Unable to provide this experience" },
  { value: "UNEXPECTED_CIRCUMSTANCES", label: "Unexpected circumstances" },
  { value: "OTHER", label: "Other" },
];

export const CANCELLATION_NOTE_MAX_LENGTH = 500;

/** Looks up a label regardless of which actor's list it came from — a stored reason is always one or the other. */
export function getCancelReasonLabel(reason: CancelReason | null): string | null {
  if (reason == null) return null;
  return (
    GUEST_CANCEL_REASONS.find((r) => r.value === reason)?.label ??
    PROVIDER_CANCEL_REASONS.find((r) => r.value === reason)?.label ??
    null
  );
}

/**
 * Stage 2c-B: post-decision messaging windows.
 *
 * IMPORTANT — this is a UI-DISPLAY ESTIMATE ONLY, never the authorization
 * boundary. The real gate is the database's own RLS INSERT policy on
 * `messages` (0021), which re-evaluates the identical 30-day condition
 * against the live row on every actual send attempt — a stale client (a
 * tab left open past the deadline, a clock skewed relative to the
 * database's own `now()`) gets rejected by the database regardless of
 * what this function estimated at render time. This function exists only
 * to decide what the composer/closed-message should SAY, matching the
 * database's own rule as closely as a client-side clock reasonably can.
 */
export const MESSAGING_WINDOW_DAYS = 30;

export type MessagingWindowState =
  | { canSend: true; daysRemaining: null } // REQUESTED/CONFIRMED — indefinite, no window at all
  | { canSend: true; daysRemaining: number } // DECLINED/CANCELLED, still inside the window
  | { canSend: false; windowExpired: true } // DECLINED/CANCELLED, the window has passed
  | { canSend: false; windowExpired: false }; // WITHDRAWN, or a status with no anchor timestamp — closed, no window to describe

/**
 * `decidedAt`/`cancelledAt` are plain ISO timestamp strings (as read from
 * Supabase), or null. The comparison is pure absolute-instant arithmetic
 * (epoch milliseconds) — deliberately timezone-agnostic, matching the
 * database's own `now() <= anchor + interval '30 days'`, which is likewise
 * an absolute-timestamp comparison, not a calendar-day one. Any
 * Atlantic/Canary-local formatting belongs only in how a caller DISPLAYS
 * a date to the guest/host, never in this comparison itself.
 */
export function getMessagingWindowState(
  status: BookingItemStatus,
  decidedAt: string | null,
  cancelledAt: string | null,
): MessagingWindowState {
  if (status === "REQUESTED" || status === "CONFIRMED") {
    return { canSend: true, daysRemaining: null };
  }

  const anchor = status === "DECLINED" ? decidedAt : status === "CANCELLED" ? cancelledAt : null;
  if (!anchor) {
    // WITHDRAWN always lands here (no anchor concept for it — existing
    // "closes immediately" behavior preserved exactly). A legacy DECLINED
    // row with a still-null decided_at (shouldn't exist after 0021's
    // backfill, but defensively handled) also lands here rather than ever
    // being treated as open.
    return { canSend: false, windowExpired: false };
  }

  const deadlineMs = new Date(anchor).getTime() + MESSAGING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const msRemaining = deadlineMs - Date.now();
  if (msRemaining < 0) {
    return { canSend: false, windowExpired: true };
  }
  return { canSend: true, daysRemaining: Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000))) };
}

/** The composer's small "closing soon" caption — undefined when there's nothing to say (indefinite, or already closed). */
export function getMessagingOpenCaption(windowState: MessagingWindowState): string | undefined {
  if (!windowState.canSend || windowState.daysRemaining === null) return undefined;
  return `You can reply for ${windowState.daysRemaining} more day${windowState.daysRemaining === 1 ? "" : "s"}.`;
}

/** The existing three-site closed-label text, now window-aware for DECLINED/CANCELLED instead of always implying immediate closure. */
export function getMessagingClosedLabel(
  status: BookingItemStatus,
  windowState: MessagingWindowState,
): string | undefined {
  if (windowState.canSend) return undefined;
  if (status === "DECLINED") return "The 30-day reply window for this declined booking has closed.";
  if (status === "CANCELLED") return "The 30-day reply window for this cancelled booking has closed.";
  if (status === "WITHDRAWN") return "This booking was withdrawn — the conversation is closed.";
  return "This conversation is closed.";
}

/** Shown wherever a trip/stay name would be, for a request made without a trip (0026). */
export const NO_TRIP_LINKED_LABEL = "No trip linked";
