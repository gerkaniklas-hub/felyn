"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import {
  formatActivityTime,
  getCustomerDisplayName,
  getCustomerShortName,
  getRequesterRoleLabel,
} from "@/lib/support/admin-format";
import type { StaffTicketPage } from "@/lib/support/admin-queries";
import { SUPPORT_STATUS_LABELS, SUPPORT_STATUSES, SUPPORT_TEAM_NAME, type SupportStatus } from "@/lib/support/constants";
import { getSupportSubtitle } from "@/lib/support/inbox";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { StaffStatusBadge } from "./StaffStatusBadge";

const REFRESH_DELAY_MS = 400;

/**
 * The Felyn Support inbox: Open / Resolved / Closed tabs and the tickets in the
 * selected status, most recent activity first. Rows come from the server
 * (support_staff_list_threads); this component keeps no copy of them.
 *
 * Live: any change to support_threads (new ticket, status change, last activity)
 * or support_messages (new message, read state) triggers a short-debounced
 * router.refresh() of this page only — so a ticket that gets a new message moves to
 * the top, one that is resolved leaves the Open tab, and the counts stay right,
 * always exactly as the database says. Two separate channels; if either fails, a
 * "live updates paused" notice offers a manual refresh.
 */
export function StaffTicketList({
  status,
  counts,
  page,
  olderHref,
  isOlderPage,
}: {
  status: SupportStatus;
  counts: Record<SupportStatus, number | null>;
  page: StaffTicketPage | null;
  olderHref: string | null;
  isOlderPage: boolean;
}) {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [threadsProblem, setThreadsProblem] = useState(false);
  const [messagesProblem, setMessagesProblem] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function scheduleRefresh() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), REFRESH_DELAY_MS);
    }
    const suffix = Math.random().toString(36).slice(2);
    const threads = supabase
      .channel(`staff_support_threads:${suffix}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "support_threads" }, scheduleRefresh)
      .subscribe((state) => {
        if (state === "SUBSCRIBED") setThreadsProblem(false);
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setThreadsProblem(true);
      });
    const messages = supabase
      .channel(`staff_support_messages:${suffix}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "support_messages" }, scheduleRefresh)
      .subscribe((state) => {
        if (state === "SUBSCRIBED") setMessagesProblem(false);
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setMessagesProblem(true);
      });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(threads);
      supabase.removeChannel(messages);
    };
  }, [router, supabase]);

  const rows = page?.rows ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-medium tracking-tight text-navy-950">Felyn Support</h1>
          <p className="mt-1 text-sm text-navy-500">Conversations with guests. Your replies appear as {SUPPORT_TEAM_NAME}.</p>
        </div>
        <nav aria-label="Status" className="flex gap-1 rounded-full border border-ivory-300 bg-ivory-50 p-1">
          {SUPPORT_STATUSES.map((s) => {
            const active = s === status;
            const n = counts[s];
            return (
              <Link
                key={s}
                href={`/admin/support?status=${s.toLowerCase()}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  active ? "bg-navy-900 text-ivory-50" : "text-navy-600 hover:bg-ivory-200"
                }`}
              >
                {SUPPORT_STATUS_LABELS[s]}
                {n !== null ? <span className={active ? "text-ivory-200" : "text-navy-300"}> ({n})</span> : null}
              </Link>
            );
          })}
        </nav>
      </div>

      {threadsProblem || messagesProblem ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-gold-100 px-4 py-2 text-sm text-gold-700">
          <span>Live updates are paused. New messages may not appear until you refresh.</span>
          <button type="button" onClick={() => router.refresh()} className="shrink-0 font-semibold hover:underline">
            Refresh
          </button>
        </div>
      ) : null}

      {!page ? (
        <p className="rounded-2xl border border-ivory-300 bg-ivory-50 px-5 py-10 text-center text-sm text-navy-500">
          We couldn&apos;t load conversations.{" "}
          <button type="button" onClick={() => router.refresh()} className="font-medium text-sky-600 hover:text-sky-700">
            Try again
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ivory-300 bg-ivory-50/60 px-5 py-10 text-center text-sm text-navy-500">
          No {SUPPORT_STATUS_LABELS[status].toLowerCase()} conversations{isOlderPage ? " further back" : ""}.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-ivory-300 overflow-hidden rounded-2xl border border-ivory-300 bg-ivory-50">
          {rows.map((row) => {
            const unread = row.unreadCount > 0;
            const shortName = getCustomerShortName(row.customer.firstName, row.requesterRole);
            return (
              <li key={row.threadId}>
                <Link
                  href={`/admin/support/${row.threadId}`}
                  className={`flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-ivory-100 sm:px-5 ${unread ? "bg-sky-50/50" : ""}`}
                >
                  <span className="relative shrink-0">
                    <FelynTeamAvatar className="h-10 w-10" />
                    {unread ? (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-ivory-50 bg-gold-500"
                        aria-label="New message"
                      />
                    ) : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span className={`min-w-0 truncate text-sm ${unread ? "font-semibold text-navy-950" : "font-medium text-navy-900"}`}>
                        {getCustomerDisplayName(row.customer)}
                      </span>
                      <span className="shrink-0 rounded-full bg-ivory-200 px-2 py-0.5 text-[10px] font-medium text-navy-600">
                        {getRequesterRoleLabel(row.requesterRole)}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-navy-300">{formatActivityTime(row.lastMessageAt)}</span>
                    </span>
                    <span className="truncate text-xs text-sky-700">
                      {getSupportSubtitle({ category: row.category, isBooking: row.isBooking, experienceTitle: row.experienceTitle })}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-medium text-navy-800" : "text-navy-500"}`}>
                        {row.lastMessage
                          ? `${row.lastMessage.fromCustomer ? shortName : SUPPORT_TEAM_NAME}: ${row.lastMessage.body}`
                          : "No messages yet"}
                      </span>
                      {unread ? (
                        <span
                          className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gold-500 px-1.5 text-[11px] font-semibold text-ivory-50"
                          aria-label={`${row.unreadCount} unread`}
                        >
                          {row.unreadCount > 9 ? "9+" : row.unreadCount}
                        </span>
                      ) : null}
                      <StaffStatusBadge status={row.status} className="shrink-0" />
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {isOlderPage || olderHref ? (
        <div className="flex justify-center gap-4 text-sm">
          {isOlderPage ? (
            <Link href={`/admin/support?status=${status.toLowerCase()}`} className="font-medium text-sky-600 hover:text-sky-700">
              ← Newest
            </Link>
          ) : null}
          {olderHref ? (
            <Link href={olderHref} className="font-medium text-sky-600 hover:text-sky-700">
              Show older →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
