import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
  type BookingItemStatus,
} from "@/lib/matching/booking-status";
import type { GuestExperienceItem } from "@/lib/matching/guest-experiences";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";

/**
 * Milestone 1: the same "group a guest's requested experiences by status"
 * rendering used by both /experiences (across every stay) and the
 * per-stay overview (/stays/[stayId], one stay only) — factored out so
 * neither page reimplements the bucket order or row layout.
 *
 * Booking-lifecycle milestone: also the guest's ONE cancellation entry
 * point (CancelExperienceButton, shown only for a CONFIRMED item) —
 * deliberately not duplicated into the planner's RequestedItemCard.
 */
const BUCKETS: { status: BookingItemStatus; heading: string }[] = [
  { status: "CONFIRMED", heading: "Confirmed" },
  { status: "REQUESTED", heading: "Awaiting confirmation" },
  { status: "CANCELLED", heading: "Cancelled" },
  { status: "DECLINED", heading: "Declined" },
  { status: "WITHDRAWN", heading: "Withdrawn" },
];

function ExperienceRow({ item, showStay }: { item: GuestExperienceItem; showStay: boolean }) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg text-navy-950">{item.experienceTitle}</p>
          <p className="text-sm text-navy-600">
            {item.providerDisplayName}
            {showStay ? ` · ${item.stayPropertyName}` : ""}
          </p>
        </div>
        <Badge tone={getItemStatusTone(item.status)}>{getItemStatusLabel(item.status)}</Badge>
      </div>
      <p className="text-sm text-navy-600">
        {formatDayLabel(item.plannedDate)} · {getPlannedMomentLabel(item.plannedMoment)} · {item.guestCount} guest
        {item.guestCount === 1 ? "" : "s"} · {formatCurrency(item.pricePerPerson * item.guestCount, item.currency)}
      </p>
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
      {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} /> : null}
    </Card>
  );
}

export function ExperienceStatusGroups({
  items,
  showStay = true,
}: {
  items: GuestExperienceItem[];
  /** Off on the per-stay overview, where the stay is already the page's own context. */
  showStay?: boolean;
}) {
  const byStatus = new Map<BookingItemStatus, GuestExperienceItem[]>();
  for (const item of items) {
    const list = byStatus.get(item.status) ?? [];
    list.push(item);
    byStatus.set(item.status, list);
  }

  return (
    <div className="flex flex-col gap-8">
      {BUCKETS.map(({ status, heading }) => {
        const bucketItems = byStatus.get(status);
        if (!bucketItems || bucketItems.length === 0) return null;
        return (
          <div key={status} className="flex flex-col gap-3">
            <p className="text-xs font-medium tracking-wide text-navy-300 uppercase">
              {heading} ({bucketItems.length})
            </p>
            <div className="flex flex-col gap-3">
              {bucketItems.map((item) => (
                <ExperienceRow key={item.id} item={item} showStay={showStay} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
