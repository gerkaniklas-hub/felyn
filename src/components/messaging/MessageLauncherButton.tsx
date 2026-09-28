"use client";

import { useMessaging, type ConversationHandle } from "./MessagingProvider";

/**
 * The one "Message X" trigger, used everywhere a booking card offers to
 * start/continue a conversation (guest plan cards, provider booking
 * detail). Opens the shared floating chat window (task 2/4) instead of a
 * centered modal or an embedded panel — never a second messaging
 * implementation.
 */
export function MessageLauncherButton({
  handle,
  label,
  unreadCount = 0,
  className,
}: {
  handle: ConversationHandle;
  label: string;
  unreadCount?: number;
  className?: string;
}) {
  const { openConversation } = useMessaging();
  return (
    <button
      type="button"
      onClick={() => openConversation(handle)}
      className={
        className ?? "mt-1 flex w-fit items-center gap-1.5 text-sm font-medium text-sky-600 hover:text-sky-700"
      }
    >
      {label}
      {unreadCount > 0 ? (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gold-500 px-1 text-[10px] font-semibold text-ivory-50">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}
