import type { SupabaseClient } from "@supabase/supabase-js";

export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  bookingRequestItemId: string | null;
  readAt: string | null;
  createdAt: string;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  booking_request_item_id: string | null;
  read_at: string | null;
  created_at: string;
};

/**
 * P1.1: the signed-in guest's own notifications (RLS-scoped by "Users
 * manage their own notifications" from 0009 — no explicit user_id filter
 * needed, same convention as getActiveBookingRequest). Rows are created by
 * the 0009 database trigger when a provider confirms/declines one of this
 * guest's booking_request_items; nothing in this app writes a row here
 * directly.
 */
export async function getRecentNotifications(supabase: SupabaseClient, limit = 15): Promise<Notification[]> {
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, booking_request_item_id, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data as NotificationRow[] | null) ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    bookingRequestItemId: row.booking_request_item_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export async function getUnreadNotificationCount(supabase: SupabaseClient): Promise<number> {
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  return count ?? 0;
}

/**
 * Phase 7 of the consolidated improvements: where clicking a notification
 * should go. NotificationBell only ever renders on guest pages (never
 * provider ones), so every type reaching this is guest-facing — booking
 * decisions route to the guest's own booking detail page (RLS-scoped,
 * 0005), a new message routes to the inbox with the same `?item=` auto-open
 * param ConversationList already supports. Returns null for any type this
 * app doesn't (yet) know how to route, or with no bookingRequestItemId at
 * all — callers must treat null as "nothing to navigate to", never invent
 * a destination.
 */
export function getNotificationHref(type: string, bookingRequestItemId: string | null): string | null {
  // Host-application decisions aren't tied to a booking item (0023 inserts
  // them with booking_request_item_id = null), so they're routed before the
  // item check. /provider re-checks host access server-side.
  if (type === "host_application_approved") return "/provider";
  if (!bookingRequestItemId) return null;
  switch (type) {
    case "booking_item_confirmed":
    case "booking_item_declined":
    case "booking_item_cancelled":
      return `/bookings/${bookingRequestItemId}`;
    case "new_message":
      return `/messages?item=${bookingRequestItemId}`;
    default:
      return null;
  }
}
