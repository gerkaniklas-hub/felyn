"use server";

import { assertGuestJourney } from "@/lib/journey-server";
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
 * Guest-side Felyn support mutations. Every write goes through a 0029 database
 * function (via ./thread-core), which checks auth.uid(), ownership, booking
 * ownership and thread status itself. requester_role is always 'guest' here; the
 * host side has its own actions (./host-actions.ts). The journey cookie only
 * routes, it never authorizes.
 */

export type { OpenSupportResult, SendSupportMessageResult };

/** Contact Felyn (bookingItemId null) or Get help for one booking. Continues the guest's open conversation for the same topic if there is one. */
export async function openGuestSupportConversation(input: {
  category: string;
  body: string;
  bookingItemId?: string | null;
}): Promise<OpenSupportResult> {
  await assertGuestJourney();
  return openSupportConversation(await createSupabaseServerClient(), "guest", input);
}

/** A guest reply in their own conversation. A resolved conversation re-opens (the database does this); a closed one refuses. */
export async function sendGuestSupportMessage(threadId: string, body: string): Promise<SendSupportMessageResult> {
  await assertGuestJourney();
  return sendSupportMessage(await createSupabaseServerClient(), threadId, body);
}

/** Marks Felyn Team's messages in the guest's own conversation as read. Best effort: a failure only leaves them unread. */
export async function markGuestSupportThreadRead(threadId: string): Promise<void> {
  await assertGuestJourney();
  await markSupportThreadRead(await createSupabaseServerClient(), threadId);
}

/** Lazy-loads one of the guest's own conversations for the Messages pane; null if it isn't theirs or can't be read. */
export async function getGuestSupportThreadAction(threadId: string): Promise<SupportThreadState | null> {
  await assertGuestJourney();
  return loadSupportThread(await createSupabaseServerClient(), threadId, "guest");
}
