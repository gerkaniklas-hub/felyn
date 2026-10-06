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
      className={`group flex h-full cursor-pointer flex-col overflow-hidden rounded-card border bg-ivory-50 text-left shadow-card transition-[border-color,box-shadow] duration-200 hover:border-ivory-400 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        selected ? "border-sky-500 ring-1 ring-sky-500" : "border-ivory-300"
      }`}
    >
      {/* Fixed 4:3 frame for every card. The image (or placeholder) is absolutely positioned and cropped with
          object-cover, so its own dimensions can never stretch the frame — as an in-flow flex child, a tall
          upload's intrinsic height used to push this box past 4:3. */}
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden">
        <FallbackImage
          src={experience.image_url}
          alt={experience.title}
          className="absolute inset-0 h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
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
      <div className={`flex flex-1 flex-col ${compact ? "gap-2 p-3.5" : "gap-3 p-5"}`}>
        <div>
          {compact ? (
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">Other idea</p>
          ) : null}
          <p className={`font-display leading-snug text-navy-950 ${compact ? "text-base" : "text-xl"}`}>
            {experience.title}
          </p>
          <p className={`mt-1 text-navy-500 ${compact ? "text-xs" : "text-sm"}`}>
            {experience.provider.display_name}
          </p>
        </div>
        {!compact && experience.short_description ? (
          <p className="line-clamp-2 min-h-[3.25em] text-sm leading-relaxed text-navy-600">{experience.short_description}</p>
        ) : null}
        <p
          className={`font-medium text-navy-900 ${
            compact ? "text-xs" : "mt-auto border-t border-ivory-200 pt-3 text-sm"
          }`}
        >
          {formatPrice(experience.price_per_person, experience.currency)}
        </p>
        {selected && conflict ? (
          <p className="mt-auto rounded-full bg-gold-100 px-2.5 py-1 text-xs font-medium text-gold-700">
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
