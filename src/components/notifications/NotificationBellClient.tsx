"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { markAllNotificationsRead, markNotificationRead } from "@/app/notifications/actions";
import { getNotificationHref, type Notification } from "@/lib/notifications";

type MarkAllState = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };

/**
 * P1.1: a lightweight notification popover, not a notification centre —
 * unread indicator, a short list, and mark-as-read (one or all). The
 * underlying `notifications` table (0009) is deliberately shaped so a
 * later milestone can add mobile push without changing this data model:
 * the same rows just also fan out to a push provider.
 *
 * Phase 7 of the consolidated improvements: clicking a notification now
 * actually navigates somewhere (getNotificationHref — booking decisions to
 * the guest's own booking detail page, messages to the inbox's existing
 * `?item=` auto-open) instead of only toggling its read state. "Mark all
 * as read" now surfaces a real pending/error state instead of silently
 * assuming the server update succeeded.
 */
export function NotificationBellClient({
  notifications,
  unreadCount,
}: {
  notifications: Notification[];
  unreadCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [markAllState, setMarkAllState] = useState<MarkAllState>({ status: "idle" });

  async function handleMarkAll() {
    setMarkAllState({ status: "pending" });
    const result = await markAllNotificationsRead();
    if (!result.ok) {
      setMarkAllState({ status: "error", message: result.error });
      return;
    }
    setMarkAllState({ status: "idle" });
    router.refresh();
  }

  async function handleNotificationClick(notification: Notification) {
    if (!notification.readAt) {
      await markNotificationRead(notification.id);
    }
    const href = getNotificationHref(notification.type, notification.bookingRequestItemId);
    setOpen(false);
    if (href) {
      router.push(href);
    } else {
      router.refresh();
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-navy-700 hover:bg-ivory-200"
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold-500 px-1 text-[10px] font-semibold text-ivory-50">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-2xl border border-ivory-300 bg-ivory-50 p-3 shadow-xl">
            <div className="flex items-center justify-between px-1 pb-2">
              <p className="text-xs font-medium tracking-wide text-navy-300">NOTIFICATIONS</p>
              {unreadCount > 0 ? (
                <button
                  type="button"
                  disabled={markAllState.status === "pending"}
                  onClick={handleMarkAll}
                  className="text-xs font-medium text-sky-600 hover:text-sky-700 disabled:opacity-40"
                >
                  {markAllState.status === "pending" ? "Marking…" : "Mark all as read"}
                </button>
              ) : null}
            </div>
            {markAllState.status === "error" ? (
              <p className="px-1 pb-2 text-xs text-red-600">{markAllState.message}</p>
            ) : null}
            {notifications.length === 0 ? (
              <p className="px-1 py-3 text-sm text-navy-500">No notifications yet</p>
            ) : (
              <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                {notifications.map((notification) => (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => handleNotificationClick(notification)}
                    className={`rounded-xl px-3 py-2 text-left transition-colors ${
                      notification.readAt ? "bg-transparent" : "bg-sky-50 hover:bg-sky-100"
                    }`}
                  >
                    <p className="text-sm font-medium text-navy-950">{notification.title}</p>
                    <p className="text-sm text-navy-600">{notification.body}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
