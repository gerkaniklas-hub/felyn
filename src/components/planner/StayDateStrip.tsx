"use client";

import { useEffect, useRef, useState } from "react";
import { formatDateRange } from "@/lib/format";
import { formatDayLabel, formatWeekdayShort } from "@/lib/matching/timeline";

export type PlannerStay = {
  id: string;
  property_name: string;
  location_text: string;
  check_in: string;
  check_out: string;
  guest_count: number;
};

/** What's actually on one date, counted from real item data — never inferred. */
export type DateSummary = { confirmed: number; awaiting: number; declined: number; draft: number };

export const EMPTY_DATE_SUMMARY: DateSummary = { confirmed: 0, awaiting: 0, declined: 0, draft: 0 };

/** Only states that carry information — an empty date says so plainly, no generic labels. */
function summaryLines(summary: DateSummary): { text: string; tone: "sky" | "gold" | "navy" | "muted" }[] {
  const lines: { text: string; tone: "sky" | "gold" | "navy" | "muted" }[] = [];
  if (summary.confirmed > 0) lines.push({ text: `${summary.confirmed} confirmed`, tone: "sky" });
  if (summary.awaiting > 0) lines.push({ text: `${summary.awaiting} awaiting confirmation`, tone: "gold" });
  if (summary.draft > 0) lines.push({ text: `${summary.draft} not yet requested`, tone: "navy" });
  if (lines.length === 0 && summary.declined > 0) {
    lines.push({ text: `${summary.declined} declined`, tone: "navy" });
  }
  if (lines.length === 0) lines.push({ text: "Nothing planned", tone: "muted" });
  return lines;
}

const TONE_CLASS = {
  sky: "text-sky-700",
  gold: "text-gold-700",
  navy: "text-navy-700",
  muted: "text-navy-300",
} as const;

const TONE_CLASS_SELECTED = {
  sky: "text-sky-200",
  gold: "text-gold-200",
  navy: "text-ivory-200",
  muted: "text-navy-300",
} as const;

/**
 * The compact "YOUR STAY" header + a horizontally scrolling row of date
 * chips that replaces the old full-height sidebar timeline. One chip per
 * stay date; arrival and departure are labelled as what they are. The
 * departure date can't host an experience (see getPlannableDates), so it is
 * shown but not selectable.
 */
export function StayDateStrip({
  stay,
  dates,
  selectedDate,
  summaries,
  onSelect,
}: {
  stay: PlannerStay;
  dates: string[];
  selectedDate: string;
  summaries: Map<string, DateSummary>;
  onSelect: (date: string) => void;
}) {
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  function updateScrollButtons() {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  // Keep the button-enabled state accurate on mount, resize, and every scroll
  // (including the smooth scrollIntoView below and native touch/trackpad scroll).
  useEffect(() => {
    updateScrollButtons();
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateScrollButtons();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [dates.length]);

  // Keep the selected chip visible on long stays — but never scroll the page itself on first paint.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    chipRefs.current.get(selectedDate)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedDate]);

  /** One chip-and-a-half per press — enough to feel like real progress without jumping past neighbouring chips. */
  function scrollByPage(direction: 1 | -1) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: "smooth" });
  }

  const lastDate = dates[dates.length - 1];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="text-xs font-medium tracking-wide text-navy-300">YOUR STAY</p>
          <p className="text-sm text-navy-700">
            <span className="font-medium text-navy-900">{stay.location_text}</span> ·{" "}
            {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guest
            {stay.guest_count === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => scrollByPage(-1)}
            disabled={!canScrollLeft}
            aria-label="Earlier dates"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ivory-300 text-navy-700 hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => scrollByPage(1)}
            disabled={!canScrollRight}
            aria-label="Later dates"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ivory-300 text-navy-700 hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ›
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        role="group"
        aria-label="Stay dates"
        className="no-scrollbar -mx-4 mt-3 flex snap-x gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {dates.map((date) => {
          const isDeparture = date === lastDate && dates.length > 1;
          const isArrival = date === dates[0];
          const selected = date === selectedDate;
          const lines = summaryLines(summaries.get(date) ?? EMPTY_DATE_SUMMARY);

          const content = (
            <>
              <span className="flex items-center justify-between gap-2 text-[11px] font-medium tracking-wide">
                <span className={selected ? "text-ivory-200" : "text-navy-500"}>{formatWeekdayShort(date)}</span>
                {isArrival || isDeparture ? (
                  <span
                    className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase ${
                      selected ? "bg-ivory-50/20 text-ivory-50" : "bg-ivory-200 text-navy-700"
                    }`}
                  >
                    {isArrival ? "Arrival" : "Departure"}
                  </span>
                ) : null}
              </span>
              <span className={`mt-0.5 block font-display text-lg leading-tight ${selected ? "text-ivory-50" : "text-navy-950"}`}>
                {formatDayLabel(date)}
              </span>
              <span className="mt-1 flex flex-col gap-0.5 text-[11px] leading-snug">
                {isDeparture
                  ? [<span key="d" className="text-navy-300">Check-out</span>]
                  : lines.map((line) => (
                      <span
                        key={line.text}
                        className={selected ? TONE_CLASS_SELECTED[line.tone] : TONE_CLASS[line.tone]}
                      >
                        {line.text}
                      </span>
                    ))}
              </span>
            </>
          );

          if (isDeparture) {
            return (
              <div
                key={date}
                className="w-[7.25rem] shrink-0 snap-start rounded-2xl border border-dashed border-ivory-300 bg-ivory-50/60 px-3 py-2.5"
              >
                {content}
              </div>
            );
          }

          return (
            <button
              key={date}
              type="button"
              ref={(el) => {
                if (el) chipRefs.current.set(date, el);
                else chipRefs.current.delete(date);
              }}
              onClick={() => onSelect(date)}
              aria-pressed={selected}
              aria-current={selected ? "date" : undefined}
              className={`w-[7.25rem] shrink-0 snap-start rounded-2xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                selected
                  ? "border-navy-900 bg-navy-900 shadow-sm"
                  : "border-ivory-300 bg-ivory-50 hover:border-sky-300"
              }`}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
}
