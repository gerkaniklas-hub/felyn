"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SUPPORT_TEAM_NAME, type SupportCategory, type SupportRequesterRole } from "@/lib/support/constants";
import { getSupportStatusNote, getSupportSubtitle } from "@/lib/support/inbox";
import type { SupportThreadState } from "@/lib/support/queries";
import { FelynTeamAvatar } from "./FelynTeamAvatar";
import { SupportThread } from "./SupportThread";

/**
 * One Felyn Team conversation shown as a panel on a page (the host Messages page,
 * `?support=`) rather than in the floating chat window. A header — Felyn Team, the
 * topic, a status word kept live from the thread, and a link to the booking — above
 * the shared SupportThread for the given side.
 */
export function SupportConversationPanel({
  thread,
  category,
  experienceTitle,
  requesterRole,
  backHref,
  bookingHref,
}: {
  thread: SupportThreadState;
  category: SupportCategory;
  experienceTitle: string | null;
  requesterRole: SupportRequesterRole;
  backHref: string;
  bookingHref: string | null;
}) {
  const [status, setStatus] = useState(thread.status);
  const statusNote = getSupportStatusNote(status);

  return (
    <div className="flex flex-col gap-3">
      <Link href={backHref} className="text-sm font-medium text-sky-600 hover:text-sky-700">
        ← All conversations
      </Link>
      <section className="flex h-[calc(100dvh-14rem)] min-h-[26rem] flex-col overflow-hidden rounded-panel border border-ivory-300 bg-ivory-100/60 shadow-card">
        <div className="flex items-center gap-3 border-b border-ivory-300 bg-ivory-50 px-4 py-3 sm:px-5">
          <FelynTeamAvatar className="h-9 w-9 text-base" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-sm font-semibold text-navy-950">{SUPPORT_TEAM_NAME}</p>
            <p className="mt-0.5 truncate text-xs text-navy-500">
              {getSupportSubtitle({ category, bookingItemId: thread.bookingItemId, experienceTitle })}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {statusNote ? (
              <Badge tone="navy" className="text-[10px]">
                {statusNote}
              </Badge>
            ) : null}
            {bookingHref ? (
              <Link href={bookingHref} className="text-xs font-medium text-sky-600 hover:text-sky-700">
                View booking →
              </Link>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <SupportThread
            key={thread.threadId}
            threadId={thread.threadId}
            bookingItemId={thread.bookingItemId}
            initialMessages={thread.messages}
            initialStatus={thread.status}
            requesterRole={requesterRole}
            onStatusChange={setStatus}
          />
        </div>
      </section>
    </div>
  );
}
