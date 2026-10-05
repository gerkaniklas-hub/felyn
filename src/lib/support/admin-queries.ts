import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupportCategory, SupportRequesterRole, SupportSenderType, SupportStatus } from "./constants";
import { mapSupportMessageRow, SUPPORT_MESSAGE_COLUMNS, type SupportMessage } from "./queries";

/**
 * Felyn Support (staff) reads, for the /admin/support screens. Plain server-only
 * helpers that take the STAFF user's own session client (from requireStaff /
 * getStaffContext — never the service-role key). The database decides: the list
 * and context come from staff-only functions that re-check is_felyn_staff() (0029),
 * and the message reads rely on the staff SELECT policies. A non-staff client gets
 * an error or nothing back from every one of these.
 */

export const STAFF_TICKET_PAGE_SIZE = 50;

export type StaffTicketRow = {
  threadId: string;
  requesterRole: SupportRequesterRole;
  category: SupportCategory;
  status: SupportStatus;
  isBooking: boolean;
  createdAt: string;
  lastMessageAt: string;
  customer: { firstName: string | null; lastName: string | null; email: string | null };
  experienceTitle: string | null;
  lastMessage: { body: string; fromCustomer: boolean } | null;
  /** Customer messages the team hasn't read yet. */
  unreadCount: number;
};

/** Keyset cursor for the next page: the last row's activity time and id. */
export type StaffTicketCursor = { at: string; id: string };

export type StaffTicketPage = { rows: StaffTicketRow[]; nextCursor: StaffTicketCursor | null };

export type StaffTicketContext = {
  threadId: string;
  requesterRole: SupportRequesterRole;
  category: SupportCategory;
  status: SupportStatus;
  createdAt: string;
  lastMessageAt: string;
  customer: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  /** The customer's host display name, when they have a host profile. */
  customerHostName: string | null;
  booking: {
    experienceTitle: string | null;
    hostName: string | null;
    guestFirstName: string | null;
    plannedDate: string;
    plannedMoment: string;
    preferredTime: string | null;
    guestCount: number;
    status: string;
    stayName: string | null;
  } | null;
};

function logError(what: string, error: { code?: string } | null) {
  if (error) console.error(`support admin: ${what} failed (code ${error.code ?? "unknown"})`);
}

type ListRow = {
  thread_id: string;
  requester_role: SupportRequesterRole;
  category: SupportCategory;
  status: SupportStatus;
  is_booking: boolean;
  created_at: string;
  last_message_at: string;
  user_first_name: string | null;
  user_last_name: string | null;
  user_email: string | null;
  booking_experience_title: string | null;
  last_message_body: string | null;
  last_message_sender_type: SupportSenderType | null;
  unread_count: number;
};

/** One page of tickets in one status, most recent activity first. Null if the list can't be read. */
export async function getStaffTicketPage(
  supabase: SupabaseClient,
  status: SupportStatus,
  cursor: StaffTicketCursor | null,
): Promise<StaffTicketPage | null> {
  // One extra row tells us whether an older page exists.
  const { data, error } = await supabase.rpc("support_staff_list_threads", {
    p_status: status,
    p_limit: STAFF_TICKET_PAGE_SIZE + 1,
    p_before_at: cursor?.at ?? null,
    p_before_id: cursor?.id ?? null,
  });
  logError("ticket list", error);
  if (error) return null;

  const all = (data as ListRow[] | null) ?? [];
  const page = all.slice(0, STAFF_TICKET_PAGE_SIZE);
  const rows: StaffTicketRow[] = page.map((r) => ({
    threadId: r.thread_id,
    requesterRole: r.requester_role,
    category: r.category,
    status: r.status,
    isBooking: r.is_booking,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
    customer: { firstName: r.user_first_name, lastName: r.user_last_name, email: r.user_email },
    experienceTitle: r.booking_experience_title,
    lastMessage:
      r.last_message_body !== null ? { body: r.last_message_body, fromCustomer: r.last_message_sender_type === "user" } : null,
    unreadCount: r.unread_count,
  }));
  const last = page[page.length - 1];
  return { rows, nextCursor: all.length > STAFF_TICKET_PAGE_SIZE && last ? { at: last.last_message_at, id: last.thread_id } : null };
}

/** How many tickets are in each status (for the filter tabs). A count that can't be read is null. */
export async function getStaffStatusCounts(supabase: SupabaseClient): Promise<Record<SupportStatus, number | null>> {
  const count = async (status: SupportStatus) => {
    const { count: n, error } = await supabase
      .from("support_threads")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    logError(`${status} count`, error);
    return error ? null : (n ?? 0);
  };
  const [open, resolved, closed] = await Promise.all([count("OPEN"), count("RESOLVED"), count("CLOSED")]);
  return { OPEN: open, RESOLVED: resolved, CLOSED: closed };
}

type ContextRow = {
  thread_id: string;
  requester_role: SupportRequesterRole;
  category: SupportCategory;
  status: SupportStatus;
  booking_request_item_id: string | null;
  created_at: string;
  last_message_at: string;
  user_first_name: string | null;
  user_last_name: string | null;
  user_email: string | null;
  user_phone: string | null;
  requester_provider_display_name: string | null;
  booking_experience_title: string | null;
  booking_host_display_name: string | null;
  booking_guest_first_name: string | null;
  booking_planned_date: string | null;
  booking_planned_moment: string | null;
  booking_preferred_time: string | null;
  booking_guest_count: number | null;
  booking_status: string | null;
  booking_stay_name: string | null;
};

/** The live customer/booking context (support_staff_thread_context) and full history; null if not found or not readable. */
export async function getStaffTicket(
  supabase: SupabaseClient,
  threadId: string,
): Promise<{ context: StaffTicketContext; messages: SupportMessage[] } | null> {
  const [contextRes, messagesRes] = await Promise.all([
    supabase.rpc("support_staff_thread_context", { p_thread_id: threadId }),
    supabase
      .from("support_messages")
      .select(SUPPORT_MESSAGE_COLUMNS)
      .eq("support_thread_id", threadId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  logError("ticket context", contextRes.error);
  logError("ticket messages", messagesRes.error);
  const row = ((contextRes.data as ContextRow[] | null) ?? [])[0];
  if (contextRes.error || messagesRes.error || !row) return null;

  return {
    context: {
      threadId: row.thread_id,
      requesterRole: row.requester_role,
      category: row.category,
      status: row.status,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      customer: { firstName: row.user_first_name, lastName: row.user_last_name, email: row.user_email, phone: row.user_phone },
      customerHostName: row.requester_provider_display_name,
      booking:
        row.booking_request_item_id && row.booking_planned_date
          ? {
              experienceTitle: row.booking_experience_title,
              hostName: row.booking_host_display_name,
              guestFirstName: row.booking_guest_first_name,
              plannedDate: row.booking_planned_date,
              plannedMoment: row.booking_planned_moment ?? "",
              preferredTime: row.booking_preferred_time,
              guestCount: row.booking_guest_count ?? 0,
              status: row.booking_status ?? "",
              stayName: row.booking_stay_name,
            }
          : null,
    },
    messages: ((messagesRes.data as Parameters<typeof mapSupportMessageRow>[0][] | null) ?? []).map(mapSupportMessageRow),
  };
}
