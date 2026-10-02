import Link from "next/link";
import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ExperienceGallery } from "@/components/planner/ExperienceGallery";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
} from "@/lib/matching/booking-status";
import { getGuestExperienceDetail } from "@/lib/matching/guest-experiences";
import { getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
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
 */
export default async function GuestExperienceDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const supabase = await createSupabaseServerClient();
  const item = await getGuestExperienceDetail(supabase, itemId);

  if (!item) {
    return (
      <div className="flex flex-1 flex-col">
        <GuestNav notifications={<NotificationBell />} />
        <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
          <Card className="mx-auto max-w-md text-center">
            <Heading level={2}>Booking not found</Heading>
            <p className="mt-2 text-navy-500">This booking doesn&apos;t exist, or isn&apos;t yours to view.</p>
            <Link href="/trips" className="mt-3 inline-block text-sm font-medium text-sky-600 hover:text-sky-700">
              ← Back to trips
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  const timeLabel = getBookingTimeLabel(item.plannedMoment, item.preferredTime);
  const total = item.pricePerPerson * item.guestCount;

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <Link href="/trips" className="text-sm font-medium text-sky-600 hover:text-sky-700">
          ← Back to trips
        </Link>

        <div className="mt-4 flex flex-col gap-6">
          <ExperienceGallery images={item.experience?.gallery ?? []} title={item.experienceTitle} />

          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Heading level={1}>{item.experienceTitle}</Heading>
              <Badge tone={getItemStatusTone(item.status)}>{getItemStatusLabel(item.status)}</Badge>
            </div>
            <p className="mt-1 text-navy-600">
              Hosted by {item.providerDisplayName}
              {item.experience ? ` · ${humanizeCategory(item.experience.category)}` : ""}
            </p>
          </div>

          <Card>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs font-medium tracking-wide text-navy-300">DATE</p>
                <p className="mt-1 text-navy-900">{formatDayLabel(item.plannedDate)}</p>
              </div>
              <div>
                <p className="text-xs font-medium tracking-wide text-navy-300">TIME</p>
                <p className="mt-1 text-navy-900">{timeLabel}</p>
              </div>
              <div>
                <p className="text-xs font-medium tracking-wide text-navy-300">GUESTS</p>
                <p className="mt-1 text-navy-900">{item.guestCount}</p>
              </div>
              <div>
                <p className="text-xs font-medium tracking-wide text-navy-300">
                  {item.status === "CONFIRMED" ? "TOTAL" : "ESTIMATED TOTAL"}
                </p>
                <p className="mt-1 text-navy-900">{formatCurrency(total, item.currency)}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-navy-400">{item.stayPropertyName}</p>
          </Card>

          {item.experience?.description || item.experience?.shortDescription ? (
            <p className="text-navy-700">{item.experience.description ?? item.experience.shortDescription}</p>
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

          {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} stayId={item.stayId} /> : null}
        </div>
      </div>
    </div>
  );
}
