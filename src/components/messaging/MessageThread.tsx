"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { markMessagesRead, sendMessage } from "@/lib/messaging/actions";
import { MESSAGE_MAX_LENGTH, type Message } from "@/lib/messaging/messages";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadMessages } from "./ThreadMessages";

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
      <ThreadMessages
        messages={messages.map((message) => ({
          id: message.id,
          body: message.body,
          createdAt: message.createdAt,
          mine: message.senderId === currentUserId,
        }))}
        appearance={appearance}
      />

      {canSend ? (
        <ThreadComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          sending={sending}
          error={error}
          caption={openCaption}
          maxLength={MESSAGE_MAX_LENGTH}
          appearance={appearance}
        />
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
