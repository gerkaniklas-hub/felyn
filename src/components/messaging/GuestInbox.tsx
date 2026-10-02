"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeftIcon, ChatIcon, SearchIcon } from "@/components/navigation/icons";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { getItemStatusLabel, getItemStatusTone } from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getMessagesAction } from "@/lib/messaging/actions";
import type { ConversationSummary } from "@/lib/messaging/conversations";
import type { Message } from "@/lib/messaging/messages";
import { toHandle } from "./ConversationList";
import { MessageThread } from "./MessageThread";
import { useMessaging } from "./MessagingProvider";
import { ParticipantLink } from "./ParticipantLink";

function formatListTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * The guest Messages page as a two-pane inbox: the conversation list on the
 * left, the selected conversation on the right (on phones: the list, then
 * the conversation full width with a back button).
 *
 * Presentation only. Conversations come from the page's existing
 * getGuestConversations; a selected thread is loaded with the same
 * getMessagesAction the floating chat window uses, and rendered by the
 * one shared MessageThread, which keeps its own realtime, send and
 * mark-as-read behaviour. The thread is only mounted once a conversation is
 * chosen, so nothing is marked read without the guest opening it.
 *
 * `initialItemId` keeps the existing `?item=` deep link (used by the
 * floating window's "expand" control) working: it opens that conversation
 * here instead of in the floating window.
 */
export function GuestInbox({
  conversations,
  initialItemId,
}: {
  conversations: ConversationSummary[];
  initialItemId?: string;
}) {
  const { currentUserId, conversation: floatingConversation, close: closeFloating } = useMessaging();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialItemId && conversations.some((c) => c.itemId === initialItemId) ? initialItemId : null,
  );
  const [query, setQuery] = useState("");
  // Conversations opened in this visit: their unread badge is hidden right
  // away, since MessageThread marks the messages read as soon as it shows them.
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set(selectedId ? [selectedId] : []));

  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedItemId, setLoadedItemId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getMessagesAction(selectedId).then((rows) => {
      if (!cancelled) {
        setMessages(rows);
        setLoadedItemId(selectedId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function select(itemId: string) {
    if (itemId === selectedId) return;
    // Always load the thread fresh, so reopening a conversation never shows stale messages.
    setLoadedItemId(null);
    setSelectedId(itemId);
    setOpenedIds((prev) => new Set(prev).add(itemId));
    // Never show the same conversation twice (pane + floating window).
    if (floatingConversation?.itemId === itemId) closeFloating();
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter(
        (c) =>
          c.otherParticipant.label.toLowerCase().includes(q) ||
          c.experienceTitle.toLowerCase().includes(q) ||
          c.stayName.toLowerCase().includes(q),
      )
    : conversations;

  const selected = selectedId ? (conversations.find((c) => c.itemId === selectedId) ?? null) : null;
  const handle = selected ? toHandle(selected) : null;

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] min-h-[26rem] overflow-hidden border-ivory-300 bg-ivory-50 md:h-[calc(100dvh-3rem)] md:rounded-3xl md:border md:shadow-sm">
      {/* Conversation list */}
      <div
        className={`${selected ? "hidden md:flex" : "flex"} w-full min-w-0 flex-col border-ivory-300 md:w-72 md:shrink-0 md:border-r lg:w-96`}
      >
        <div className="flex flex-col gap-4 px-4 pt-5 pb-3 sm:px-5">
          <h1 className="font-display text-3xl font-medium tracking-tight text-navy-950">Messages</h1>
          <label className="relative block">
            <span className="sr-only">Search conversations</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-navy-300" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations"
              className="h-10 w-full rounded-full border border-ivory-300 bg-ivory-100 pr-3 pl-10 text-sm text-navy-900 placeholder:text-navy-300 focus:border-sky-300 focus:outline-none"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-navy-500">
              No conversations yet. Message a host from one of your bookings to start one.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-navy-500">No conversations match “{query.trim()}”.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((c) => {
                const active = c.itemId === selectedId;
                const unread = openedIds.has(c.itemId) ? 0 : c.unreadCount;
                const isMuted = c.itemStatus === "DECLINED" || c.itemStatus === "WITHDRAWN" || c.itemStatus === "CANCELLED";
                return (
                  <li key={c.itemId}>
                    <button
                      type="button"
                      onClick={() => select(c.itemId)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${
                        active ? "bg-sky-50" : "hover:bg-ivory-200"
                      }`}
                    >
                      <FallbackImage
                        src={c.otherParticipant.imageUrl}
                        alt={c.otherParticipant.label}
                        className="h-11 w-11 shrink-0 rounded-full"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-2">
                          <span
                            className={`min-w-0 flex-1 truncate text-sm ${
                              unread > 0 ? "font-semibold text-navy-950" : "font-medium text-navy-900"
                            }`}
                          >
                            {c.otherParticipant.label}
                          </span>
                          {c.lastMessage ? (
                            <span className="shrink-0 text-xs text-navy-300">
                              {formatListTimestamp(c.lastMessage.createdAt)}
                            </span>
                          ) : null}
                        </span>
                        <span className={`truncate text-xs ${isMuted ? "text-navy-300" : "text-sky-700"}`}>
                          {c.experienceTitle}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span
                            className={`min-w-0 flex-1 truncate text-sm ${
                              unread > 0 ? "font-medium text-navy-800" : "text-navy-500"
                            }`}
                          >
                            {c.lastMessage
                              ? `${c.lastMessage.isMine ? "You: " : ""}${c.lastMessage.body}`
                              : "No messages yet"}
                          </span>
                          {unread > 0 ? (
                            <span
                              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gold-500 px-1.5 text-[11px] font-semibold text-ivory-50"
                              aria-label={`${unread} unread`}
                            >
                              {unread > 9 ? "9+" : unread}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Selected conversation */}
      <div className={`${selected ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col bg-ivory-100/60`}>
        {selected && handle ? (
          <>
            <div className="flex items-center gap-3 border-b border-ivory-300 bg-ivory-50 px-3 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  setLoadedItemId(null);
                }}
                aria-label="Back to conversations"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-navy-700 hover:bg-ivory-200 md:hidden"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 flex-col">
                <ParticipantLink
                  label={selected.otherParticipant.label}
                  imageUrl={selected.otherParticipant.imageUrl}
                  providerId={selected.otherParticipant.providerId}
                  className="min-w-0 text-sm font-semibold text-navy-950"
                />
                <p className="mt-0.5 truncate pl-11 text-xs text-navy-500">
                  {selected.experienceTitle} · {formatDayLabel(selected.plannedDate)} ·{" "}
                  {getPlannedMomentLabel(selected.plannedMoment)}
                </p>
              </div>
              <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
                <Badge tone={getItemStatusTone(selected.itemStatus)} className="text-[10px]">
                  {getItemStatusLabel(selected.itemStatus)}
                </Badge>
                <Link href={selected.bookingHref} className="text-xs font-medium text-sky-600 hover:text-sky-700">
                  View booking →
                </Link>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              {loadedItemId !== selected.itemId || !currentUserId ? (
                <p className="py-10 text-center text-sm text-navy-300">Loading conversation…</p>
              ) : (
                <MessageThread
                  key={selected.itemId}
                  itemId={selected.itemId}
                  currentUserId={currentUserId}
                  initialMessages={messages}
                  canSend={handle.canSend}
                  closedLabel={handle.closedLabel}
                  openCaption={handle.openCaption}
                  appearance="pane"
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-600">
              <ChatIcon className="h-7 w-7" />
            </span>
            <p className="font-display text-xl text-navy-950">Your conversations</p>
            <p className="max-w-xs text-sm text-navy-500">
              Choose a conversation to read it and reply to your host.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
