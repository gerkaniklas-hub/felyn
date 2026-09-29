"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMessages, mapMessageRow, MESSAGE_MAX_LENGTH, type Message } from "./messages";
import { assertSharedActionAllowedForJourney } from "@/lib/journey-server";

export type SendMessageResult = { ok: true; message: Message } | { ok: false; error: string };

/**
 * Sends one message on one booking item. `sender_id` is ALWAYS the
 * server-verified caller (supabase.auth.getUser()) — the client is never
 * asked for, and never gets to assert, who it's sending as. The database
 * (0014) independently enforces the same thing (`sender_id = auth.uid()`)
 * plus the active-status requirement, re-checked on every insert against
 * the live row — a stale client that still thinks an item is REQUESTED
 * gets a hard rejection the instant the database says otherwise.
 */
export async function sendMessage(itemId: string, body: string): Promise<SendMessageResult> {
  await assertSharedActionAllowedForJourney();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You need to be signed in to send a message." };
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Write a message before sending." };
  }
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages are limited to ${MESSAGE_MAX_LENGTH} characters.` };
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({ booking_request_item_id: itemId, sender_id: user.id, body: trimmed })
    .select("id, booking_request_item_id, sender_id, body, created_at, read_at")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: "We couldn't send that message. This conversation may be closed, or you may not have access to it.",
    };
  }

  return { ok: true, message: mapMessageRow(data) };
}

/**
 * Marks every message the CALLER did not send as read. The database (0014)
 * only lets this touch rows belonging to a genuine participant, only ever
 * moves read_at from null to the server's own clock (never a client-
 * supplied value, and never back to null), and a column-level grant means
 * nothing but read_at can change through this call regardless — see the
 * migration for the full reasoning.
 */
export async function markMessagesRead(itemId: string): Promise<void> {
  await assertSharedActionAllowedForJourney();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("booking_request_item_id", itemId)
    .is("read_at", null)
    .neq("sender_id", user.id);
}

/** Client-callable wrapper around getMessages, for lazy-loading a thread on demand (e.g. the guest's "Message host" modal). */
export async function getMessagesAction(itemId: string): Promise<Message[]> {
  await assertSharedActionAllowedForJourney();
  const supabase = await createSupabaseServerClient();
  return getMessages(supabase, itemId);
}
