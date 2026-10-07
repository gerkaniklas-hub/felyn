import Link from "next/link";
import { PLANNED_MOMENTS, type PlannedMoment } from "@/lib/matching/plan";

export type CalendarEvent = {
  itemId: string;
  date: string; // 'YYYY-MM-DD'
  moment: PlannedMoment;
  /** 'HH:MM' the guest would prefer — a preference only, shown as such until CONFIRMED. */
  preferredTime: string | null;
  status: "REQUESTED" | "CONFIRMED" | "DECLINED" | "CANCELLED";
  title: string;
  imageUrl: string | null;
  stayName: string;
  guestCount: number;
  pricePerPerson: number;
  currency: string;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Monday-start week grid for one month, padded with `null` blanks front/back to fill whole weeks. */
function buildWeeks(year: number, month: number): (string | null)[][] {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = (firstOfMonth.getUTCDay() + 6) % 7; // Monday = 0

  const cells: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(`${year}-${pad(month + 1)}-${pad(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Distinguishable at a glance, never by colour alone — the tone word is always in the label/title too. */
export function eventChipClass(status: CalendarEvent["status"]): string {
  if (status === "CONFIRMED") return "bg-sky-600 text-ivory-50 border border-sky-600";
  if (status === "DECLINED" || status === "CANCELLED") return "bg-ivory-200 text-navy-300 border border-ivory-300 line-through";
  return "bg-ivory-50 text-sky-700 border border-sky-300";
}

export function statusLabel(status: CalendarEvent["status"]): string {
  if (status === "CONFIRMED") return "Confirmed";
  if (status === "DECLINED") return "Declined";
  if (status === "CANCELLED") return "Cancelled";
  return "Requested";
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The Month view of the provider calendar — a dependency-free grid with
 * three fixed planning slots per day (Morning/Afternoon/Evening, matching
 * the existing `planned_moment` values; no exact times in the grid itself).
 * `compact` (the dashboard preview) stays a simple, non-interactive glance
 * wrapped in an outer Link to /provider/calendar — its own cells are never
 * links, since nesting an anchor inside that outer Link would be invalid.
 * The full page's cells link straight to each booking's OWN detail page
 * (`/provider/requests/[itemId]`) — the same page the dashboard and
 * Requests list open, never a second calendar-only detail view (task 4/5).
 */
export function MonthCalendar({
  year,
  month,
  events,
  compact = false,
}: {
  year: number;
  /** 0-indexed, i.e. January = 0. */
  month: number;
  events: CalendarEvent[];
  compact?: boolean;
}) {
  const weeks = buildWeeks(year, month);
  // A declined item's replacement can land on the very same date+moment for
  // the same provider — a REQUESTED/CONFIRMED item always wins that slot
  // (and the compact view's featured chip) over its own declined history,
  // so active events are processed last into the exact-slot map, and first
  // into the compact per-day list.
  const declinedFirst = [...events].sort((a, b) => (a.status === "DECLINED" ? -1 : b.status === "DECLINED" ? 1 : 0));
  const activeFirst = [...events].sort((a, b) => (a.status === "DECLINED" ? 1 : b.status === "DECLINED" ? -1 : 0));

  const eventByDateMoment = new Map<string, CalendarEvent>();
  for (const event of declinedFirst) {
    eventByDateMoment.set(`${event.date}|${event.moment}`, event);
  }

  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const event of activeFirst) {
    const list = eventsByDate.get(event.date) ?? [];
    list.push(event);
    eventsByDate.set(event.date, list);
  }

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] sm:gap-1.5 font-semibold tracking-[0.12em] text-navy-400 uppercase">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-1 sm:gap-1.5">
        {weeks.map((week, i) => (
          <div key={i} className="grid grid-cols-7 gap-1 sm:gap-1.5">
            {week.map((date, j) => {
              const dayEvents = date ? (eventsByDate.get(date) ?? []) : [];
              return (
                <div
                  key={j}
                  className={
                    date
                      ? `flex ${compact ? "min-h-12 p-1.5" : "min-h-[76px] p-1 sm:min-h-[112px] sm:p-1.5"} min-w-0 flex-col gap-1 rounded-xl border border-ivory-300 bg-ivory-50`
                      : ""
                  }
                >
                  {!date ? null : compact ? (
                    <>
                      <span className="text-xs font-medium text-navy-600">{Number(date.slice(-2))}</span>
                      {dayEvents[0] ? (
                        <span
                          title={`${dayEvents[0].title} — ${statusLabel(dayEvents[0].status)}`}
                          className={`truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium ${eventChipClass(dayEvents[0].status)}`}
                        >
                          {dayEvents[0].title}
                        </span>
                      ) : null}
                      {dayEvents.length > 1 ? (
                        <span className="text-[10px] text-navy-300">+{dayEvents.length - 1} more</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-medium text-navy-600">{Number(date.slice(-2))}</span>
                      {/* Three fixed rows, top-to-bottom = morning/afternoon/evening — positional
                          only, no literal labels (an empty slot is just a quiet blank row so
                          every day still reads as "three slots" without any text clutter). */}
                      {PLANNED_MOMENTS.map((moment) => {
                        const event = eventByDateMoment.get(`${date}|${moment.value}`);
                        if (!event) {
                          return <div key={moment.value} className="h-2.5 sm:h-[18px]" aria-hidden="true" />;
                        }
                        return (
                          <Link
                            key={moment.value}
                            href={`/provider/requests/${event.itemId}`}
                            title={`${moment.label}: ${event.title} — ${statusLabel(event.status)}`}
                            className={`block h-2.5 truncate rounded-full text-left text-[10px] transition-opacity sm:h-[18px] sm:rounded-md sm:px-1.5 sm:leading-[18px] hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${eventChipClass(event.status)}`}
                          >
                            {/* Phones: a status-coloured bar in its moment's row (title in the
                                tooltip and for screen readers; "This month" below lists them in
                                full). From sm up: the titled chip. */}
                            <span className="sr-only sm:not-sr-only">{event.title}</span>
                          </Link>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-navy-500">
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
