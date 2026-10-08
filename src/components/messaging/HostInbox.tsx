"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { SupportThread } from "@/components/support/SupportThread";
import { Badge } from "@/components/ui/badge";
import { getItemStatusLabel, getItemStatusTone } from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getMessagesAction } from "@/lib/messaging/actions";
import type { ConversationSummary } from "@/lib/messaging/conversations";
import type { Message } from "@/lib/messaging/messages";
import { getHostSupportThreadAction } from "@/lib/support/host-actions";
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
  InitialsAvatar,
  previewText,
} from "./inbox-ui";
import { MessageThread } from "./MessageThread";
import { useMessaging } from "./MessagingProvider";

/** The guest's photo when there is one; otherwise their initial — never the Felyn placeholder tile, which would make a guest look like Felyn. */
function GuestAvatar({
  participant,
  className,
}: {
  participant: { label: string; imageUrl: string | null };
  className: string;
}) {
  return participant.imageUrl ? (
    <FallbackImage src={participant.imageUrl} alt={participant.label} className={`${className} shrink-0 rounded-full`} />
  ) : (
    <InitialsAvatar name={participant.label} className={className} />
  );
}

/**
 * The host Messages page as a two-pane inbox — the same look as the guest inbox
 * (shared inbox-ui pieces), seen from the host's side. The host's own data only:
 *
 * - Guest conversations come from the page's getProviderConversations; a selected
 *   thread loads through the same getMessagesAction the floating chat window
 *   already uses for hosts (access is enforced by the database), and renders in the
 *   shared MessageThread with its own realtime, send and mark-as-read behaviour.
 * - Felyn Team rows are the host's HOST-side support threads only
 *   (getSupportConversations(…, "host") on the page); a selected one loads through
 *   the host action getHostSupportThreadAction and renders SupportThread with
 *   requesterRole="host" — never the guest support actions.
 *
 * `initialItemId` (?item=) opens that guest conversation here, `initialSupportId`
 * (?support=) that Felyn Team conversation; an id that isn't in the host's own
 * lists opens nothing.
 */
