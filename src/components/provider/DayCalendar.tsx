import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { getItemStatusTone } from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { statusLabel, type CalendarEvent } from "./MonthCalendar";

const MOMENT_ORDER: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };

/**
 * Day view (task 5): every booking item on one date, sorted by the guest's
 * preferred time (or moment, when no time was given), each one clicking
 * through to the same booking detail page as everywhere else. Guest count,
 * time and status are all shown directly — status is never colour-only.
 */
export function DayCalendar({ events }: { events: CalendarEvent[] }) {
  const sorted = [...events].sort((a, b) => {
    const at = a.preferredTime ?? "";
    const bt = b.preferredTime ?? "";
    if (at && bt) return at < bt ? -1 : at > bt ? 1 : 0;
    return MOMENT_ORDER[a.moment] - MOMENT_ORDER[b.moment];
  });

  if (sorted.length === 0) {
    return <p className="text-navy-500">Nothing planned on this date.</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-ivory-300">
      {sorted.map((event) => (
        <Link
          key={event.itemId}
          href={`/provider/requests/${event.itemId}`}
          className="-mx-3 flex items-center justify-between gap-4 rounded-xl px-3 py-4 transition-colors hover:bg-ivory-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-navy-500">
              {event.preferredTime ? `${event.preferredTime} · ` : ""}
              {getPlannedMomentLabel(event.moment)}
              {event.preferredTime && event.status === "REQUESTED" ? " (preferred)" : ""}
            </p>
            <p className="truncate font-display text-base text-navy-950">{event.title}</p>
            <p className="text-sm text-navy-600">
              {event.stayName} · {event.guestCount} guest{event.guestCount === 1 ? "" : "s"} ·{" "}
              {formatCurrency(event.pricePerPerson * event.guestCount, event.currency)}
              {event.status === "CONFIRMED" ? " confirmed" : event.status === "REQUESTED" ? " requested" : ""}
            </p>
          </div>
          <Badge tone={getItemStatusTone(event.status)} className="shrink-0">
            {statusLabel(event.status)}
          </Badge>
        </Link>
      ))}
    </div>
  );
}
