"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { markMessagesRead, sendMessage } from "@/lib/messaging/actions";
import { MESSAGE_MAX_LENGTH, type Message } from "@/lib/messaging/messages";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * The one message-thread implementation, shared by the provider booking
 * detail page and the guest's "Message host" modal — never duplicated.
 * Subscribes to realtime inserts for this exact booking_request_item_id;
 * RLS (0014) already limits what a subscription can ever deliver to rows
 * the signed-in participant could otherwise SELECT, so there is nothing
 * further to authorize here. Sending and marking-read both go through the
 * server actions in lib/messaging/actions.ts — this component never writes
 * to Supabase directly, and never trusts anything about "whose message this
 * is" beyond what the server actually returns.
 */
export function MessageThread({
  itemId,
  currentUserId,
  initialMessages,
  canSend,
  closedLabel,
  openCaption,
  visible = true,
  onMessagesChange,
  appearance = "card",
}: {
  itemId: string;
  currentUserId: string;
  initialMessages: Message[];
  /** False once the item is DECLINED/WITHDRAWN/CANCELLED past its window — the database refuses inserts either way (0014/0021); this just hides the composer. */
  canSend: boolean;
  closedLabel?: string;
  /** Stage 2c-B: shown above the composer while a DECLINED/CANCELLED conversation is still inside its 30-day window — see getMessagingOpenCaption. */
  openCaption?: string;
  /**
   * Whether the thread is actually on screen right now — default true (the
   * provider detail page's usage). The floating chat window keeps this
   * component mounted while minimized (to preserve the draft and realtime
   * subscription — see MessageThread's own notes) and passes `false` then,
   * so an incoming message never gets silently marked read before the
   * guest/host has actually seen it.
   */
  visible?: boolean;
  /** Lets a parent (the floating window) mirror this thread's messages for its own minimized unread badge — never used to bypass this component's own read/send logic. */
  onMessagesChange?: (messages: Message[]) => void;
  /** "card" (default, unchanged): the boxed thread used by the floating window and the provider booking page. "pane": borderless with sky outgoing bubbles, for the guest inbox's conversation pane. Presentation only. */
  appearance?: "card" | "pane";
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Created ONCE per component instance, not per effect run. @supabase/ssr's
  // createBrowserClient shares an underlying client/socket across calls with
  // the same URL/key (deliberately, to avoid duplicate GoTrueClient
  // instances) — calling it fresh inside the effect body meant that in dev,
  // where React mounts every effect twice (mount → cleanup → mount) to
  // surface exactly this kind of bug, the FIRST instance's cleanup
  // (removeChannel) raced the SECOND instance's channel join on that same
  // shared socket. The second channel still reported SUBSCRIBED, but its
  // `.on()` handler was never actually wired up to receive broadcasts —
  // confirmed by instrumenting it directly (the callback never fired, even
  // though a channel created fresh on the same client, outside this race,
  // received the identical event immediately). A stable client reference
  // removes the race: cleanup only ever tears down THIS instance's own
  // channel object, never something the next mount depends on.
  const [supabase] = useState(() => createSupabaseBrowserClient());

  useEffect(() => {
    // A unique suffix per mount, not just per itemId — belt-and-braces
    // alongside the stable client above, so two overlapping channel joins
    // (dev-mode double-invoke) are never mistaken for the same topic.
    const channelName = `messages:${itemId}:${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `booking_request_item_id=eq.${itemId}` },
        (payload) => {
          const row = payload.new as {
            id: string;
            booking_request_item_id: string;
            sender_id: string;
            body: string;
            created_at: string;
            read_at: string | null;
          };
          setMessages((prev) =>
            prev.some((m) => m.id === row.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: row.id,
                    bookingRequestItemId: row.booking_request_item_id,
                    senderId: row.sender_id,
                    body: row.body,
                    createdAt: row.created_at,
                    readAt: row.read_at,
                  },
                ],
          );
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [itemId, supabase]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  // Marking read is idempotent and RLS-scoped (see markMessagesRead) — safe
  // to call whenever an unread incoming message is visible in this thread,
  // but ONLY when it's actually visible: the floating chat window keeps this
  // component mounted while minimized, and a hidden thread must never
  // silently consume the very unread state it's meant to surface.
  useEffect(() => {
    if (visible && messages.some((m) => m.senderId !== currentUserId && !m.readAt)) {
      markMessagesRead(itemId);
    }
  }, [messages, itemId, currentUserId, visible]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    const result = await sendMessage(itemId, body);
    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message]));
    setDraft("");
  }

  const pane = appearance === "pane";

  return (
    <div className={`flex h-full min-h-0 flex-col ${pane ? "gap-0" : "gap-3"}`}>
      <div
        ref={listRef}
        className={
          pane
            ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-5 sm:px-6"
            : "flex min-h-[220px] flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-ivory-300 bg-ivory-100 p-3"
        }
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-navy-400">No messages yet.</p>
        ) : (
          messages.map((message) => {
            const mine = message.senderId === currentUserId;
            const bubble = pane
              ? mine
                ? "rounded-br-md bg-sky-600 text-ivory-50"
                : "rounded-bl-md border border-ivory-300 bg-ivory-50 text-navy-900"
              : mine
                ? "bg-navy-900 text-ivory-50"
                : "border border-ivory-300 bg-ivory-50 text-navy-900";
            return (
              <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl text-sm ${pane ? "px-4 py-2.5 sm:max-w-[70%]" : "px-3 py-2"} ${bubble}`}
                >
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <p className={`mt-1 text-[11px] ${mine ? (pane ? "text-sky-100" : "text-ivory-200") : "text-navy-300"}`}>
                    {formatTimestamp(message.createdAt)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {canSend ? (
        <div className={`flex flex-col gap-1.5 ${pane ? "border-t border-ivory-300 bg-ivory-50 px-4 py-3 sm:px-6" : ""}`}>
          {openCaption ? <p className="text-xs text-navy-400">{openCaption}</p> : null}
          <div className={`flex gap-2 ${pane ? "items-end" : ""}`}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, MESSAGE_MAX_LENGTH))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              rows={pane ? 1 : 2}
              placeholder="Write a message…"
              className={
                pane
                  ? "max-h-40 min-h-11 flex-1 resize-none rounded-3xl border border-ivory-300 bg-ivory-100 px-4 py-2.5 text-sm text-navy-900 placeholder:text-navy-300 focus:border-sky-300 focus:outline-none"
                  : "flex-1 resize-none rounded-xl border border-ivory-400 bg-ivory-50 px-3 py-2 text-sm text-navy-900 placeholder:text-navy-300"
              }
            />
            <Button type="button" onClick={handleSend} disabled={sending || draft.trim().length === 0}>
              Send
            </Button>
          </div>
          <div className="flex items-center justify-between">
            {error ? <p className="text-xs font-medium text-gold-700">{error}</p> : <span />}
            <span className="text-xs text-navy-300">
              {draft.length}/{MESSAGE_MAX_LENGTH}
            </span>
          </div>
        </div>
      ) : (
        <p
          className={`bg-ivory-100 px-3 py-2 text-center text-sm text-navy-400 ${pane ? "border-t border-ivory-300 py-4" : "rounded-lg"}`}
        >
          {closedLabel ?? "This conversation is closed."}
        </p>
      )}
    </div>
  );
}
