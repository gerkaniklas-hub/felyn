"use server";

import { getStaffTicket } from "./admin-queries";
import { SUPPORT_MESSAGE_MAX_LENGTH, SUPPORT_STATUSES, type SupportStatus } from "./constants";
import { getStaffSupportErrorMessage } from "./errors";
import { mapSupportMessageRow, type SupportMessage } from "./queries";
import { getStaffContext } from "./staff";

/**
 * Felyn Support (staff) mutations, called from the /admin/support screens.
 * Server Actions are reachable directly, so EVERY action checks staff status
 * itself (getStaffContext — the database's is_felyn_staff()) and then calls a
 * 0029 staff function that checks it again. They run as the staff user's own
 * session; the service-role key is never used. Nothing here writes a table
 * directly: replies go through support_staff_reply, status through
 * support_staff_set_status, read state through support_mark_read.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_ALLOWED = getStaffSupportErrorMessage("42501");

export type StaffReplyResult = { ok: true; message: SupportMessage } | { ok: false; error: string; closed: boolean };

/** A Felyn Team reply. Allowed while OPEN or RESOLVED (the status doesn't change); a CLOSED conversation must be re-opened first. */
export async function staffReplyToSupportThread(threadId: string, body: string): Promise<StaffReplyResult> {
  const staff = await getStaffContext();
  if (!staff) return { ok: false, error: NOT_ALLOWED, closed: false };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "Write a reply before sending.", closed: false };
  if (trimmed.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Replies are limited to ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`, closed: false };
  }
  if (!UUID_PATTERN.test(threadId)) return { ok: false, error: getStaffSupportErrorMessage("P0002"), closed: false };

  const { data, error } = await staff.supabase.rpc("support_staff_reply", { p_thread_id: threadId, p_body: trimmed });
  if (error || !data) {
    if (error) console.error(`support admin: reply failed (code ${error.code ?? "unknown"})`);
    return { ok: false, error: getStaffSupportErrorMessage(error?.code), closed: error?.code === "55000" };
  }
  return { ok: true, message: mapSupportMessageRow(data) };
}

export type StaffSetStatusResult = { ok: true; status: SupportStatus } | { ok: false; error: string };

/** OPEN / RESOLVED / CLOSED. The database keeps the timestamps right and refuses a re-open that would duplicate an open conversation. */
export async function staffSetSupportThreadStatus(threadId: string, status: string): Promise<StaffSetStatusResult> {
  const staff = await getStaffContext();
  if (!staff) return { ok: false, error: NOT_ALLOWED };
  if (!(SUPPORT_STATUSES as readonly string[]).includes(status)) return { ok: false, error: getStaffSupportErrorMessage("22023") };
  if (!UUID_PATTERN.test(threadId)) return { ok: false, error: getStaffSupportErrorMessage("P0002") };

  const { data, error } = await staff.supabase.rpc("support_staff_set_status", { p_thread_id: threadId, p_status: status });
  if (error || !data) {
    if (error) console.error(`support admin: status change failed (code ${error.code ?? "unknown"})`);
    return { ok: false, error: getStaffSupportErrorMessage(error?.code) };
  }
  return { ok: true, status: (data as { status: SupportStatus }).status };
}

/** Marks the customer's messages in this conversation as read by the team. Best effort. */
export async function staffMarkSupportThreadRead(threadId: string): Promise<void> {
  const staff = await getStaffContext();
  if (!staff || !UUID_PATTERN.test(threadId)) return;
  const { error } = await staff.supabase.rpc("support_mark_read", { p_thread_id: threadId });
  if (error) console.error(`support admin: mark read failed (code ${error.code ?? "unknown"})`);
}

/** Re-reads one conversation's status and messages (the "live updates paused" refresh). */
export async function staffReloadSupportThread(
  threadId: string,
): Promise<{ status: SupportStatus; messages: SupportMessage[] } | null> {
  const staff = await getStaffContext();
  if (!staff || !UUID_PATTERN.test(threadId)) return null;
  const ticket = await getStaffTicket(staff.supabase, threadId);
  return ticket ? { status: ticket.context.status, messages: ticket.messages } : null;
}
