/**
 * Transactional email events — the app-side mirror of migration 0028's
 * public.email_outbox. Rows are created ONLY by the database triggers in
 * 0028 (in the same transaction as the booking change they describe); this
 * module just reads them: what an event means, whether it is still current,
 * where its CTA points, and how failed deliveries are retried.
 *
 * Pure module with relative imports only, so it runs under `npm test`
 * (node --test) as well as in Next.js.
 */
import type { BookingItemStatus, CancelledBy, CancelReason } from "../matching/booking-status";
import type { PlannedMoment } from "../matching/plan";

/** Exactly the values allowed by 0028's email_outbox_event_type_check. */
export const EMAIL_EVENT_TYPES = [
  "request_created_guest",
  "request_created_host",
  "request_confirmed_guest",
  "request_declined_guest",
  "booking_cancelled_by_guest_host",
  "booking_cancelled_by_host_guest",
  "booking_cancelled_by_guest_guest",
  "booking_cancelled_by_host_host",
] as const;

export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];
export type RecipientRole = "guest" | "host";
export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

export function isEmailEventType(value: unknown): value is EmailEventType {
  return typeof value === "string" && (EMAIL_EVENT_TYPES as readonly string[]).includes(value);
}

/** The recipient is encoded in the event name's suffix (0028 checks the same rule). */
export function recipientRoleFor(type: EmailEventType): RecipientRole {
  return type.endsWith("_host") ? "host" : "guest";
}

/** A claimed public.email_outbox row, as returned by claim_email_outbox(). */
export type OutboxRow = {
  id: string;
  event_key: string;
  event_type: string;
  recipient_role: string;
  recipient_user_id: string | null;
  booking_request_id: string;
  booking_request_item_ids: string[];
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  claim_token: string | null;
  created_at: string;
};

export type EmailPayloadItem = {
  title: string;
  plannedDate: string;
  plannedMoment: PlannedMoment;
  preferredTime: string | null;
  guestCount: number;
  /** Guest emails only (0028 never snapshots price for a host). */
  pricePerPerson: number | null;
  currency: string | null;
  hostDisplayName: string | null;
};

export type EmailPayload = {
  items: EmailPayloadItem[];
  guestFirstName: string | null;
  stayTown: string | null;
  cancellationReason: CancelReason | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const MOMENTS: readonly string[] = ["morning", "afternoon", "evening"];
const CANCEL_REASONS: readonly string[] = [
  "CHANGE_OF_PLANS",
  "NO_LONGER_NEEDED",
  "DATE_OR_TIME_NO_LONGER_WORKS",
  "UNEXPECTED_CIRCUMSTANCES",
  "UNABLE_TO_PROVIDE_EXPERIENCE",
  "OTHER",
];

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Validates the snapshot 0028 wrote. Returns null for anything unexpected,
 * so a malformed row is failed rather than rendered with missing data.
 */
export function parsePayload(raw: unknown): EmailPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.items) || record.items.length === 0) return null;

  const items: EmailPayloadItem[] = [];
  for (const entry of record.items) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const title = optionalString(item.title);
    if (
      !title ||
      typeof item.planned_date !== "string" ||
      !DATE_PATTERN.test(item.planned_date) ||
      typeof item.planned_moment !== "string" ||
      !MOMENTS.includes(item.planned_moment) ||
      typeof item.guest_count !== "number" ||
      !Number.isInteger(item.guest_count) ||
      item.guest_count < 1
    ) {
      return null;
    }
    const preferredTime =
      typeof item.preferred_time === "string" && TIME_PATTERN.test(item.preferred_time) ? item.preferred_time : null;
    const price = typeof item.price_per_person === "number" && item.price_per_person >= 0 ? item.price_per_person : null;
    items.push({
      title,
      plannedDate: item.planned_date,
      plannedMoment: item.planned_moment as PlannedMoment,
      preferredTime,
      guestCount: item.guest_count,
      pricePerPerson: price,
      currency: price == null ? null : (optionalString(item.currency) ?? "EUR"),
      hostDisplayName: optionalString(item.host_display_name),
    });
  }

  const reason = record.cancellation_reason;
  return {
    items,
    guestFirstName: optionalString(record.guest_first_name),
    stayTown: optionalString(record.stay_town),
    cancellationReason: typeof reason === "string" && CANCEL_REASONS.includes(reason) ? (reason as CancelReason) : null,
  };
}

