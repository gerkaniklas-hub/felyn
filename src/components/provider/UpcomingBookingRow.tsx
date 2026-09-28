import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDayLabel } from "@/lib/matching/timeline";

/**
 * One row of the dashboard's "Upcoming" list — now an actual link to the
 * booking's detail page (task 4: these were previously visible but
 * unopenable). Deliberately lighter than `ProviderBookingCard` — a scan
 * list, not a full card — but every row is the same clickable, keyboard-
 * reachable detail link the rest of the app uses.
 */
export function UpcomingBookingRow({
  itemId,
  plannedDate,
  experienceTitle,
  guestCount,
}: {
  itemId: string;
  plannedDate: string;
  experienceTitle: string;
  guestCount: number;
}) {
  return (
    <Link
      href={`/provider/requests/${itemId}`}
      className="flex items-center justify-between gap-3 rounded-xl py-3 first:pt-0 last:pb-0 transition-colors hover:bg-ivory-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-navy-300">{formatDayLabel(plannedDate)}</p>
        <p className="truncate text-navy-950">{experienceTitle}</p>
        <p className="text-sm text-navy-500">
          {guestCount} guest{guestCount === 1 ? "" : "s"}
        </p>
      </div>
      <Badge tone="sky" className="shrink-0">
        Confirmed
      </Badge>
    </Link>
  );
}
