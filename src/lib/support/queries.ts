import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupportCategory, SupportRequesterRole, SupportSenderType, SupportStatus } from "./constants";

/**
 * Felyn support reads for the guest and host sides (0029). Plain server-only helpers (no
 * "use server"), same convention as lib/messaging/messages.ts; mutations live in
 * ./actions.ts and go through the 0029 database functions only.
 *
 * Every query is scoped by the 0029 RLS policies, AND explicitly filtered to the
 * caller's own threads on ONE side (user_id + requester_role = the given role). The
 * explicit filter matters for two kinds of account: one that is both guest and host
 * (its guest-side and host-side threads must never mix — each inbox shows only its
 * own side) and a staff account (RLS lets staff read every thread — those must never
 * show up as its own inbox). The getGuest* helpers are the guest side.
 *
 * Reads fail soft: if the support tables are unavailable (e.g. 0029 not applied
 * yet) the guest simply sees no Felyn Team conversations, and booking Messages
 * keep working.
 */

export type SupportMessage = {
  id: string;
  threadId: string;
  senderType: SupportSenderType;
  body: string;
  createdAt: string;
  readAt: string | null;
};

/** One Felyn Team row in the guest's Messages inbox. */
export type SupportConversationSummary = {
  threadId: string;
  category: SupportCategory;
  status: SupportStatus;
  /** The booking this conversation is about (booking_request_items.id), or null for general help. */
  bookingItemId: string | null;
  /** Live title of that booking's experience, for the row subtitle. */
  experienceTitle: string | null;
  lastMessage: { body: string; createdAt: string; isMine: boolean } | null;
  lastMessageAt: string;
  /** Felyn Team messages the guest hasn't read yet. */
  unreadCount: number;
};

/** A support thread as the guest's conversation pane needs it. */
export type SupportThreadState = {
  threadId: string;
  status: SupportStatus;
  bookingItemId: string | null;
  messages: SupportMessage[];
};

export const SUPPORT_MESSAGE_COLUMNS = "id, support_thread_id, sender_type, body, created_at, read_at";

type MessageRow = {
  id: string;
  support_thread_id: string;
  sender_type: SupportSenderType;
  body: string;
  created_at: string;
  read_at: string | null;
};

