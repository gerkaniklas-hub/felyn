"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  getItemStatusLabel,
  getItemStatusTone,
  getMessagingClosedLabel,
  getMessagingOpenCaption,
  getMessagingWindowState,
} from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import type { ConversationSummary } from "@/lib/messaging/conversations";
import type { ConversationHandle } from "./MessagingProvider";
import { useMessaging } from "./MessagingProvider";
import { ParticipantLink } from "./ParticipantLink";

function formatMessageTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function toHandle(c: ConversationSummary): ConversationHandle {
  const windowState = getMessagingWindowState(c.itemStatus, c.decidedAt, c.cancelledAt);
  return {
    itemId: c.itemId,
    otherParticipant: c.otherParticipant,
    experienceTitle: c.experienceTitle,
    experienceImageUrl: c.experienceImageUrl,
    bookingHref: c.bookingHref,
    canSend: windowState.canSend,
    closedLabel: getMessagingClosedLabel(c.itemStatus, windowState),
    openCaption: getMessagingOpenCaption(windowState),
  };
}

/**
 * The shared Messages inbox body (task 1), used by both the guest and
 * provider inbox pages — one implementation, fed a `ConversationSummary[]`
 * that each page's server component builds from the existing
 * `getGuestConversations`/`getProviderConversations` (which in turn reuse
 * the existing messages/booking data — no separate inbox backend).
 *
 * Every row exposes THREE separate, individually meaningful destinations
 * (task 7) rather than one ambiguous click target: the other participant's
 * name/avatar (→ their profile, where one exists), the booking status/date
 * (→ the existing booking page), and the message preview itself (→ opens
 * the conversation). The experience title is shown but never a link — no
 * experience detail route exists anywhere in this app (see the
 * implementation report), so it stays plain text rather than pointing at
 * something that doesn't exist.
 */
export function ConversationList({
  conversations,
  autoOpenItemId,
}: {
  conversations: ConversationSummary[];
  autoOpenItemId?: string;
}) {
  const { openConversation } = useMessaging();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!autoOpenItemId) return;
    const match = conversations.find((c) => c.itemId === autoOpenItemId);
    if (match) openConversation(toHandle(match));
    // Only ever auto-open once, when the inbox is first opened with ?item=.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenItemId]);

  if (conversations.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-ivory-300 bg-ivory-50/60 px-5 py-8 text-center text-navy-500">
        No conversations yet. Message a host or guest from a booking to start one.
      </p>
    );
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

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name or experience…"
        className="h-11 w-full max-w-sm rounded-full border border-ivory-400 bg-ivory-50 px-4 text-sm text-navy-900 placeholder:text-navy-300"
      />

      {filtered.length === 0 ? (
        <p className="text-sm text-navy-500">No conversations match “{query}”.</p>
      ) : (
        <div className="flex flex-col divide-y divide-ivory-300 overflow-hidden rounded-2xl border border-ivory-300 bg-ivory-50">
          {filtered.map((c) => {
            const isMuted = c.itemStatus === "DECLINED" || c.itemStatus === "WITHDRAWN" || c.itemStatus === "CANCELLED";
            return (
              <div key={c.itemId} className="flex items-center gap-3 p-3 sm:p-4">
                <ParticipantLink
                  label={c.otherParticipant.label}
                  imageUrl={c.otherParticipant.imageUrl}
                  providerId={c.otherParticipant.providerId}
                  className="shrink-0"
                />

                <button
                  type="button"
                  onClick={() => openConversation(toHandle(c))}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg py-1 text-left hover:bg-ivory-100"
                >
                  <span className={`truncate text-sm font-medium ${isMuted ? "text-navy-400" : "text-navy-900"}`}>
                    {c.experienceTitle}
                  </span>
                  {c.lastMessage ? (
                    <span className="flex w-full min-w-0 items-baseline gap-1.5">
                      <span
                        className={`line-clamp-1 min-w-0 flex-1 text-sm ${
                          c.unreadCount > 0 ? "font-medium text-navy-800" : "text-navy-500"
                        }`}
                      >
                        {c.lastMessage.isMine ? "You: " : ""}
                        {c.lastMessage.body}
                      </span>
                      <span className="shrink-0 text-xs text-navy-300">{formatMessageTimestamp(c.lastMessage.createdAt)}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-navy-300">No messages yet</span>
                  )}
                </button>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Link
                    href={c.bookingHref}
                    className="text-xs font-medium text-navy-500 hover:text-sky-600"
                    title="View booking"
                  >
                    {formatDayLabel(c.plannedDate)} · {getPlannedMomentLabel(c.plannedMoment)}
                  </Link>
                  <Badge tone={getItemStatusTone(c.itemStatus)} className="text-[10px]">
                    {getItemStatusLabel(c.itemStatus)}
                  </Badge>
                  {c.unreadCount > 0 ? (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gold-500 px-1 text-[10px] font-semibold text-ivory-50">
                      {c.unreadCount > 9 ? "9+" : c.unreadCount}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
