"use client";

import type { ReactNode } from "react";
import { ArrowLeftIcon, ChatIcon, SearchIcon } from "@/components/navigation/icons";

/**
 * The Messages inbox's look, shared by the guest inbox (GuestInbox) and the host
 * inbox (HostInbox). Presentation only: every piece takes plain props and
 * callbacks. Nothing here loads conversations, sends messages, marks anything
 * read or knows whether the viewer is a guest or a host — each inbox keeps its
 * own data, server actions and access rules.
 */

export function formatListTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A row's preview line: the last message ("You: …" when it was the viewer's), or a placeholder. */
export function previewText(lastMessage: { body: string; isMine: boolean } | null): string {
  return lastMessage ? `${lastMessage.isMine ? "You: " : ""}${lastMessage.body}` : "No messages yet";
}

/**
 * Two panes: the conversation list and the selected conversation. On phones only
 * one shows at a time (`anySelected` switches to the conversation). The heights
 * default to the guest inbox's full-viewport frame; a page that sits it inside
 * other chrome passes its own.
 */
export function InboxFrame({
  anySelected,
  listHeader,
  list,
  pane,
  height = "h-[calc(100dvh-6.75rem)] min-h-[26rem]",
  mdHeight = "md:h-[min(calc(100dvh-4rem),46rem)]",
}: {
  anySelected: boolean;
  listHeader: ReactNode;
  list: ReactNode;
  pane: ReactNode;
  height?: string;
  mdHeight?: string;
}) {
  return (
    <div
      className={`flex ${height} overflow-hidden border-ivory-300 bg-ivory-50 ${mdHeight} md:rounded-panel md:border md:shadow-card`}
    >
      {/* Conversation list */}
      <div
        className={`${anySelected ? "hidden md:flex" : "flex"} w-full min-w-0 flex-col border-ivory-300 md:w-72 md:shrink-0 md:border-r lg:w-96`}
      >
        {listHeader}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{list}</div>
      </div>

      {/* Selected conversation */}
      <div className={`${anySelected ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col bg-ivory-100/60`}>{pane}</div>
    </div>
  );
}

/** "Messages" and the conversation search above the list. */
export function InboxListHeader({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-4 sm:px-5">
      <h1 className="font-display text-[2rem] leading-tight font-medium tracking-tight text-navy-950">Messages</h1>
      <label className="relative block">
        <span className="sr-only">Search conversations</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-navy-400" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search conversations"
          className="h-11 w-full rounded-full border border-ivory-300 bg-ivory-100 pr-4 pl-11 text-sm text-navy-900 placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 focus:outline-none"
        />
      </label>
    </div>
  );
}

/** A quiet line in place of the list ("No conversations yet", "No conversations match …"). */
export function InboxListNotice({ children }: { children: ReactNode }) {
  return <p className="px-3 py-10 text-center text-sm text-navy-500">{children}</p>;
}

/** One conversation in the list: avatar, name + time, a subtitle, the preview and an unread count. */
export function InboxRow({
  active,
  onSelect,
  avatar,
  name,
  timestamp,
  subtitle,
  subtitleMuted,
  preview,
  unread,
}: {
  active: boolean;
  onSelect: () => void;
  avatar: ReactNode;
  name: ReactNode;
  /** Already formatted, or null when there is no message yet. */
  timestamp: string | null;
  subtitle: ReactNode;
  /** Greys the subtitle (a closed booking or support conversation). */
  subtitleMuted: boolean;
  preview: string;
  unread: number;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left transition-colors ${
          active ? "bg-sky-50 ring-1 ring-sky-100" : "hover:bg-ivory-100"
        }`}
      >
        {avatar}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-sm ${
                unread > 0 ? "font-semibold text-navy-950" : "font-medium text-navy-900"
              }`}
            >
              {name}
            </span>
            {timestamp ? <span className="shrink-0 text-xs text-navy-300">{timestamp}</span> : null}
          </span>
          <span className={`truncate text-xs ${subtitleMuted ? "text-navy-300" : "text-sky-700"}`}>{subtitle}</span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-sm ${unread > 0 ? "font-medium text-navy-800" : "text-navy-500"}`}
            >
              {preview}
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
}

/** The bar above an open conversation: back (phones), who/what it is, and status/links on the right. */
export function InboxPaneHeader({ onBack, children, aside }: { onBack: () => void; children: ReactNode; aside: ReactNode }) {
  return (
    <div className="flex min-h-18 items-center gap-3 border-b border-ivory-300 bg-ivory-50 px-3 py-3 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to conversations"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-navy-700 hover:bg-ivory-200 md:hidden"
      >
        <ArrowLeftIcon className="h-5 w-5" />
      </button>
      {children}
      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">{aside}</div>
    </div>
  );
}

/** The scrolling area under the pane header that holds the thread. */
export function InboxPaneBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1">{children}</div>;
}

export function InboxPaneLoading() {
  return <p className="py-10 text-center text-sm text-navy-300">Loading conversation…</p>;
}

/**
 * A neutral round avatar showing the first letter of a person's name — for
 * someone with no photo, so they never appear as the Felyn placeholder tile.
 * Pass the same size classes as the photo it stands in for.
 */
export function InitialsAvatar({ name, className = "" }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-ivory-300 bg-ivory-200 font-display font-medium text-navy-700 ${className}`}
    >
      {initial}
    </span>
  );
}

/** The pane before a conversation is chosen. */
export function InboxEmptyPane({ text, notice }: { text: string; notice?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-600">
        <ChatIcon className="h-7 w-7" />
      </span>
      <p className="font-display text-xl text-navy-950">Your conversations</p>
      <p className="max-w-xs text-sm text-navy-500">{text}</p>
      {notice ? (
        <p className="max-w-xs rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">{notice}</p>
      ) : null}
    </div>
  );
}