export function HostInbox({
  conversations,
  initialItemId,
  supportConversations,
  initialSupportId,
}: {
  conversations: ConversationSummary[];
  initialItemId?: string;
  supportConversations: SupportConversationSummary[];
  initialSupportId?: string;
}) {
  const { currentUserId, conversation: floatingConversation, close: closeFloating } = useMessaging();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialItemId && conversations.some((c) => c.itemId === initialItemId) ? initialItemId : null,
  );
  const [query, setQuery] = useState("");
  // Opened in this visit: MessageThread marks them read as soon as it shows them.
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set(selectedId ? [selectedId] : []));
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedItemId, setLoadedItemId] = useState<string | null>(null);

  // Felyn Team selection — never set at the same time as selectedId.
  const [selectedSupportId, setSelectedSupportId] = useState<string | null>(
    !selectedId && initialSupportId && supportConversations.some((s) => s.threadId === initialSupportId)
      ? initialSupportId
      : null,
  );
  // A ?item= / ?support= link to a conversation that isn't this host's (or no longer exists).
  const [linkUnavailable, setLinkUnavailable] = useState(
    (Boolean(initialItemId) && !selectedId && !initialSupportId) ||
      (Boolean(initialSupportId) && !selectedId && !supportConversations.some((s) => s.threadId === initialSupportId)),
  );
  const [openedSupportIds, setOpenedSupportIds] = useState<Set<string>>(
    () => new Set(selectedSupportId ? [selectedSupportId] : []),
  );
  const [supportThread, setSupportThread] = useState<SupportThreadState | null>(null);
  const [loadedSupportId, setLoadedSupportId] = useState<string | null>(null);
  const [supportStatuses, setSupportStatuses] = useState<Record<string, SupportStatus>>({});

  useEffect(() => {
    if (!selectedSupportId) return;
    let cancelled = false;
    getHostSupportThreadAction(selectedSupportId).then((state) => {
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

  // Opening a conversation here closes the same one in the floating window, so it never shows twice.
  useEffect(() => {
    if (selectedId && floatingConversation?.itemId === selectedId) closeFloating();
    // Only when the selection changes, not on every floating-window update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function select(itemId: string) {
    if (itemId === selectedId) return;
    setLoadedItemId(null);
    setSelectedId(itemId);
    setOpenedIds((prev) => new Set(prev).add(itemId));
    setSelectedSupportId(null);
    setLoadedSupportId(null);
    setLinkUnavailable(false);
  }

  function selectSupport(threadId: string) {
    if (threadId === selectedSupportId) return;
    setLoadedSupportId(null);
    setSelectedSupportId(threadId);
    setOpenedSupportIds((prev) => new Set(prev).add(threadId));
    setSelectedId(null);
    setLoadedItemId(null);
    setLinkUnavailable(false);
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
  const filteredSupport = supportConversations.filter((s) => matchesSupportQuery(s, query));
  const rows = mergeByRecency(
    filtered,
    (c) => c.lastMessage?.createdAt ?? "",
    filteredSupport,
    (s) => s.lastMessage?.createdAt ?? s.lastMessageAt,
  );

  const selected = selectedId ? (conversations.find((c) => c.itemId === selectedId) ?? null) : null;
  const handle = selected ? toHandle(selected) : null;
  const selectedSupport = selectedSupportId
    ? (supportConversations.find((s) => s.threadId === selectedSupportId) ?? null)
    : null;
  const supportStatusOf = (s: SupportConversationSummary) => supportStatuses[s.threadId] ?? s.status;

  return (
    // Inside the host canvas: bleeds to the canvas edges on phones (like the guest
    // inbox under its top bar), and leaves room for the canvas frame from md up.
    <div className="-mx-4 -my-8 sm:-mx-6 md:m-0">
      <InboxFrame
        anySelected={Boolean(selected || selectedSupport)}
        // The host phone top bar is 110px (6.875rem), 2px taller than the guest one the default assumes.
        height="h-[calc(100dvh-6.875rem)] min-h-[26rem]"
        mdHeight="md:h-[min(calc(100dvh-7rem),46rem)]"
        listHeader={<InboxListHeader query={query} onQueryChange={setQuery} />}
        list={
          <>
            {conversations.length === 0 && supportConversations.length === 0 ? (
              <InboxListNotice>No conversations yet. Message a guest from one of your requests to start one.</InboxListNotice>
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
                      avatar={<GuestAvatar participant={c.otherParticipant} className="h-12 w-12 text-lg" />}
                      name={c.otherParticipant.label}
                      timestamp={c.lastMessage ? formatListTimestamp(c.lastMessage.createdAt) : null}
                      subtitle={c.itemStatus === "WITHDRAWN" ? `Withdrawn request · ${c.experienceTitle}` : c.experienceTitle}
                      subtitleMuted={c.itemStatus === "DECLINED" || c.itemStatus === "CANCELLED" || c.itemStatus === "WITHDRAWN"}
                      preview={previewText(c.lastMessage)}
                      unread={openedIds.has(c.itemId) ? 0 : c.unreadCount}
                    />
                  );
                })}
              </ul>
            )}
            {supportConversations.length === 0 ? (
              <p className="px-3 pt-4 pb-2 text-center text-sm text-navy-500">
                Need help from Felyn?{" "}
                <Link href="/provider/help" className="font-medium text-sky-600 hover:text-sky-700">
                  Contact the Felyn Team
                </Link>
              </p>
            ) : null}
          </>
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
                    {/* A withdrawn request has no request page any more (it's kept out of Requests); only this history remains. */}
                    {selected.itemStatus === "WITHDRAWN" ? null : (
                      <Link href={selected.bookingHref} className="text-xs font-medium text-sky-600 hover:text-sky-700">
                        View request →
                      </Link>
                    )}
                  </>
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <GuestAvatar participant={selected.otherParticipant} className="h-9 w-9 text-base" />
                  <div className="flex min-w-0 flex-col">
                    <p className="truncate text-sm font-semibold text-navy-950">{selected.otherParticipant.label}</p>
                    <p className="mt-0.5 truncate text-xs text-navy-500">
                      {selected.experienceTitle} · {formatDayLabel(selected.plannedDate)} ·{" "}
                      {getPlannedMomentLabel(selected.plannedMoment)}
                    </p>
                  </div>
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
                    closedLabel={
                      selected.itemStatus === "WITHDRAWN"
                        ? "The guest withdrew this request. This conversation is read-only."
                        : handle.closedLabel
                    }
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
                        href={`/provider/requests/${selectedSupport.bookingItemId}`}
                        className="text-xs font-medium text-sky-600 hover:text-sky-700"
                      >
                        View request →
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
                    requesterRole="host"
                    onStatusChange={(status) =>
                      setSupportStatuses((prev) => ({ ...prev, [supportThread.threadId]: status }))
                    }
                  />
                )}
              </InboxPaneBody>
            </>
          ) : (
            <InboxEmptyPane
              text="Choose a conversation to read it and reply to your guest."
              notice={linkUnavailable ? <>That conversation isn&apos;t available.</> : null}
            />
          )
        }
      />
    </div>
  );
}
