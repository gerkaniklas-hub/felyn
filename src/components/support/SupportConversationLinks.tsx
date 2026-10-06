import Link from "next/link";
import { formatActivityTime } from "@/lib/support/admin-format";
import { SUPPORT_TEAM_NAME, type SupportRequesterRole } from "@/lib/support/constants";
import { getSupportConversationHref, getSupportStatusNote, getSupportSubtitle } from "@/lib/support/inbox";
import type { SupportConversationSummary } from "@/lib/support/queries";
import { FelynTeamAvatar } from "./FelynTeamAvatar";

/**
 * Felyn Team conversations as a simple list of links (the host Messages page). Each
 * row opens that conversation's panel (`?support=`); nothing here fetches or writes.
 * Styled like the host's guest-conversation list beneath it.
 */
export function SupportConversationLinks({
  conversations,
  requesterRole,
}: {
  conversations: SupportConversationSummary[];
  requesterRole: SupportRequesterRole;
}) {
  return (
    <ul className="flex flex-col divide-y divide-ivory-300 overflow-hidden rounded-card border border-ivory-300 bg-ivory-50">
      {conversations.map((c) => {
        const unread = c.unreadCount > 0;
        const statusNote = getSupportStatusNote(c.status);
        return (
          <li key={c.threadId}>
            <Link
              href={getSupportConversationHref(c.threadId, requesterRole)}
              className="flex items-center gap-3 p-3 transition-colors hover:bg-ivory-100 sm:p-4"
            >
              <FelynTeamAvatar className="h-10 w-10" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold text-navy-950" : "font-medium text-navy-900"}`}>
                    {SUPPORT_TEAM_NAME}
                  </span>
                  {c.lastMessage ? (
                    <span className="shrink-0 text-xs text-navy-300">{formatActivityTime(c.lastMessage.createdAt)}</span>
                  ) : null}
                </span>
                <span className={`truncate text-xs ${c.status === "CLOSED" ? "text-navy-300" : "text-sky-700"}`}>
                  {getSupportSubtitle(c)}
                  {statusNote ? ` · ${statusNote}` : ""}
                </span>
                <span className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-medium text-navy-800" : "text-navy-500"}`}>
                    {c.lastMessage ? `${c.lastMessage.isMine ? "You: " : ""}${c.lastMessage.body}` : "No messages yet"}
                  </span>
                  {unread ? (
                    <span
                      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gold-500 px-1.5 text-[11px] font-semibold text-ivory-50"
                      aria-label={`${c.unreadCount} unread`}
                    >
                      {c.unreadCount > 9 ? "9+" : c.unreadCount}
                    </span>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
