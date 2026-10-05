"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ThreadComposer } from "@/components/messaging/ThreadComposer";
import { ThreadMessages } from "@/components/messaging/ThreadMessages";
import { getGuestSupportThreadAction, markGuestSupportThreadRead, sendGuestSupportMessage } from "@/lib/support/actions";
import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_TEAM_NAME,
  type SupportRequesterRole,
  type SupportStatus,
} from "@/lib/support/constants";
import { getHostSupportThreadAction, markHostSupportThreadRead, sendHostSupportMessage } from "@/lib/support/host-actions";
import {
  getContactAgainHref,
  SUPPORT_CLOSED_LABEL,
  SUPPORT_REOPENED_CAPTION,
  SUPPORT_RESOLVED_CAPTION,
} from "@/lib/support/inbox";
import type { SupportMessage } from "@/lib/support/queries";
import { useSupportThreadRealtime } from "./useSupportThreadRealtime";

/** Each side talks to the database through its own gated Server Actions (fixed requester_role). */
const ACTIONS = {
  guest: { send: sendGuestSupportMessage, markRead: markGuestSupportThreadRead, load: getGuestSupportThreadAction },
  host: { send: sendHostSupportMessage, markRead: markHostSupportThreadRead, load: getHostSupportThreadAction },
} as const;

/**
 * A guest's conversation with the Felyn Team. Looks exactly like a booking
 * conversation (same ThreadMessages / ThreadComposer as MessageThread), but talks
 * to the support tables: realtime on support_messages (new messages) and on its
 * support_threads row (status changes, e.g. resolved/closed by the Felyn Team), sending via
 * support_send_message and read state via support_mark_read (0029) — never a direct
 * table write. The database is the authority on every rule; this component only
 * reflects it:
 *   OPEN      read and reply
 *   RESOLVED  read and reply; replying re-opens it (the database does this)
 *   CLOSED    read only, with "Contact Felyn again" to start a NEW conversation
 * `requesterRole` picks the guest (default) or host side: its actions and routes.
 */
export function SupportThread({
  threadId,
  bookingItemId,
  initialMessages,
  initialStatus,
  appearance = "pane",
  onStatusChange,
  requesterRole = "guest",
}: {
  threadId: string;
  bookingItemId: string | null;
  initialMessages: SupportMessage[];
  initialStatus: SupportStatus;
  appearance?: "card" | "pane";
  /** Lets the inbox keep its list row and header in step (e.g. "Resolved" disappearing after a reply). */
  onStatusChange?: (status: SupportStatus) => void;
  requesterRole?: SupportRequesterRole;
}) {
  const actions = ACTIONS[requesterRole];
  const [messages, setMessages] = useState(initialMessages);
  const [status, setStatus] = useState(initialStatus);
  const [reopened, setReopened] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function updateStatus(next: SupportStatus) {
    setStatus(next);
    onStatusChange?.(next);
  }

  // Live new messages and status changes (resolved/closed by the Felyn Team, or
  // re-opened) — see useSupportThreadRealtime. Handlers always see current state.
  const liveProblem = useSupportThreadRealtime(threadId, {
    onMessage: (message) =>
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message])),
    onStatus: (next) => {
      if (next === status) return;
      setStatus(next);
      // "You reopened this conversation" only describes the guest's own reply.
      setReopened(false);
      onStatusChange?.(next);
    },
  });

  // Felyn Team messages on screen are marked read through support_mark_read, which
  // only ever touches the OTHER side's messages in the caller's own thread. Only the
  // ids unread at call time are updated locally, so a reply arriving meanwhile stays unread.
  useEffect(() => {
    const unreadIds = messages.filter((m) => m.senderType === "staff" && !m.readAt).map((m) => m.id);
    if (unreadIds.length === 0) return;
    let cancelled = false;
    actions.markRead(threadId).then(() => {
      if (cancelled) return;
      const readAt = new Date().toISOString();
      setMessages((prev) => prev.map((m) => (unreadIds.includes(m.id) ? { ...m, readAt } : m)));
    });
    return () => {
      cancelled = true;
    };
  }, [messages, threadId, actions]);

  async function refresh() {
    setRefreshing(true);
    const state = await actions.load(threadId);
    setRefreshing(false);
    if (state) {
      setMessages(state.messages);
      updateStatus(state.status);
    }
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    const result = await actions.send(threadId, body);
    setSending(false);
    if (!result.ok) {
      if (result.closed) {
        // Closed by the Felyn Team since this was opened: show the closed state instead of an error.
        updateStatus("CLOSED");
        return;
      }
      setError(result.error);
      return;
    }
    setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message]));
    setDraft("");
    if (status === "RESOLVED") {
      updateStatus("OPEN");
      setReopened(true);
    }
  }

  const pane = appearance === "pane";
  const caption = status === "RESOLVED" ? SUPPORT_RESOLVED_CAPTION : reopened ? SUPPORT_REOPENED_CAPTION : undefined;

  return (
    <div className={`flex h-full min-h-0 flex-col ${pane ? "gap-0" : "gap-3"}`}>
      {liveProblem ? (
        <div className="flex items-center justify-between gap-3 bg-gold-100 px-4 py-2 text-xs text-gold-700 sm:px-6">
          <span>Live updates are paused. New replies may not appear until you refresh.</span>
          <button type="button" onClick={refresh} disabled={refreshing} className="shrink-0 font-semibold hover:underline disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      ) : null}

      <ThreadMessages
        messages={messages.map((m) => ({
          id: m.id,
          body: m.body,
          createdAt: m.createdAt,
          mine: m.senderType === "user",
          senderLabel: SUPPORT_TEAM_NAME,
        }))}
        appearance={appearance}
      />

      {status === "CLOSED" ? (
        <div
          className={`flex flex-col items-center gap-1.5 bg-ivory-100 px-3 text-center ${pane ? "border-t border-ivory-300 py-4" : "rounded-lg py-3"}`}
        >
          <p className="text-sm text-navy-400">{SUPPORT_CLOSED_LABEL}</p>
          <Link href={getContactAgainHref(bookingItemId, requesterRole)} className="text-sm font-medium text-sky-600 hover:text-sky-700">
            Contact Felyn again
          </Link>
        </div>
      ) : (
        <ThreadComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          sending={sending}
          error={error}
          caption={caption}
          maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
          appearance={appearance}
        />
      )}
    </div>
  );
}
