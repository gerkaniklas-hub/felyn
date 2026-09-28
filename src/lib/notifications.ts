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
