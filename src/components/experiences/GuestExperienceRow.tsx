import Link from "next/link";
import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
} from "@/lib/matching/booking-status";
import type { GuestExperienceItem } from "@/lib/matching/guest-experiences";
import { getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";

/**
 * Stage 3 (Phase 4/5 of the consolidated improvements): one booking card,
 * shared by the per-stay overview (/stays/[stayId], via ExperienceStatusGroups)
 * and the cross-stay My Experiences page (/experiences). Reuses exactly the
 * existing booking data GuestExperienceItem already carries — no parallel
 * summary model. The whole card opens the booking's own detail page
 * (/experiences/[itemId]); cancellation stays a separate, clearly distinct
 * control beneath it, never nested inside the link.
 */
export function GuestExperienceRow({ item, showStay = true }: { item: GuestExperienceItem; showStay?: boolean }) {
  return (
    <Card className="flex flex-col gap-2">
      <Link href={`/experiences/${item.id}`} className="flex gap-3 rounded-xl">
        <FallbackImage
          src={item.experienceImageUrl}
          alt={item.experienceTitle}
          className="h-16 w-16 shrink-0 rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 truncate font-display text-lg text-navy-950">{item.experienceTitle}</p>
            <Badge tone={getItemStatusTone(item.status)} className="shrink-0">
              {getItemStatusLabel(item.status)}
            </Badge>
          </div>
          <p className="text-sm text-navy-600">
            {item.providerDisplayName}
            {showStay ? ` · ${item.stayPropertyName}` : ""}
          </p>
          <p className="text-sm text-navy-600">
            {formatDayLabel(item.plannedDate)} · {getBookingTimeLabel(item.plannedMoment, item.preferredTime)} ·{" "}
            {item.guestCount} guest{item.guestCount === 1 ? "" : "s"} ·{" "}
            {formatCurrency(item.pricePerPerson * item.guestCount, item.currency)}
          </p>
        </div>
      </Link>
      {item.status === "DECLINED" && item.declineReason ? (
        <p className="text-sm text-navy-500">Reason: {getDeclineReasonLabel(item.declineReason)}</p>
      ) : null}
      {item.status === "CANCELLED" ? (
        <p className="text-sm text-navy-500">
          Cancelled by {item.cancelledBy === "provider" ? "the host" : "you"}
          {item.cancellationReason ? ` · Reason: ${getCancelReasonLabel(item.cancellationReason)}` : ""}
          {item.cancellationNote ? ` · "${item.cancellationNote}"` : ""}
        </p>
      ) : null}
      <div className="flex items-center gap-4">
        <Link href={`/experiences/${item.id}`} className="text-sm font-medium text-sky-600 hover:text-sky-700">
          View details →
        </Link>
        {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} stayId={item.stayId} /> : null}
      </div>
    </Card>
  );
}
