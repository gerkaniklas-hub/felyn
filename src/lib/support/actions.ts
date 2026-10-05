"use server";

import { assertGuestJourney } from "@/lib/journey-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupportCategory, SUPPORT_ERROR_CODES, SUPPORT_MESSAGE_MAX_LENGTH } from "./constants";
import { getSupportErrorMessage } from "./errors";
import { getGuestSupportThread, mapSupportMessageRow, type SupportMessage, type SupportThreadState } from "./queries";

/**
 * Guest-side Felyn support mutations. Every write goes through a 0029 database
 * function (support_open_thread / support_send_message / support_mark_read), which
 * checks auth.uid(), ownership, booking ownership and thread status itself — the
 * checks here are only for friendlier messages. requester_role is always 'guest':
 * this is the guest experience (host support is a later stage), and the journey
 * cookie only routes, it never authorizes.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpenSupportResult = { ok: true; threadId: string } | { ok: false; error: string };

/** Contact Felyn (bookingItemId null) or Get help for one booking. Continues the guest's open conversation for the same topic if there is one. */
export async function openGuestSupportConversation(input: {
  category: string;
  body: string;
  bookingItemId?: string | null;
}): Promise<OpenSupportResult> {
  await assertGuestJourney();
  const body = input.body.trim();
  if (!isSupportCategory(input.category)) return { ok: false, error: "Please choose what your message is about." };
  if (body.length === 0) return { ok: false, error: "Please write a message for Felyn." };
  if (body.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages are limited to ${SUPPORT_MESSAGE_MAX_LENGTH} characters.` };
  }
  const bookingItemId = input.bookingItemId ?? null;
  if (bookingItemId !== null && !UUID_PATTERN.test(bookingItemId)) {
    return { ok: false, error: getSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_FOUND, "open") };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("support_open_thread", {
    p_requester_role: "guest",
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

/** A guest reply in their own conversation. A resolved conversation re-opens (the database does this); a closed one refuses. */
export async function sendGuestSupportMessage(threadId: string, body: string): Promise<SendSupportMessageResult> {
  await assertGuestJourney();
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "Write a message before sending.", closed: false };
  if (trimmed.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages are limited to ${SUPPORT_MESSAGE_MAX_LENGTH} characters.`, closed: false };
  }

  const supabase = await createSupabaseServerClient();
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

/** Marks Felyn Team's messages in the guest's own conversation as read. Best effort: a failure only leaves them unread. */
export async function markGuestSupportThreadRead(threadId: string): Promise<void> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("support_mark_read", { p_thread_id: threadId });
  if (error) console.error(`support: mark read failed (code ${error.code ?? "unknown"})`);
}

/** Lazy-loads one of the guest's own conversations for the Messages pane; null if it isn't theirs or can't be read. */
export async function getGuestSupportThreadAction(threadId: string): Promise<SupportThreadState | null> {
  await assertGuestJourney();
  if (!UUID_PATTERN.test(threadId)) return null;
  const supabase = await createSupabaseServerClient();
  return getGuestSupportThread(supabase, threadId);
}
