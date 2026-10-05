"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ThreadComposer } from "@/components/messaging/ThreadComposer";
import { ThreadMessages } from "@/components/messaging/ThreadMessages";
import { Button } from "@/components/ui/button";
import {
  staffMarkSupportThreadRead,
  staffReloadSupportThread,
  staffReplyToSupportThread,
  staffSetSupportThreadStatus,
} from "@/lib/support/admin-actions";
import { getStaffReplyMode } from "@/lib/support/admin-format";
import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUSES,
  SUPPORT_TEAM_NAME,
  type SupportStatus,
} from "@/lib/support/constants";
import type { SupportMessage } from "@/lib/support/queries";
import { useSupportThreadRealtime } from "../useSupportThreadRealtime";
import { StaffStatusBadge } from "./StaffStatusBadge";

const STATUS_ACTION_LABELS: Record<SupportStatus, string> = { OPEN: "Open", RESOLVED: "Resolve", CLOSED: "Close" };

/**
 * One ticket for the Felyn team: the conversation (the same ThreadMessages /
 * ThreadComposer the guest sees, from the other side — the team's replies on the
 * right, the customer's on the left, labelled with their first name), status
 * controls, and the server-rendered customer/booking context in `aside`.
 *
 * Every action is a staff Server Action backed by a 0029 staff function; this
 * component never decides a rule on its own, it mirrors the database:
 *   OPEN      reply
 *   RESOLVED  reply (the status stays RESOLVED; the customer can still reply)
 *   CLOSED    no reply box — "Reopen conversation" first (the database refuses
 *             staff replies to a closed conversation)
 * Live: new customer messages and status changes arrive through the same
 * useSupportThreadRealtime hook as the guest's thread (RLS lets staff see any).
 */
export function StaffTicketWorkspace({
  threadId,
  initialStatus,
  initialMessages,
  customerShortName,
  aside,
}: {
  threadId: string;
  initialStatus: SupportStatus;
  initialMessages: SupportMessage[];
  customerShortName: string;
  aside: ReactNode;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [status, setStatus] = useState(initialStatus);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [statusPending, setStatusPending] = useState<SupportStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const liveProblem = useSupportThreadRealtime(threadId, {
    onMessage: (message) =>
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message])),
    onStatus: (next) => {
      if (next !== status) setStatus(next);
    },
  });

  // The customer's messages on screen are marked read through support_mark_read
  // (staff side: only the customer's messages). Only the ids unread at call time are
  // updated locally, so a message arriving meanwhile stays marked as new.
  useEffect(() => {
    const unreadIds = messages.filter((m) => m.senderType === "user" && !m.readAt).map((m) => m.id);
    if (unreadIds.length === 0) return;
    let cancelled = false;
    staffMarkSupportThreadRead(threadId).then(() => {
      if (cancelled) return;
      const readAt = new Date().toISOString();
      setMessages((prev) => prev.map((m) => (unreadIds.includes(m.id) ? { ...m, readAt } : m)));
    });
    return () => {
      cancelled = true;
    };
  }, [messages, threadId]);

  async function sendReply() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setReplyError(null);
    const result = await staffReplyToSupportThread(threadId, body);
    setSending(false);
    if (!result.ok) {
      if (result.closed) setStatus("CLOSED");
      setReplyError(result.closed ? null : result.error);
      return;
    }
    setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message]));
    setDraft("");
  }

  async function changeStatus(next: SupportStatus) {
    if (statusPending || next === status) return;
    setStatusPending(next);
    setStatusError(null);
    const result = await staffSetSupportThreadStatus(threadId, next);
    setStatusPending(null);
    if (!result.ok) {
      setStatusError(result.error);
      return;
    }
    setStatus(result.status);
  }

  async function refresh() {
    setRefreshing(true);
    const fresh = await staffReloadSupportThread(threadId);
    setRefreshing(false);
    if (fresh) {
      setMessages(fresh.messages);
      setStatus(fresh.status);
    }
  }

  const mode = getStaffReplyMode(status);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="flex h-[calc(100dvh-13rem)] min-h-[28rem] flex-col overflow-hidden rounded-3xl border border-ivory-300 bg-ivory-100/60 shadow-sm">
        {liveProblem ? (
          <div className="flex items-center justify-between gap-3 bg-gold-100 px-4 py-2 text-xs text-gold-700 sm:px-6">
            <span>Live updates are paused. New messages may not appear until you refresh.</span>
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
            mine: m.senderType === "staff",
            senderLabel: customerShortName,
          }))}
          appearance="pane"
        />

        {mode === "reopen-required" ? (
          <div className="flex flex-col items-center gap-2 border-t border-ivory-300 bg-ivory-50 px-4 py-4 text-center">
            <p className="text-sm text-navy-500">
              This conversation is closed — the customer can&apos;t reply. Reopen it to reply.
            </p>
            <Button type="button" size="sm" onClick={() => changeStatus("OPEN")} disabled={statusPending !== null}>
              {statusPending === "OPEN" ? "Reopening…" : "Reopen conversation"}
            </Button>
            {statusError ? <p className="text-xs font-medium text-gold-700">{statusError}</p> : null}
          </div>
        ) : (
          <ThreadComposer
            draft={draft}
            onDraftChange={setDraft}
            onSend={sendReply}
            sending={sending}
            error={replyError}
            caption={
              mode === "reply-resolved"
                ? `Resolved — replying keeps it resolved. The customer sees your reply as ${SUPPORT_TEAM_NAME} and can still answer.`
                : `The customer sees your reply as ${SUPPORT_TEAM_NAME}.`
            }
            maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
            appearance="pane"
          />
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <div className="rounded-2xl border border-ivory-300 bg-ivory-50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium tracking-wide text-navy-300 uppercase">Status</h2>
            <StaffStatusBadge status={status} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Change status">
            {SUPPORT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeStatus(s)}
                disabled={statusPending !== null || s === status}
                aria-pressed={s === status}
                className={`h-10 rounded-xl border text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                  s === status
                    ? "border-navy-900 bg-navy-900 text-ivory-50"
                    : "border-ivory-300 bg-ivory-50 text-navy-700 hover:border-navy-300 disabled:opacity-50"
                }`}
              >
                {statusPending === s ? "…" : s === status ? SUPPORT_STATUS_LABELS[s] : STATUS_ACTION_LABELS[s]}
              </button>
            ))}
          </div>
          {statusError && mode !== "reopen-required" ? (
            <p className="mt-2 text-xs font-medium text-gold-700">{statusError}</p>
          ) : null}
          <p className="mt-3 text-xs text-navy-400">
            {status === "OPEN"
              ? "Needs the team's attention."
              : status === "RESOLVED"
                ? "Handled. The customer can still reply, which reopens it."
                : "Finished. The customer can read it but not reply."}
          </p>
        </div>
        {aside}
      </aside>
    </div>
  );
}
