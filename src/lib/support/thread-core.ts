import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSupportCategory, SUPPORT_ERROR_CODES, SUPPORT_MESSAGE_MAX_LENGTH, type SupportRequesterRole } from "./constants";
import { getSupportErrorMessage } from "./errors";
import { getSupportThread, mapSupportMessageRow, type SupportMessage, type SupportThreadState } from "./queries";

/**
 * The shared body of the guest and host support Server Actions (./actions.ts,
 * ./host-actions.ts). NOT callable from the client: each exported action first
 * runs its own side's gate (guest journey / approved host profile) and then calls
 * one of these with a FIXED role. Every write goes through a 0029 database function
 * (support_open_thread / support_send_message / support_mark_read), which checks
 * auth.uid(), the role, booking ownership and thread status itself — the checks here
 * are only for friendlier messages.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export type OpenSupportResult = { ok: true; threadId: string } | { ok: false; error: string };

export async function openSupportConversation(
  supabase: SupabaseClient,
  role: SupportRequesterRole,
  input: { category: string; body: string; bookingItemId?: string | null },
): Promise<OpenSupportResult> {
  const body = input.body.trim();
  if (!isSupportCategory(input.category)) return { ok: false, error: "Please choose what your message is about." };
  if (body.length === 0) return { ok: false, error: "Please write a message for Felyn." };
  if (body.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages are limited to ${SUPPORT_MESSAGE_MAX_LENGTH} characters.` };
  }
  const bookingItemId = input.bookingItemId ?? null;
  if (bookingItemId !== null && !isUuid(bookingItemId)) {
    return { ok: false, error: getSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_FOUND, "open") };
  }

  const { data, error } = await supabase.rpc("support_open_thread", {
    p_requester_role: role,
    p_category: input.category,
    p_body: body,
    p_booking_request_item_id: bookingItemId,
  });
  if (error || typeof data !== "string") {
    if (error) console.error(`support: open thread failed (code ${error.code ?? "unknown"})`);
    return { ok: false, error: getSupportErrorMessage(error?.code, "open") };
  }
  return { ok: true, threadId: data };
}

export type SendSupportMessageResult =
  | { ok: true; message: SupportMessage }
  | { ok: false; error: string; closed: boolean };

export async function sendSupportMessage(
  supabase: SupabaseClient,
  threadId: string,
  body: string,
): Promise<SendSupportMessageResult> {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "Write a message before sending.", closed: false };
  if (trimmed.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages are limited to ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`, closed: false };
  }

  const { data, error } = await supabase.rpc("support_send_message", { p_thread_id: threadId, p_body: trimmed });
  if (error || !data) {
    if (error) console.error(`support: send failed (code ${error.code ?? "unknown"})`);
    return {
      ok: false,
      error: getSupportErrorMessage(error?.code, "send"),
      closed: error?.code === SUPPORT_ERROR_CODES.CLOSED,
    };
  }
  return { ok: true, message: mapSupportMessageRow(data) };
}

export async function markSupportThreadRead(supabase: SupabaseClient, threadId: string): Promise<void> {
  const { error } = await supabase.rpc("support_mark_read", { p_thread_id: threadId });
  if (error) console.error(`support: mark read failed (code ${error.code ?? "unknown"})`);
}

export async function loadSupportThread(
  supabase: SupabaseClient,
  threadId: string,
  role: SupportRequesterRole,
): Promise<SupportThreadState | null> {
  if (!isUuid(threadId)) return null;
  return getSupportThread(supabase, threadId, role);
}
