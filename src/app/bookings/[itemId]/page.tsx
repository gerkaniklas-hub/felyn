import Link from "next/link";
import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { WithdrawRequestButton } from "@/components/booking/WithdrawRequestButton";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { GetHelpButton } from "@/components/support/GetHelpButton";
import { ExperienceGallery } from "@/components/planner/ExperienceGallery";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Eyebrow, PageContainer, textLinkClass } from "@/components/ui/page";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
  NO_TRIP_LINKED_LABEL,
} from "@/lib/matching/booking-status";
import { getGuestExperienceDetail } from "@/lib/matching/guest-experiences";
import { getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getOpenGuestSupportThreadId } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function humanizeCategory(category: string): string {
  return category.replace(/_/g, " & ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Phase 4/5 of the consolidated improvements: one booking's full detail —
 * the actual associated experience (title, host, description, photos)
 * alongside this specific booking's own date/time/guests/price/status.
 * getGuestExperienceDetail is RLS-scoped to the caller's own
 * booking_request_items (0005) — an itemId for someone else's booking
 * simply resolves to "not found" here, never leaking another guest's data.
 * Reuses the same ExperienceGallery/lightbox the catalogue detail view
 * uses (Phase 7.2) rather than a second photo component.
 *
 * "Get help" contacts the Felyn Team about this booking (the booking is attached
 * automatically); `?help=1` opens it straight away ("Contact Felyn again").
 */
export default async function GuestExperienceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ help?: string }>;
}) {
  const { itemId } = await params;
  const { help } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const item = await getGuestExperienceDetail(supabase, itemId);

  if (!item) {
    return (
      <div className="flex flex-1 flex-col">
        <GuestNav notifications={<NotificationBell />} />
        <PageContainer measure="reading">
          <Card className="max-w-md">
            <Heading level={2}>Booking not found</Heading>
            <p className="mt-2 text-navy-500">This booking doesn&apos;t exist, or isn&apos;t yours to view.</p>
            <Link href="/experiences" className={`mt-4 inline-block ${textLinkClass}`}>
              ← Back to your experiences
            </Link>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const timeLabel = getBookingTimeLabel(item.plannedMoment, item.preferredTime);
  const total = item.pricePerPerson * item.guestCount;
  const openSupportThreadId = await getOpenGuestSupportThreadId(supabase, item.id);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <PageContainer measure="reading">
        <Link href="/experiences" className={`self-start ${textLinkClass}`}>
          ← Back to your experiences
        </Link>

        <div className="mt-6 flex flex-col gap-8">
          {/* A container, so the photo frame widens with the reading column like it does in the detail panel. */}
          <div className="@container">
            <ExperienceGallery images={item.experience?.gallery ?? []} title={item.experienceTitle} />
          </div>

          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Heading level={1}>{item.experienceTitle}</Heading>
              <Badge tone={getItemStatusTone(item.status)} className="mt-2">
                {getItemStatusLabel(item.status)}
              </Badge>
            </div>
            <p className="mt-3 text-[15px] text-navy-600">
              Hosted by {item.providerDisplayName}
              {item.experience ? ` · ${humanizeCategory(item.experience.category)}` : ""}
            </p>
          </div>

          <Card>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <div>
                <Eyebrow>Date</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{formatDayLabel(item.plannedDate)}</p>
              </div>
              <div>
                <Eyebrow>Time</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{timeLabel}</p>
              </div>
              <div>
                <Eyebrow>Guests</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{item.guestCount}</p>
              </div>
              <div>
                <Eyebrow>{item.status === "CONFIRMED" ? "Total" : "Estimated total"}</Eyebrow>
                <p className="mt-1.5 text-[15px] font-medium text-navy-900">{formatCurrency(total, item.currency)}</p>
              </div>
            </div>
            <p className="mt-5 border-t border-ivory-300 pt-4 text-sm text-navy-500">
              {item.stayPropertyName ?? NO_TRIP_LINKED_LABEL}
            </p>
          </Card>

          {item.experience?.description || item.experience?.shortDescription ? (
            <p className="text-base leading-relaxed text-navy-700">
              {item.experience.description ?? item.experience.shortDescription}
            </p>
          ) : !item.experience ? (
            <p className="text-sm text-navy-400">
              This experience&apos;s full details are no longer available, but your booking record is preserved above.
            </p>
          ) : null}

          {item.hostNote ? (
            <p className="text-sm text-navy-600">
              <span className="font-medium text-navy-800">Your note to the host:</span> {item.hostNote}
            </p>
          ) : null}

          {item.status === "DECLINED" && item.declineReason ? (
            <p className="text-sm text-navy-500">Declined: {getDeclineReasonLabel(item.declineReason)}</p>
          ) : null}
          {item.status === "CANCELLED" ? (
            <p className="text-sm text-navy-500">
              Cancelled by {item.cancelledBy === "provider" ? "the host" : "you"}
              {item.cancellationReason ? ` · Reason: ${getCancelReasonLabel(item.cancellationReason)}` : ""}
              {item.cancellationNote ? ` · "${item.cancellationNote}"` : ""}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-ivory-300 pt-5">
            <p className="text-sm text-navy-600">Questions or a problem with this booking? The Felyn Team is here to help.</p>
            <GetHelpButton
              bookingItemId={item.id}
              booking={{
                experienceTitle: item.experienceTitle,
                dateLabel: formatDayLabel(item.plannedDate),
                timeLabel,
                guestCount: item.guestCount,
              }}
              existingThreadId={openSupportThreadId}
              initialOpen={help === "1"}
            />
          </div>

          {item.status === "REQUESTED" ? <WithdrawRequestButton itemId={item.id} /> : null}
          {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} stayId={item.stayId ?? undefined} /> : null}
        </div>
      </PageContainer>
    </div>
  );
}
