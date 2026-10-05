/**
 * Felyn support (0029_support.sql): the database values and their display labels,
 * kept apart so a label can change without touching the database. The value lists
 * must match the check constraints in 0029 — tests/support-migration.test.ts
 * fails if they drift.
 */

export const SUPPORT_CATEGORIES = [
  "booking",
  "cancellation",
  "payment",
  "experience",
  "account",
  "technical_issue",
  "other",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  booking: "Booking",
  cancellation: "Cancellation",
  payment: "Payment",
  experience: "Experience",
  account: "Account",
  technical_issue: "Technical issue",
  other: "Other",
};

export const SUPPORT_STATUSES = ["OPEN", "RESOLVED", "CLOSED"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  OPEN: "Open",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** Which side of an account opened the ticket — keeps guest and host inboxes apart for an account that is both. */
export const SUPPORT_REQUESTER_ROLES = ["guest", "host"] as const;
export type SupportRequesterRole = (typeof SUPPORT_REQUESTER_ROLES)[number];

export const SUPPORT_SENDER_TYPES = ["user", "staff"] as const;
export type SupportSenderType = (typeof SUPPORT_SENDER_TYPES)[number];

/** Same limit as guest<->host messages (support_messages_body_check). */
export const SUPPORT_MESSAGE_MAX_LENGTH = 2000;

/** How every staff message is shown to guests and hosts, whoever on the team wrote it. */
export const SUPPORT_TEAM_NAME = "Felyn Team";

export function isSupportCategory(value: string): value is SupportCategory {
  return (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * SQLSTATEs raised by the 0029 support functions, for mapping to user-facing
 * messages. NOT_FOUND is also what another user's thread or booking returns, so it
 * never reveals that one exists.
 */
export const SUPPORT_ERROR_CODES = {
  NOT_ALLOWED: "42501",
  NOT_FOUND: "P0002",
  INVALID_INPUT: "22023",
  CLOSED: "55000",
  ALREADY_OPEN: "23505",
} as const;
