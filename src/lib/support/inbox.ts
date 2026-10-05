import { SUPPORT_CATEGORY_LABELS, SUPPORT_TEAM_NAME, type SupportCategory, type SupportStatus } from "./constants";

/**
 * Pure presentation helpers for Felyn Team conversations in the guest's Messages
 * (no React, no Supabase — unit-tested). Guests never see ticket wording, ids or
 * database values: only "Felyn Team", the topic and a plain status word.
 */

/** "Booking · Dinner Experience" for a booking conversation, "Payment" for general help. */
export function getSupportSubtitle(c: {
  category: SupportCategory;
  /** Either the booking's id (guest side) or just whether there is one (staff list). */
  bookingItemId?: string | null;
  isBooking?: boolean;
  experienceTitle: string | null;
}): string {
  const topic = SUPPORT_CATEGORY_LABELS[c.category];
  if (!(c.isBooking ?? Boolean(c.bookingItemId))) return topic;
  return `${topic} · ${c.experienceTitle ?? "Your booking"}`;
}

/** A status word only where it helps the guest; an open conversation needs none. */
export function getSupportStatusNote(status: SupportStatus): string | null {
  if (status === "RESOLVED") return "Resolved";
  if (status === "CLOSED") return "Closed";
  return null;
}

export const SUPPORT_RESOLVED_CAPTION = `${SUPPORT_TEAM_NAME} marked this conversation as resolved. Reply to reopen it.`;
export const SUPPORT_REOPENED_CAPTION = `You reopened this conversation. ${SUPPORT_TEAM_NAME} will reply here.`;
export const SUPPORT_CLOSED_LABEL = "This conversation is closed.";

/** Where "Contact Felyn again" starts a NEW conversation: the same booking's Get help, or the general Contact Felyn form. */
export function getContactAgainHref(bookingItemId: string | null): string {
  return bookingItemId ? `/bookings/${bookingItemId}?help=1` : "/help";
}

/** Inbox search for Felyn Team rows: the name, the topic and the booking's experience. */
export function matchesSupportQuery(
  c: { category: SupportCategory; experienceTitle: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [SUPPORT_TEAM_NAME, "felyn", "support", "help", SUPPORT_CATEGORY_LABELS[c.category], c.experienceTitle ?? ""].some(
    (text) => text.toLowerCase().includes(q),
  );
}

/**
 * Merges booking conversations and Felyn Team conversations into one list, newest
 * activity first. Stable: rows with the same timestamp keep their original order, so
 * the existing booking order is preserved.
 */
export function mergeByRecency<B, S>(
  bookings: B[],
  bookingAt: (b: B) => string,
  support: S[],
  supportAt: (s: S) => string,
): ({ kind: "booking"; value: B } | { kind: "support"; value: S })[] {
  type Row = { kind: "booking"; value: B } | { kind: "support"; value: S };
  const keyed: { row: Row; at: string }[] = [
    ...bookings.map((value) => ({ row: { kind: "booking" as const, value }, at: bookingAt(value) })),
    ...support.map((value) => ({ row: { kind: "support" as const, value }, at: supportAt(value) })),
  ];
  keyed.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return keyed.map((k) => k.row);
}
