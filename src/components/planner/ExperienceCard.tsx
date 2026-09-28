"use client";

import type { KeyboardEvent } from "react";
import { formatPrice } from "@/lib/format";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";

/**
 * A premium hospitality-style card, not a SaaS result row. The whole card
 * opens the experience focus panel; the small circular control in the
 * corner is a separate, real <button> so selecting into the plan never
 * triggers navigation into focus (and vice versa).
 */
export function ExperienceCard({
  experience,
  reason,
  selected,
  plannedLabel,
  conflict,
  size = "default",
  locked = false,
  onOpen,
  onToggleSelect,
}: {
  experience: MatchedExperience;
  /** AI "why we picked this" reason — empty string for an undiscovered alternative (no reason line shown). */
  reason: string;
  selected: boolean;
  /** e.g. "Planned for 24 Sep · Evening" — shown instead of `reason` once the guest has added this to their plan. */
  plannedLabel?: string | null;
  /** True when this selected item shares its exact date+moment with another selected item (M6.5). */
  conflict?: boolean;
  /** "compact" is used for the smaller "other ideas" cards beside the primary suggestion. */
  size?: "default" | "compact";
  /** M7.2: true once the stay has an active (REQUESTED/CONFIRMED) request — the "+" control is disabled; opening the card to browse is still allowed. */
  locked?: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }

  const compact = size === "compact";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border bg-ivory-200 text-left shadow-sm transition-colors hover:border-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        selected ? "border-sky-500 ring-1 ring-sky-500" : "border-ivory-300"
      }`}
    >
      <div className="relative aspect-[4/3] w-full">
        <FallbackImage src={experience.image_url} alt={experience.title} className="h-full w-full" />
        {!locked ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleSelect();
            }}
            aria-pressed={selected}
            aria-label={selected ? "Remove from your plan" : "Add to your plan"}
            className={`absolute top-2.5 right-2.5 flex items-center justify-center rounded-full text-sm font-semibold shadow transition-colors ${
              compact ? "h-6 w-6 text-xs" : "h-8 w-8"
            } ${selected ? "bg-navy-900 text-ivory-50" : "bg-ivory-50/90 text-navy-700 hover:bg-ivory-50"}`}
          >
            {selected ? "✓" : "+"}
          </button>
        ) : selected ? (
          <span
            aria-hidden="true"
            className={`absolute top-2.5 right-2.5 flex items-center justify-center rounded-full bg-navy-900 text-sm font-semibold text-ivory-50 shadow ${
              compact ? "h-6 w-6 text-xs" : "h-8 w-8"
            }`}
          >
            ✓
          </span>
        ) : null}
      </div>
      <div className={`flex flex-1 flex-col gap-2 ${compact ? "p-3.5" : "p-5"}`}>
        <div>
          {compact ? (
            <p className="text-[11px] font-medium tracking-wide text-navy-300 uppercase">Other idea</p>
          ) : null}
          <p className={`font-display text-navy-950 ${compact ? "text-base" : "text-lg"}`}>
            {experience.title}
          </p>
          <p className={`text-navy-500 ${compact ? "text-xs" : "text-sm"}`}>
            {experience.provider.display_name}
          </p>
        </div>
        <p className={`font-medium text-navy-900 ${compact ? "text-xs" : "text-sm"}`}>
          {formatPrice(experience.price_per_person, experience.currency)}
        </p>
        {!compact && experience.short_description ? (
          <p className="line-clamp-2 text-sm text-navy-500">{experience.short_description}</p>
        ) : null}
        {selected && conflict ? (
          <p className="mt-auto rounded-md bg-gold-100 px-2 py-1 text-xs font-medium text-gold-700">
            ⚠ Scheduling conflict
          </p>
        ) : selected && plannedLabel ? (
          <p className={`mt-auto pt-1 font-medium text-navy-700 ${compact ? "text-xs" : "text-xs"}`}>
            {plannedLabel}
          </p>
        ) : reason ? (
          <p className="mt-auto pt-1 text-xs font-medium text-sky-700">{reason}</p>
        ) : null}
      </div>
    </div>
  );
}