/** The booking rows' state at send time (read fresh by the sender). */
export type CurrentBookingState = {
  /** booking_requests.status of the parent request. */
  requestStatus: string;
  items: { id: string; status: BookingItemStatus; cancelledBy: CancelledBy | null }[];
};

export type CurrencyCheck = { current: true } | { current: false; reason: string };

const ACTIVE_REQUEST_STATUSES = ["REQUESTED", "CONFIRMED"];

/**
 * Re-check before sending: an event is only delivered while the booking is
 * still in the state the email describes. A request that was withdrawn (or
 * already decided, for the host) before the email went out, or a
 * confirmation that has since been cancelled, is skipped — the later event
 * (if any) has its own email.
 */
export function checkEventStillCurrent(type: EmailEventType, state: CurrentBookingState): CurrencyCheck {
  if (state.items.length === 0) return { current: false, reason: "booking_missing" };
  const statuses = state.items.map((item) => item.status);

  switch (type) {
    case "request_created_guest":
      if (!ACTIVE_REQUEST_STATUSES.includes(state.requestStatus)) return { current: false, reason: "request_withdrawn" };
      return statuses.some((s) => s === "REQUESTED" || s === "CONFIRMED")
        ? { current: true }
        : { current: false, reason: "no_active_items" };
    case "request_created_host":
      if (!ACTIVE_REQUEST_STATUSES.includes(state.requestStatus)) return { current: false, reason: "request_withdrawn" };
      return statuses.some((s) => s === "REQUESTED") ? { current: true } : { current: false, reason: "no_pending_items" };
    case "request_confirmed_guest":
      return statuses.every((s) => s === "CONFIRMED") ? { current: true } : { current: false, reason: "no_longer_confirmed" };
    case "request_declined_guest":
      return statuses.every((s) => s === "DECLINED") ? { current: true } : { current: false, reason: "no_longer_declined" };
    case "booking_cancelled_by_guest_host":
    case "booking_cancelled_by_guest_guest":
      return state.items.every((item) => item.status === "CANCELLED" && item.cancelledBy === "guest")
        ? { current: true }
        : { current: false, reason: "cancellation_mismatch" };
    case "booking_cancelled_by_host_guest":
    case "booking_cancelled_by_host_host":
      return state.items.every((item) => item.status === "CANCELLED" && item.cancelledBy === "provider")
        ? { current: true }
        : { current: false, reason: "cancellation_mismatch" };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The in-app page an email's button opens (existing routes only):
 *   guest, one item  -> /bookings/<itemId>          (booking detail)
 *   guest, several   -> /experiences                (all their experiences)
 *   host,  one item  -> /provider/requests/<itemId> (request detail)
 *   host,  several   -> /provider/requests
 */
export function ctaPathFor(type: EmailEventType, itemIds: string[]): string {
  const single = itemIds.length === 1 && UUID_PATTERN.test(itemIds[0]) ? itemIds[0].toLowerCase() : null;
  if (recipientRoleFor(type) === "host") return single ? `/provider/requests/${single}` : "/provider/requests";
  return single ? `/bookings/${single}` : "/experiences";
}

/** Total delivery attempts per event, including the first. */
export const MAX_ATTEMPTS = 6;

/** Wait before attempt N+1, after N failed attempts: 1 min, 5 min, 15 min, 1 h, 3 h. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];

export function retryDelayMs(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index];
}

/**
 * Resend keeps an idempotency key for 24 hours (see resend.ts). Every attempt
 * for one row reuses the same key, so all attempts must happen within that
 * window, or a retry after an attempt whose result was lost (timeout, crash)
 * could deliver a second copy.
 */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Events older than this are never delivered (marked skipped "expired").
 * 23 hours keeps every attempt — the key's first use is never earlier than
 * the row's creation — safely inside Resend's 24-hour idempotency window,
 * and a booking email that arrives a day late (e.g. after a long outage)
 * would confuse more than it helps.
 */
export const MAX_EVENT_AGE_MS = 23 * 60 * 60 * 1000;

export function isExpired(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);
  return Number.isNaN(created) || now.getTime() - created > MAX_EVENT_AGE_MS;
}