export function mapSupportMessageRow(row: MessageRow): SupportMessage {
  return {
    id: row.id,
    threadId: row.support_thread_id,
    senderType: row.sender_type,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function logReadError(what: string, error: { code?: string } | null) {
  if (error) console.error(`support: ${what} read failed (code ${error.code ?? "unknown"})`);
}

/** The signed-in guest's own (guest-side) Felyn Team conversations, newest activity first. */
export async function getGuestSupportConversations(supabase: SupabaseClient): Promise<SupportConversationSummary[]> {
  return getSupportConversations(supabase, "guest");
}

/** The signed-in user's own Felyn Team conversations on one side (guest or host), newest activity first. */
export async function getSupportConversations(
  supabase: SupabaseClient,
  role: SupportRequesterRole,
): Promise<SupportConversationSummary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  type ThreadRow = {
    id: string;
    category: SupportCategory;
    status: SupportStatus;
    booking_request_item_id: string | null;
    last_message_at: string;
  };
  const { data: threadRows, error: threadError } = await supabase
    .from("support_threads")
    .select("id, category, status, booking_request_item_id, last_message_at")
    .eq("user_id", user.id)
    .eq("requester_role", role)
    .order("last_message_at", { ascending: false });
  logReadError("threads", threadError);
  const threads = (threadRows as ThreadRow[] | null) ?? [];
  if (threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);
  const itemIds = [...new Set(threads.map((t) => t.booking_request_item_id).filter((id): id is string => id !== null))];

  type ItemRow = { id: string; experience_id: string };
  const [messagesRes, itemsRes] = await Promise.all([
    supabase.from("support_messages").select(SUPPORT_MESSAGE_COLUMNS).in("support_thread_id", threadIds).order("created_at", { ascending: false }),
    itemIds.length > 0
      ? supabase.from("booking_request_items").select("id, experience_id").in("id", itemIds)
      : Promise.resolve({ data: [] as ItemRow[], error: null }),
  ]);
  logReadError("messages", messagesRes.error);

  const items = (itemsRes.data as ItemRow[] | null) ?? [];
  const experienceIds = [...new Set(items.map((i) => i.experience_id))];
  const { data: experienceRows } =
    experienceIds.length > 0
      ? await supabase.from("experiences").select("id, title").in("id", experienceIds)
      : { data: [] as { id: string; title: string }[] };
  const titleByExperience = new Map(((experienceRows as { id: string; title: string }[] | null) ?? []).map((e) => [e.id, e.title]));
  const titleByItem = new Map(items.map((i) => [i.id, titleByExperience.get(i.experience_id) ?? null]));

  const lastByThread = new Map<string, MessageRow>();
  const unreadByThread = new Map<string, number>();
  for (const row of (messagesRes.data as MessageRow[] | null) ?? []) {
    if (!lastByThread.has(row.support_thread_id)) lastByThread.set(row.support_thread_id, row);
    if (row.sender_type === "staff" && row.read_at === null) {
      unreadByThread.set(row.support_thread_id, (unreadByThread.get(row.support_thread_id) ?? 0) + 1);
    }
  }

  return threads.map((t) => {
    const last = lastByThread.get(t.id);
    return {
      threadId: t.id,
      category: t.category,
      status: t.status,
      bookingItemId: t.booking_request_item_id,
      experienceTitle: t.booking_request_item_id ? (titleByItem.get(t.booking_request_item_id) ?? null) : null,
      lastMessage: last ? { body: last.body, createdAt: last.created_at, isMine: last.sender_type === "user" } : null,
      lastMessageAt: t.last_message_at,
      unreadCount: unreadByThread.get(t.id) ?? 0,
    };
  });
}

/**
 * One of the caller's own guest-side threads with its full history, or null when it
 * doesn't exist / isn't theirs (indistinguishable on purpose).
 */
export async function getGuestSupportThread(supabase: SupabaseClient, threadId: string): Promise<SupportThreadState | null> {
  return getSupportThread(supabase, threadId, "guest");
}

/** As getGuestSupportThread, for either side: null unless it is the caller's own thread on that side. */
export async function getSupportThread(
  supabase: SupabaseClient,
  threadId: string,
  role: SupportRequesterRole,
): Promise<SupportThreadState | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: threadRow, error } = await supabase
    .from("support_threads")
    .select("id, status, booking_request_item_id")
    .eq("id", threadId)
    .eq("user_id", user.id)
    .eq("requester_role", role)
    .maybeSingle();
  logReadError("thread", error);
  const thread = threadRow as { id: string; status: SupportStatus; booking_request_item_id: string | null } | null;
  if (!thread) return null;

  const { data: messageRows, error: messagesError } = await supabase
    .from("support_messages")
    .select(SUPPORT_MESSAGE_COLUMNS)
    .eq("support_thread_id", thread.id)
    .order("created_at", { ascending: true });
  logReadError("messages", messagesError);
  if (messagesError) return null;

  return {
    threadId: thread.id,
    status: thread.status,
    bookingItemId: thread.booking_request_item_id,
    messages: ((messageRows as MessageRow[] | null) ?? []).map(mapSupportMessageRow),
  };
}

/**
 * The caller's open (OPEN or RESOLVED) guest-side thread for this booking — or, with
 * `bookingItemId` null, their open general thread. Lets Contact Felyn / Get help
 * continue that conversation instead of showing the form again. The database still
 * reuses it either way (support_open_thread), so this is a UX shortcut, not the rule.
 */
export async function getOpenGuestSupportThreadId(
  supabase: SupabaseClient,
  bookingItemId: string | null,
): Promise<string | null> {
  return getOpenSupportThreadId(supabase, "guest", bookingItemId);
}

/** As getOpenGuestSupportThreadId, for either side. */
export async function getOpenSupportThreadId(
  supabase: SupabaseClient,
  role: SupportRequesterRole,
  bookingItemId: string | null,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let query = supabase
    .from("support_threads")
    .select("id")
    .eq("user_id", user.id)
    .eq("requester_role", role)
    .neq("status", "CLOSED");
  query = bookingItemId ? query.eq("booking_request_item_id", bookingItemId) : query.is("booking_request_item_id", null);
  const { data, error } = await query.maybeSingle();
  logReadError("open thread", error);
  return (data as { id: string } | null)?.id ?? null;
}
