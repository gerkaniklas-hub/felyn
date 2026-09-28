import Link from "next/link";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { eventChipClass, statusLabel, type CalendarEvent } from "./MonthCalendar";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or before `dateStr`. */
export function weekStartFor(dateStr: string): string {
  const weekday = (new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(dateStr, -weekday);
}

/**
 * Week view (task 5): seven day-columns starting Monday, each listing its
 * bookings sorted by preferred time (falling back to the moment order), so
 * a provider sees the shape of their week at a glance. Confirmed and
 * pending items are visually distinct the same way as everywhere else in
 * the app — colour AND the status word together, never colour alone.
 * Horizontally scrollable so seven columns stay usable on a phone.
 */
export function WeekCalendar({ weekStart, events }: { weekStart: string; events: CalendarEvent[] }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = eventsByDate.get(event.date) ?? [];
    list.push(event);
    eventsByDate.set(event.date, list);
  }
  const momentOrder: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };
  for (const list of eventsByDate.values()) {
    list.sort((a, b) => {
      const at = a.preferredTime ?? "";
      const bt = b.preferredTime ?? "";
      if (at && bt) return at < bt ? -1 : at > bt ? 1 : 0;
      return momentOrder[a.moment] - momentOrder[b.moment];
    });
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="grid min-w-[720px] grid-cols-7 gap-2">
        {days.map((date, i) => {
          const dayEvents = eventsByDate.get(date) ?? [];
          const isToday = date === new Date().toISOString().slice(0, 10);
          return (
            <div key={date} className="flex flex-col gap-2">
              <div className={`rounded-lg px-2 py-1.5 text-center ${isToday ? "bg-navy-900 text-ivory-50" : "bg-ivory-100 text-navy-700"}`}>
                <p className="text-[11px] font-medium tracking-wide uppercase">{WEEKDAY_LABELS[i]}</p>
                <p className="font-display text-sm">{formatDayLabel(date)}</p>
              </div>
              <div className="flex min-h-[80px] flex-col gap-1.5">
                {dayEvents.length === 0 ? (
                  <p className="px-1 text-xs text-navy-300">Nothing planned</p>
                ) : (
                  dayEvents.map((event) => (
                    <Link
                      key={event.itemId}
                      href={`/provider/requests/${event.itemId}`}
                      className={`flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-xs transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${eventChipClass(event.status)}`}
                    >
                      <span className="font-medium">
                        {event.preferredTime ?? getPlannedMomentLabel(event.moment)}
                      </span>
                      <span className="truncate">{event.title}</span>
                      <span className="opacity-80">{statusLabel(event.status)}</span>
                    </Link>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-navy-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border border-sky-300 bg-ivory-50" aria-hidden="true" />
          Requested
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-600" aria-hidden="true" />
          Confirmed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-ivory-200" aria-hidden="true" />
          Declined
        </span>
      </div>
    </div>
  );
}
