"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { getItemStatusLabel, getItemStatusTone } from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getMessagesAction } from "@/lib/messaging/actions";
import type { ConversationSummary } from "@/lib/messaging/conversations";
import type { Message } from "@/lib/messaging/messages";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { SupportThread } from "@/components/support/SupportThread";
import { getGuestSupportThreadAction } from "@/lib/support/actions";
import { SUPPORT_TEAM_NAME, type SupportStatus } from "@/lib/support/constants";
import { getSupportStatusNote, getSupportSubtitle, matchesSupportQuery, mergeByRecency } from "@/lib/support/inbox";
import type { SupportConversationSummary, SupportThreadState } from "@/lib/support/queries";
import { toHandle } from "./ConversationList";
import {
  formatListTimestamp,
  InboxEmptyPane,
  InboxFrame,
  InboxListHeader,
  InboxListNotice,
  InboxPaneBody,
  InboxPaneHeader,
  InboxPaneLoading,
  InboxRow,
  previewText,
} from "./inbox-ui";
import { MessageThread } from "./MessageThread";
import { useMessaging } from "./MessagingProvider";
import { ParticipantLink } from "./ParticipantLink";

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
 *
 * Felyn Team conversations (support, 0029) are a second kind of row in the same
 * list, merged by most recent activity. They keep their own selection state so the
 * booking selection/loading below is untouched; `initialSupportId` (?support=)
 * opens one, and it renders SupportThread instead of MessageThread. Only the
 * guest's own guest-side threads ever reach this component (see
 * getGuestSupportConversations), so an id that isn't in that list — e.g. someone
 * else's — opens nothing.
 */
