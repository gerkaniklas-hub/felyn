"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupportThreadState } from "./queries";
import {
  loadSupportThread,
  markSupportThreadRead,
  openSupportConversation,
  sendSupportMessage,
  type OpenSupportResult,
  type SendSupportMessageResult,
} from "./thread-core";

/**
 * Host-side Felyn support mutations (approved hosts only). Server Actions are
 * reachable directly, so EVERY action first verifies the caller has an approved
 * host profile — their own providers row, which only felyn_admin can create (0023)
 * — the same single-row check the proxy and assertSharedActionAllowedForJourney
 * use; the journey cookie is never trusted. requester_role is always 'host'. The
 * 0029 database functions then check everything again (support_open_thread refuses
 * the host role without a providers row, and host-booking tickets for an
 * experience that isn't the caller's).
 */

/** The caller's session client if they are an approved host, else null. Fails closed on a read error. */
async function approvedHostClient(): Promise<SupabaseClient | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("providers").select("id").eq("user_id", user.id).maybeSingle();
  if (error) {
    console.error(`support: host profile check failed (code ${error.code ?? "unknown"})`);
    return null;
  }
  return data ? supabase : null;
}

const NOT_A_HOST = "Host support is available once your host profile is approved. Please sign in to your host account.";

/** Host Contact Felyn (bookingItemId null) or Get help for one of the host's bookings. Continues the open conversation for the same topic if there is one. */
export async function openHostSupportConversation(input: {
  category: string;
  body: string;
  bookingItemId?: string | null;
}): Promise<OpenSupportResult> {
  const supabase = await approvedHostClient();
  if (!supabase) return { ok: false, error: NOT_A_HOST };
  return openSupportConversation(supabase, "host", input);
}

/** A host reply in their own conversation. A resolved conversation re-opens (the database does this); a closed one refuses. */
export async function sendHostSupportMessage(threadId: string, body: string): Promise<SendSupportMessageResult> {
  const supabase = await approvedHostClient();
  if (!supabase) return { ok: false, error: NOT_A_HOST, closed: false };
  return sendSupportMessage(supabase, threadId, body);
}

/** Marks Felyn Team's messages in the host's own conversation as read. Best effort. */
export async function markHostSupportThreadRead(threadId: string): Promise<void> {
  const supabase = await approvedHostClient();
  if (!supabase) return;
  await markSupportThreadRead(supabase, threadId);
}

/** Re-reads one of the host's own host-side conversations; null if it isn't theirs or can't be read. */
export async function getHostSupportThreadAction(threadId: string): Promise<SupportThreadState | null> {
  const supabase = await approvedHostClient();
  if (!supabase) return null;
  return loadSupportThread(supabase, threadId, "host");
}
