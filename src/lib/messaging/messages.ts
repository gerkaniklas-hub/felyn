import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * P2: guest-host messaging reads. Plain server-only helpers (no "use
 * server" — these take a Supabase client and aren't callable directly from
 * the client, same convention as lib/notifications.ts and
 * lib/provider/dashboard.ts). Mutations live in ./actions.ts.
 *
 * There is no separate conversations table (see 0014's header comment) —
 * "the conversation" for a booking_request_item IS every message row that
 * shares its id. Every query here is scoped by the 0014 RLS policies to a
 * genuine participant (the guest who owns the item's parent request, or
 * the provider who owns its experience); an itemId belonging to neither
 * simply comes back empty, never an error that would reveal whether the
 * item exists at all.
 */

export const MESSAGE_MAX_LENGTH = 2000;

export type Message = {
  id: string;
  bookingRequestItemId: string;
  senderId: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

type MessageRow = {
  id: string;
  booking_request_item_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

export function mapMessageRow(row: MessageRow): Message {
  return {
    id: row.id,
    bookingRequestItemId: row.booking_request_item_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/** Every message for one booking item, oldest first. */
export async function getMessages(supabase: SupabaseClient, itemId: string): Promise<Message[]> {
  const { data } = await supabase
    .from("messages")
    .select("id, booking_request_item_id, sender_id, body, created_at, read_at")
    .eq("booking_request_item_id", itemId)
    .order("created_at", { ascending: true });
  return ((data as MessageRow[] | null) ?? []).map(mapMessageRow);
}

/**
 * How many messages on this item were sent by the OTHER participant and
 * are still unread by the caller — never computed from anything the
 * client asserts, just the caller's own auth.uid() against the row data
 * RLS already scoped to them.
 */
export async function getUnreadMessageCount(supabase: SupabaseClient, itemId: string): Promise<number> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 0;
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("booking_request_item_id", itemId)
    .is("read_at", null)
    .neq("sender_id", user.id);
  return count ?? 0;
}

/** Batched version for a whole list of items (e.g. the guest's plan) — one round trip instead of N. */
export async function getUnreadMessageCountsByItem(
  supabase: SupabaseClient,
  itemIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (itemIds.length === 0) return counts;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return counts;
  const { data } = await supabase
    .from("messages")
    .select("booking_request_item_id")
    .in("booking_request_item_id", itemIds)
    .is("read_at", null)
    .neq("sender_id", user.id);
  for (const row of (data as { booking_request_item_id: string }[] | null) ?? []) {
    counts.set(row.booking_request_item_id, (counts.get(row.booking_request_item_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The single most recent message on each of the given items — the Messages
 * inbox's "preview line", never a duplicate of getMessages (which returns
 * full history). Fetches every message for these items (already the
 * pattern getMessages uses; volumes are small for an MVP inbox) and keeps
 * only the newest per item in JS, rather than adding a new grouped/RPC
 * query just for this.
 */
export async function getLastMessagesByItem(
  supabase: SupabaseClient,
  itemIds: string[],
): Promise<Map<string, Message>> {
  const lastByItem = new Map<string, Message>();
  if (itemIds.length === 0) return lastByItem;
  const { data } = await supabase
    .from("messages")
    .select("id, booking_request_item_id, sender_id, body, created_at, read_at")
    .in("booking_request_item_id", itemIds)
    .order("created_at", { ascending: false });
  for (const row of (data as MessageRow[] | null) ?? []) {
    if (!lastByItem.has(row.booking_request_item_id)) {
      lastByItem.set(row.booking_request_item_id, mapMessageRow(row));
    }
  }
  return lastByItem;
}

/** Every booking_request_item id that has at least one message the caller can see — the set of "existing conversations", scoped entirely by the 0014 RLS SELECT policies. */
export async function getItemIdsWithMessages(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase.from("messages").select("booking_request_item_id");
  return [...new Set(((data as { booking_request_item_id: string }[] | null) ?? []).map((r) => r.booking_request_item_id))];
}
