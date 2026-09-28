import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { ProviderBookingCard } from "@/components/provider/ProviderBookingCard";
import { RequestItemActions } from "@/components/provider/RequestItemActions";
import { MessageLauncherButton } from "@/components/messaging/MessageLauncherButton";
import {
  getMessagingClosedLabel,
  getMessagingOpenCaption,
  getMessagingWindowState,
} from "@/lib/matching/booking-status";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getUnreadMessageCount } from "@/lib/messaging/messages";
import { getProviderIdentity, getProviderRequestItems } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * P1.1: the "proper request detail interaction" — Confirm/Decline live
 * here (via RequestItemActions), scoped to this ONE item. The item is
 * looked up through getProviderRequestItems, which is already scoped to
 * the signed-in provider's own experiences — an itemId for someone else's
 * experience simply isn't in that list, so it renders "Request not found"
 * rather than leaking another provider's data.
 *
 * This is also THE single booking-detail view — the dashboard, Requests
 * page and Calendar all link here rather than rendering their own copy of
 * this information (task 4). The summary itself reuses `ProviderBookingCard`
 * (`linkable={false}`, since this page already IS the destination and the
 * card must not wrap the real Confirm/Decline controls in an anchor).
 */
export default async function ProviderRequestItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const identity = user ? await getProviderIdentity(supabase, user.id) : null;

  if (!identity) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-navy-700">This account isn&apos;t linked to a Felyn provider profile yet.</p>
      </Card>
    );
  }

  const items = await getProviderRequestItems(supabase, identity.id);
  const item = items.find((row) => row.itemId === itemId);

  if (!item) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-navy-700">This request doesn&apos;t exist, or it isn&apos;t one of your own experiences.</p>
        <Link
          href="/provider/requests"
          className="mt-3 inline-block text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          ← Back to requests
        </Link>
      </Card>
    );
  }

  const unreadCount = await getUnreadMessageCount(supabase, item.itemId);
  const messagingWindow = getMessagingWindowState(item.status, item.decidedAt, item.cancelledAt);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <Link href="/provider/requests" className="text-sm font-medium text-sky-600 hover:text-sky-700">
        ← Back to requests
      </Link>
      <Card className="flex flex-col gap-4">
        <ProviderBookingCard item={item} linkable={false} bare />
        <p className="text-sm text-navy-400">Requested {formatDayLabel(item.requestedAt.slice(0, 10))}</p>
        <div className="border-t border-ivory-300 pt-4">
          <RequestItemActions
            itemId={item.itemId}
            status={item.status}
            declineReason={item.declineReason}
            declineNote={item.declineNote}
            cancelledBy={item.cancelledBy}
            cancellationReason={item.cancellationReason}
            cancellationNote={item.cancellationNote}
            experienceTitle={item.experienceTitle}
            guestCount={item.guestCount}
            stayName={item.stayName}
          />
        </div>
      </Card>

      <Card className="flex items-center justify-between gap-3">
        <div>
          <Heading level={3}>Conversation</Heading>
          <p className="mt-1 text-sm text-navy-500">Message the guest about this booking.</p>
        </div>
        <MessageLauncherButton
          label={`Message ${item.guestFirstName ?? "guest"}`}
          unreadCount={unreadCount}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-navy-900 px-5 text-sm font-medium text-ivory-50 hover:bg-navy-950"
          handle={{
            itemId: item.itemId,
            otherParticipant: { label: item.guestFirstName ?? "Guest", imageUrl: null, providerId: null },
            experienceTitle: item.experienceTitle,
            experienceImageUrl: item.experienceImageUrl,
            bookingHref: `/provider/requests/${item.itemId}`,
            canSend: messagingWindow.canSend,
            // A provider never sees a WITHDRAWN item at all (see
            // getProviderRequestItems) — DECLINED and CANCELLED are the
            // only closed statuses reachable here, each with its own
            // 30-day reply window (Stage 2c-B) rather than closing
            // immediately.
            closedLabel: getMessagingClosedLabel(item.status, messagingWindow),
            openCaption: getMessagingOpenCaption(messagingWindow),
          }}
        />
      </Card>
    </div>
  );
}
