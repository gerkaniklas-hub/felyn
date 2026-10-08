import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { PageHeader, textLinkClass } from "@/components/ui/page";
import { ProviderBookingCard } from "@/components/provider/ProviderBookingCard";
import { RequestItemActions } from "@/components/provider/RequestItemActions";
import { MessageLauncherButton } from "@/components/messaging/MessageLauncherButton";
import { GetHelpButton } from "@/components/support/GetHelpButton";
import {
  getMessagingClosedLabel,
  getMessagingOpenCaption,
  getMessagingWindowState,
} from "@/lib/matching/booking-status";
import { getBookingStartTime, getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getUnreadMessageCount } from "@/lib/messaging/messages";
import { getProviderIdentity, getProviderRequestItems } from "@/lib/provider/dashboard";
import { getOpenSupportThreadId } from "@/lib/support/queries";
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
 *
 * "Get help" contacts the Felyn Team about this booking as the HOST (host-side
 * support; the booking is attached automatically); `?help=1` opens it straight
 * away ("Contact Felyn again").
 */
export default async function ProviderRequestItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ help?: string }>;
}) {
  const { itemId } = await params;
  const { help } = await searchParams;
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
        <Link href="/provider/requests" className={`mt-3 inline-block ${textLinkClass}`}>
          ← Back to requests
        </Link>
      </Card>
    );
  }

  const [unreadCount, openSupportThreadId] = await Promise.all([
    getUnreadMessageCount(supabase, item.itemId),
    getOpenSupportThreadId(supabase, "host", item.itemId),
  ]);
  const messagingWindow = getMessagingWindowState(item.status, item.decidedAt, item.cancelledAt);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Link href="/provider/requests" className={`self-start ${textLinkClass}`}>
        ← Back to requests
      </Link>
      <PageHeader eyebrow="Request" title={item.experienceTitle} />
      <Card className="flex flex-col gap-5">
        <ProviderBookingCard item={item} linkable={false} bare />
        <p className="text-sm text-navy-400">Requested {formatDayLabel(item.requestedAt.slice(0, 10))}</p>
        <div className="border-t border-ivory-300 pt-5">
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

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="flex flex-col justify-between gap-4">
          <div>
            <Heading level={3} as="h2">
              Conversation
            </Heading>
            <p className="mt-1 text-sm text-navy-500">Message the guest about this booking.</p>
          </div>
          <MessageLauncherButton
            label={`Message ${item.guestFirstName ?? "guest"}`}
            unreadCount={unreadCount}
            className={buttonClasses({ className: "self-start" })}
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

        <Card className="flex flex-col gap-3">
          <div>
            <Heading level={3} as="h2">
              Need help?
            </Heading>
            <p className="mt-1 text-sm text-navy-500">Questions or a problem with this booking? The Felyn Team is here to help.</p>
          </div>
          <GetHelpButton
            bookingItemId={item.itemId}
            booking={{
              experienceTitle: item.experienceTitle,
              dateLabel: formatDayLabel(item.plannedDate),
              timeLabel: getBookingTimeLabel(item.plannedMoment, getBookingStartTime(item)),
              guestCount: item.guestCount,
            }}
            existingThreadId={openSupportThreadId}
            initialOpen={help === "1"}
            requesterRole="host"
          />
        </Card>
      </div>
    </div>
  );
}
