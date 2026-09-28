/**
 * Pure, UI-agnostic helpers that turn a stay's check_in/check_out dates
 * plus a list of suggested experience ids into a day-by-day timeline for
 * the M6 Stay Planner. Presentational grouping only — it does not claim
 * any experience is booked on a specific date, only that it's suggested
 * for that moment of the stay.
 */

export type StayMomentKind = "arrival" | "evening" | "quiet" | "departure";

export type StayDay = {
  date: string; // 'YYYY-MM-DD'
  index: number;
  kind: StayMomentKind;
  experienceIds: string[];
};

// All date arithmetic here stays in UTC throughout — parsing with a local
// getter (getDate) but serializing with a UTC one (toISOString) creates a
// timezone-dependent off-by-one that, fed back into itself in a loop, can
// freeze on a single date entirely (observed on a UTC+1 machine). Using
// the UTC variants of both the parse and the mutation avoids any
// dependency on the server/browser's local timezone.
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildStayDates(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  let current = checkIn;
  // Safety cap so malformed dates can't loop forever.
  for (let i = 0; i < 60 && current <= checkOut; i++) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates.length > 0 ? dates : [checkIn];
}

/**
 * Spreads experience ids evenly across every day except the last
 * (departure — the guest is leaving, not settling in for an evening).
 */
function assignToDays(dayCount: number, experienceIds: string[]): Map<number, string[]> {
  const assignment = new Map<number, string[]>();
  if (dayCount <= 1 || experienceIds.length === 0) return assignment;

  const availableDayIndexes = Array.from({ length: dayCount - 1 }, (_, i) => i);
  experienceIds.forEach((id, i) => {
    const slot =
      availableDayIndexes[Math.floor((i * availableDayIndexes.length) / experienceIds.length)];
    const existing = assignment.get(slot);
    if (existing) existing.push(id);
    else assignment.set(slot, [id]);
  });
  return assignment;
}

export function buildStayTimeline(
  checkIn: string,
  checkOut: string,
  experienceIds: string[],
): StayDay[] {
  const dates = buildStayDates(checkIn, checkOut);
  const assignment = assignToDays(dates.length, experienceIds);

  return dates.map((date, index) => {
    const ids = assignment.get(index) ?? [];
    let kind: StayMomentKind;
    if (index === 0) kind = "arrival";
    else if (index === dates.length - 1) kind = "departure";
    else if (ids.length > 0) kind = "evening";
    else kind = "quiet";
    return { date, index, kind, experienceIds: ids };
  });
}

export function formatDayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
    .toUpperCase();
}

/** "FRI" — short weekday for the compact date selector. */
export function formatWeekdayShort(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`)
    .toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })
    .toUpperCase();
}

/** "12 DECEMBER · FRIDAY" — the selected-date heading above the moment tabs. */
export function formatLongDayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${day} · ${weekday}`.toUpperCase();
}
