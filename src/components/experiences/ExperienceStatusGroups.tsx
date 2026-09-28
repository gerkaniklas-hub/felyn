import type { BookingItemStatus } from "@/lib/matching/booking-status";
import type { GuestExperienceItem } from "@/lib/matching/guest-experiences";
import { GuestExperienceRow } from "./GuestExperienceRow";

/**
 * Milestone 1: the same "group a guest's requested experiences by status"
 * rendering used by the per-stay overview (/stays/[stayId], one stay only).
 * The cross-stay overview (/experiences) now uses its own Upcoming/Past
 * tabs (GuestExperienceTabs) instead — see that component for why a single
 * status-bucketed list stopped being the right shape once bookings could
 * span many stays over time.
 */
const BUCKETS: { status: BookingItemStatus; heading: string }[] = [
  { status: "CONFIRMED", heading: "Confirmed" },
  { status: "REQUESTED", heading: "Awaiting confirmation" },
  { status: "CANCELLED", heading: "Cancelled" },
  { status: "DECLINED", heading: "Declined" },
  { status: "WITHDRAWN", heading: "Withdrawn" },
];

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
                <GuestExperienceRow key={item.id} item={item} showStay={showStay} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
