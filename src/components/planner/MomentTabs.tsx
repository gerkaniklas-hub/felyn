"use client";

import { PLANNED_MOMENTS, type PlannedMoment } from "@/lib/matching/plan";
import { formatLongDayLabel } from "@/lib/matching/timeline";

/**
 * "12 DECEMBER · FRIDAY" + [Morning] [Afternoon] [Evening] — reuses the
 * existing PLANNED_MOMENTS model (no second moment vocabulary). A small dot
 * marks a moment that already has something planned in it.
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
    <div>
      <p className="text-xs font-medium tracking-wide text-navy-300">{formatLongDayLabel(date)}</p>
      <div role="group" aria-label="Time of day" className="mt-2 grid grid-cols-3 gap-2 sm:max-w-md">
        {PLANNED_MOMENTS.map((moment) => {
          const isSelected = moment.value === selected;
          return (
            <button
              key={moment.value}
              type="button"
              onClick={() => onSelect(moment.value)}
              aria-pressed={isSelected}
              className={`flex h-11 items-center justify-center gap-1.5 rounded-full border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isSelected
                  ? "border-navy-900 bg-navy-900 text-ivory-50"
                  : "border-navy-300 bg-transparent text-navy-900 hover:bg-ivory-200"
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
