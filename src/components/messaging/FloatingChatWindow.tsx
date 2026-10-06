"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMessagesAction } from "@/lib/messaging/actions";
import type { Message } from "@/lib/messaging/messages";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { MessageThread } from "./MessageThread";
import { ParticipantLink } from "./ParticipantLink";
import { useMessaging } from "./MessagingProvider";

/**
 * The single floating chat window (task 2) — mounted once by
 * MessagingProvider, always in the DOM once a conversation is open or
 * minimized, so MessageThread itself never unmounts between those two
 * states (that's what keeps its draft text and realtime subscription
 * alive across minimize/reopen — see MessageThread's own notes on
 * `visible`). Only closing (conversation set to null) tears it down.
 *
 * On mobile this becomes a full-screen sheet rather than a small corner
 * box (task 3) — same component, responsive classes only.
 */
export function FloatingChatWindow() {
  const { conversation, panelState, currentUserId, minimize, reopen, close } = useMessaging();
  const router = useRouter();

  const [messages, setMessages] = useState<Message[]>([]);
  // Which item's messages `messages` currently holds — lets `loading` be
  // derived (itemId !== loadedItemId) instead of a second piece of state
  // set synchronously at the top of the effect below.
  const [loadedItemId, setLoadedItemId] = useState<string | null>(null);

  const itemId = conversation?.itemId ?? null;

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    getMessagesAction(itemId).then((rows) => {
      if (!cancelled) {
        setMessages(rows);
        setLoadedItemId(itemId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (!conversation || !currentUserId) return null;

  const loading = itemId !== loadedItemId;

  const unreadWhileHidden = messages.some((m) => m.senderId !== currentUserId && !m.readAt);
  const isProviderView = conversation.bookingHref.startsWith("/provider/");
  const messagesHref = isProviderView ? "/provider/messages" : "/messages";

  function handleExpand() {
    router.push(`${messagesHref}?item=${itemId}`);
    close();
  }

  return (
    <div className="fixed inset-0 z-[95] sm:inset-auto sm:right-6 sm:bottom-6 sm:w-[23rem]">
      {/* Minimized launcher — hidden (not unmounted) rather than swapped out, so the panel below keeps MessageThread alive underneath it. */}
      <button
        type="button"
        onClick={reopen}
        className={`${
          panelState === "minimized" ? "flex" : "hidden"
        } w-full items-center gap-3 rounded-full border border-ivory-300 bg-ivory-50 px-4 py-3 shadow-lg transition-colors hover:border-sky-300 sm:w-auto`}
      >
        <FallbackImage
          src={conversation.otherParticipant.imageUrl}
          alt={conversation.otherParticipant.label}
          className="h-9 w-9 shrink-0 rounded-full"
        />
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-navy-900 sm:max-w-[10rem]">
          {conversation.otherParticipant.label}
        </span>
        {unreadWhileHidden ? (
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-gold-500" aria-label="Unread messages" />
        ) : null}
      </button>

      <div
        className={`${
          panelState === "open" ? "flex" : "hidden"
        } h-full flex-col overflow-hidden border-ivory-300 bg-ivory-50 shadow-xl sm:h-[32rem] sm:rounded-card sm:border`}
      >
        <div className="flex items-center gap-3 border-b border-ivory-300 bg-ivory-100 px-4 py-3">
          <div className="min-w-0 flex-1">
            <ParticipantLink
              label={conversation.otherParticipant.label}
              imageUrl={conversation.otherParticipant.imageUrl}
              providerId={conversation.otherParticipant.providerId}
              className="font-display text-base"
            />
            <Link href={conversation.bookingHref} className="block truncate text-xs text-navy-500 hover:text-sky-600">
              {conversation.experienceTitle}
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleExpand}
              aria-label="Expand to Messages"
              title="Expand to Messages"
              className="flex h-8 w-8 items-center justify-center rounded-full text-navy-500 hover:bg-ivory-200"
            >
              ⤢
            </button>
            <button
              type="button"
              onClick={minimize}
              aria-label="Minimize conversation"
              title="Minimize"
              className="flex h-8 w-8 items-center justify-center rounded-full text-navy-500 hover:bg-ivory-200"
            >
              –
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close conversation"
              title="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-navy-500 hover:bg-ivory-200"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          {loading ? (
            <p className="py-6 text-center text-sm text-navy-400">Loading…</p>
          ) : (
            <MessageThread
              key={itemId}
              itemId={itemId!}
              currentUserId={currentUserId}
              initialMessages={messages}
              canSend={conversation.canSend}
              closedLabel={conversation.closedLabel}
              openCaption={conversation.openCaption}
              visible={panelState === "open"}
              onMessagesChange={setMessages}
            />
          )}
        </div>
      </div>
    </div>
  );
}
