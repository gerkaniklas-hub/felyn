import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { DayCalendar } from "@/components/provider/DayCalendar";
import { MonthCalendar, type CalendarEvent } from "@/components/provider/MonthCalendar";
import { WeekCalendar, weekStartFor } from "@/components/provider/WeekCalendar";
import { getItemStatusLabel, getItemStatusTone } from "@/lib/matching/booking-status";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getProviderIdentity, getProviderRequestItems } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Normalizes a possibly out-of-range 0-indexed month (e.g. -1 or 12) back into a valid year/month pair. */
function monthParam(year: number, month: number): string {
  const normalizedYear = year + Math.floor(month / 12);
  const normalizedMonth = ((month % 12) + 12) % 12;
  return `${normalizedYear}-${pad(normalizedMonth + 1)}`;
}

function parseMonthParam(param: string | undefined): { year: number; month: number } {
  if (param && /^\d{4}-\d{2}$/.test(param)) {
    const [year, month] = param.split("-").map(Number);
    return { year, month: month - 1 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY = () => new Date().toISOString().slice(0, 10);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const WEEK_LABEL_FORMATTER = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

type View = "month" | "week" | "day";

function ViewTabs({ view, date, month }: { view: View; date: string; month: string }) {
  const tabs: { value: View; label: string; href: string }[] = [
    { value: "month", label: "Month", href: `/provider/calendar?view=month&month=${month}` },
    { value: "week", label: "Week", href: `/provider/calendar?view=week&date=${date}` },
    { value: "day", label: "Day", href: `/provider/calendar?view=day&date=${date}` },
  ];
  return (
    <div className="flex gap-1 rounded-full border border-ivory-300 bg-ivory-50 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.value}
          href={tab.href}
          aria-current={tab.value === view ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            tab.value === view ? "bg-navy-900 text-ivory-50" : "text-navy-700 hover:bg-ivory-200"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * P1 + task 5: the full provider calendar, now with a Day / Week / Month
 * switcher (`?view=`). Same underlying data as the dashboard preview
 * (getProviderRequestItems) and the same per-item detail page as
 * everywhere else — every view just slices and displays the identical
 * `CalendarEvent` list differently; nothing here recomputes booking status
 * or invents a second source of truth.
 */
export default async function ProviderCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string; date?: string }>;
}) {
  const { view: viewParam, month: monthParamValue, date: dateParam } = await searchParams;
  const view: View = viewParam === "week" || viewParam === "day" ? viewParam : "month";
  const { year, month } = parseMonthParam(monthParamValue);
  const refDate = dateParam && DATE_PATTERN.test(dateParam) ? dateParam : TODAY();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const identity = user ? await getProviderIdentity(supabase, user.id) : null;

  if (!identity) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <Heading level={2}>Provider profile not found</Heading>
        <p className="mt-2 text-navy-500">This account isn&apos;t linked to a Felyn provider profile yet.</p>
      </Card>
    );
  }

  const items = await getProviderRequestItems(supabase, identity.id);
  const calendarEvents: CalendarEvent[] = items.map((item) => ({
    itemId: item.itemId,
    date: item.plannedDate,
    moment: item.plannedMoment,
    preferredTime: item.preferredTime,
    status: item.status,
    title: item.experienceTitle,
    imageUrl: item.experienceImageUrl,
    stayName: item.stayName,
    guestCount: item.guestCount,
    pricePerPerson: item.pricePerPerson,
    currency: item.currency,
  }));

  const monthParamStr = monthParam(year, month);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-navy-300">YOUR CALENDAR</p>
          <Heading level={1} className="mt-2">
            {view === "month"
              ? MONTH_LABEL_FORMATTER.format(new Date(Date.UTC(year, month, 1)))
              : view === "week"
                ? `Week of ${WEEK_LABEL_FORMATTER.format(new Date(`${weekStartFor(refDate)}T00:00:00Z`))}`
                : DAY_LABEL_FORMATTER.format(new Date(`${refDate}T00:00:00Z`))}
          </Heading>
        </div>
        <ViewTabs view={view} date={refDate} month={monthParamStr} />
      </div>

      {view === "month" ? (
        <>
          <Card>
            <div className="mb-4 flex items-center justify-end gap-3">
              <Link
                href={`/provider/calendar?view=month&month=${monthParam(year, month - 1)}`}
                className="text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                ← Previous
              </Link>
              <Link
                href={`/provider/calendar?view=month&month=${monthParam(year, month + 1)}`}
                className="text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                Next →
              </Link>
            </div>
            <MonthCalendar year={year} month={month} events={calendarEvents} />
          </Card>

          <Card>
            <Heading level={3}>This month</Heading>
            {(() => {
              const monthStart = `${year}-${pad(month + 1)}-01`;
              const monthEndExclusive = `${monthParam(year, month + 1)}-01`;
              const monthItems = calendarEvents
                .filter((event) => event.date >= monthStart && event.date < monthEndExclusive)
                .sort((a, b) => (a.date < b.date ? -1 : 1));
              if (monthItems.length === 0) {
                return <p className="mt-3 text-navy-500">No experiences on the calendar this month.</p>;
              }
              return (
                <div className="mt-4 flex flex-col divide-y divide-ivory-300">
                  {monthItems.map((event) => (
                    <Link
                      key={event.itemId}
                      href={`/provider/requests/${event.itemId}`}
                      className="flex flex-col gap-1 rounded-lg py-4 transition-colors first:pt-0 last:pb-0 hover:bg-ivory-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="text-sm font-medium text-navy-300">{formatDayLabel(event.date)}</p>
                        <p className="font-display text-base text-navy-950">{event.title}</p>
                        <p className="text-sm text-navy-500">
                          {event.stayName} · {event.guestCount} guest{event.guestCount === 1 ? "" : "s"}
                        </p>
                      </div>
                      <Badge tone={getItemStatusTone(event.status)}>{getItemStatusLabel(event.status)}</Badge>
                    </Link>
                  ))}
                </div>
              );
            })()}
          </Card>
        </>
      ) : view === "week" ? (
        <Card>
          <div className="mb-4 flex items-center justify-end gap-3">
            <Link
              href={`/provider/calendar?view=week&date=${addDays(weekStartFor(refDate), -7)}`}
              className="text-sm font-medium text-sky-600 hover:text-sky-700"
            >
              ← Previous week
            </Link>
            <Link
              href={`/provider/calendar?view=week&date=${addDays(weekStartFor(refDate), 7)}`}
              className="text-sm font-medium text-sky-600 hover:text-sky-700"
            >
              Next week →
            </Link>
          </div>
          <WeekCalendar weekStart={weekStartFor(refDate)} events={calendarEvents} />
        </Card>
      ) : (
        <Card>
          <div className="mb-4 flex items-center justify-end gap-3">
            <Link
              href={`/provider/calendar?view=day&date=${addDays(refDate, -1)}`}
              className="text-sm font-medium text-sky-600 hover:text-sky-700"
            >
              ← Previous day
            </Link>
            <Link
              href={`/provider/calendar?view=day&date=${addDays(refDate, 1)}`}
              className="text-sm font-medium text-sky-600 hover:text-sky-700"
            >
              Next day →
            </Link>
          </div>
          <DayCalendar events={calendarEvents.filter((event) => event.date === refDate)} />
        </Card>
      )}
    </div>
  );
}