export function GuestInbox({
  conversations,
  initialItemId,
  supportConversations = [],
  initialSupportId,
}: {
  conversations: ConversationSummary[];
  initialItemId?: string;
  supportConversations?: SupportConversationSummary[];
  initialSupportId?: string;
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

  // Felyn Team (support) selection — never set at the same time as selectedId.
  const [selectedSupportId, setSelectedSupportId] = useState<string | null>(
    !selectedId && initialSupportId && supportConversations.some((s) => s.threadId === initialSupportId)
      ? initialSupportId
      : null,
  );
  // A ?support= link to a conversation that isn't this guest's (or no longer exists).
  const [supportLinkUnavailable, setSupportLinkUnavailable] = useState(
    Boolean(initialSupportId) && !initialItemId && !supportConversations.some((s) => s.threadId === initialSupportId),
  );
  const [openedSupportIds, setOpenedSupportIds] = useState<Set<string>>(
    () => new Set(selectedSupportId ? [selectedSupportId] : []),
  );
  const [supportThread, setSupportThread] = useState<SupportThreadState | null>(null);
  const [loadedSupportId, setLoadedSupportId] = useState<string | null>(null);
  // Latest known status per thread (fresher than the server-rendered list once a thread is opened or replied to).
  const [supportStatuses, setSupportStatuses] = useState<Record<string, SupportStatus>>({});

  useEffect(() => {
    if (!selectedSupportId) return;
    let cancelled = false;
    getGuestSupportThreadAction(selectedSupportId).then((state) => {
      if (cancelled) return;
      setSupportThread(state);
      setLoadedSupportId(selectedSupportId);
      if (state) setSupportStatuses((prev) => ({ ...prev, [state.threadId]: state.status }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSupportId]);

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
    setSelectedSupportId(null);
    setLoadedSupportId(null);
    setSupportLinkUnavailable(false);
    // Never show the same conversation twice (pane + floating window).
    if (floatingConversation?.itemId === itemId) closeFloating();
  }

  function selectSupport(threadId: string) {
    if (threadId === selectedSupportId) return;
    setLoadedSupportId(null);
    setSelectedSupportId(threadId);
    setOpenedSupportIds((prev) => new Set(prev).add(threadId));
    setSelectedId(null);
    setLoadedItemId(null);
    setSupportLinkUnavailable(false);
  }

  function clearSelection() {
    setSelectedId(null);
    setLoadedItemId(null);
    setSelectedSupportId(null);
    setLoadedSupportId(null);
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

  const filteredSupport = supportConversations.filter((s) => matchesSupportQuery(s, query));
  const rows = mergeByRecency(
    filtered,
    (c) => c.lastMessage?.createdAt ?? "",
    filteredSupport,
    (s) => s.lastMessage?.createdAt ?? s.lastMessageAt,
  );
  const selectedSupport = selectedSupportId
    ? (supportConversations.find((s) => s.threadId === selectedSupportId) ?? null)
    : null;
  const supportStatusOf = (s: SupportConversationSummary) => supportStatuses[s.threadId] ?? s.status;
  const anySelected = Boolean(selected || selectedSupport);

  return (
    <InboxFrame
      anySelected={anySelected}
      listHeader={<InboxListHeader query={query} onQueryChange={setQuery} />}
      list={
        conversations.length === 0 && supportConversations.length === 0 ? (
          <InboxListNotice>No conversations yet. Message a host from one of your bookings to start one.</InboxListNotice>
        ) : rows.length === 0 ? (
          <InboxListNotice>No conversations match “{query.trim()}”.</InboxListNotice>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => {
              if (row.kind === "support") {
                const s = row.value;
                const status = supportStatusOf(s);
                const statusNote = getSupportStatusNote(status);
                return (
                  <InboxRow
                    key={`support:${s.threadId}`}
                    active={s.threadId === selectedSupportId}
                    onSelect={() => selectSupport(s.threadId)}
                    avatar={<FelynTeamAvatar className="h-12 w-12 shrink-0" />}
                    name={SUPPORT_TEAM_NAME}
                    timestamp={s.lastMessage ? formatListTimestamp(s.lastMessage.createdAt) : null}
                    subtitle={
                      <>
                        {getSupportSubtitle(s)}
                        {statusNote ? ` · ${statusNote}` : ""}
                      </>
                    }
                    subtitleMuted={status === "CLOSED"}
                    preview={previewText(s.lastMessage)}
                    unread={openedSupportIds.has(s.threadId) ? 0 : s.unreadCount}
                  />
                );
              }
              const c = row.value;
              return (
                <InboxRow
                  key={c.itemId}
                  active={c.itemId === selectedId}
                  onSelect={() => select(c.itemId)}
                  avatar={
                    <FallbackImage
                      src={c.otherParticipant.imageUrl}
                      alt={c.otherParticipant.label}
                      className="h-12 w-12 shrink-0 rounded-full"
                    />
                  }
                  name={c.otherParticipant.label}
                  timestamp={c.lastMessage ? formatListTimestamp(c.lastMessage.createdAt) : null}
                  subtitle={c.experienceTitle}
                  subtitleMuted={c.itemStatus === "DECLINED" || c.itemStatus === "WITHDRAWN" || c.itemStatus === "CANCELLED"}
                  preview={previewText(c.lastMessage)}
                  unread={openedIds.has(c.itemId) ? 0 : c.unreadCount}
                />
              );
            })}
          </ul>
        )
      }
      pane={
        selected && handle ? (
          <>
            <InboxPaneHeader
              onBack={clearSelection}
              aside={
                <>
                  <Badge tone={getItemStatusTone(selected.itemStatus)} className="text-[10px]">
                    {getItemStatusLabel(selected.itemStatus)}
                  </Badge>
                  <Link href={selected.bookingHref} className="text-xs font-medium text-sky-600 hover:text-sky-700">
                    View booking →
                  </Link>
                </>
              }
            >
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
            </InboxPaneHeader>

            <InboxPaneBody>
              {loadedItemId !== selected.itemId || !currentUserId ? (
                <InboxPaneLoading />
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
            </InboxPaneBody>
          </>
        ) : selectedSupport ? (
          <>
            <InboxPaneHeader
              onBack={clearSelection}
              aside={
                <>
                  {getSupportStatusNote(supportStatusOf(selectedSupport)) ? (
                    <Badge tone="navy" className="text-[10px]">
                      {getSupportStatusNote(supportStatusOf(selectedSupport))}
                    </Badge>
                  ) : null}
                  {selectedSupport.bookingItemId ? (
                    <Link
                      href={`/bookings/${selectedSupport.bookingItemId}`}
                      className="text-xs font-medium text-sky-600 hover:text-sky-700"
                    >
                      View booking →
                    </Link>
                  ) : null}
                </>
              }
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <FelynTeamAvatar className="h-9 w-9 text-base" />
                <div className="flex min-w-0 flex-col">
                  <p className="truncate text-sm font-semibold text-navy-950">{SUPPORT_TEAM_NAME}</p>
                  <p className="mt-0.5 truncate text-xs text-navy-500">{getSupportSubtitle(selectedSupport)}</p>
                </div>
              </div>
            </InboxPaneHeader>

            <InboxPaneBody>
              {loadedSupportId !== selectedSupport.threadId ? (
                <InboxPaneLoading />
              ) : !supportThread ? (
                <p className="px-6 py-10 text-center text-sm text-navy-500">
                  We couldn&apos;t load this conversation. Please try again in a moment.
                </p>
              ) : (
                <SupportThread
                  key={supportThread.threadId}
                  threadId={supportThread.threadId}
                  bookingItemId={supportThread.bookingItemId}
                  initialMessages={supportThread.messages}
                  initialStatus={supportThread.status}
                  onStatusChange={(status) =>
                    setSupportStatuses((prev) => ({ ...prev, [supportThread.threadId]: status }))
                  }
                />
              )}
            </InboxPaneBody>
          </>
        ) : (
          <InboxEmptyPane
            text="Choose a conversation to read it and reply to your host."
            notice={supportLinkUnavailable ? <>That conversation isn&apos;t available.</> : null}
          />
        )
      }
    />
  );
}
