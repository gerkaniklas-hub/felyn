"use client";

import { PLANNED_MOMENTS, type PlannedMoment } from "@/lib/matching/plan";

/**
 * "Friday, 12 December" — the chosen date as the heading of the moment
 * control. Built from two separately formatted parts (like
 * formatLongDayLabel) so server and browser can't disagree on punctuation.
 */
function formatSelectedDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${weekday}, ${day}`;
}

/**
 * The chosen date + [Morning] [Afternoon] [Evening] — reuses the existing
 * PLANNED_MOMENTS model (no second moment vocabulary). A small dot marks a
 * moment that already has something planned in it.
 */
export function MomentTabs({
  date,
  selected,
  occupied,
  onSelect,
}: {
  date: string;
  selected: PlannedMoment;
  /** Moments on this date that already hold a draft/requested/confirmed experience. */
  occupied: Set<PlannedMoment>;
  onSelect: (moment: PlannedMoment) => void;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="font-display text-xl leading-snug text-navy-950">{formatSelectedDay(date)}</p>
      <div
        role="group"
        aria-label="Time of day"
        className="grid w-full grid-cols-3 gap-1 rounded-full border border-ivory-300 bg-ivory-100 p-1 sm:w-auto sm:min-w-[22rem]"
      >
        {PLANNED_MOMENTS.map((moment) => {
          const isSelected = moment.value === selected;
          return (
            <button
              key={moment.value}
              type="button"
              onClick={() => onSelect(moment.value)}
              aria-pressed={isSelected}
              className={`flex h-10 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isSelected ? "bg-navy-900 text-ivory-50 shadow-card" : "text-navy-600 hover:bg-ivory-200 hover:text-navy-900"
              }`}
            >
              {moment.label}
              {occupied.has(moment.value) ? (
                <span
                  aria-label="Something planned"
                  className={`h-1.5 w-1.5 rounded-full ${isSelected ? "bg-gold-300" : "bg-gold-500"}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
