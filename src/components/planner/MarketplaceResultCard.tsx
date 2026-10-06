"use client";

import type { KeyboardEvent } from "react";
import { formatCurrency } from "@/lib/format";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";

/**
 * The marketplace/search-result card that replaced ExperienceCarousel's
 * large-center/small-side layout — a wide, shallow row (image | info |
 * price+CTA) so a guest can scan several experiences without excessive
 * scrolling, closer to Skyscanner/Airbnb search results than a hero-card
 * carousel. Never selects anything on click — it only opens ExperienceFocus
 * (see StayPlanner.openExperience); "Add to my plan" stays inside the focus
 * panel, same as before.
 */
export function MarketplaceResultCard({
  experience,
  reason,
  selected,
  plannedLabel,
  conflict,
  onOpen,
}: {
  experience: MatchedExperience;
  /** AI "why we picked this" reason — empty string for an undiscovered alternative (no reason line shown). */
  reason: string;
  selected: boolean;
  /** e.g. "Planned for 24 Sep · Evening" (or, once locked, "AWAITING CONFIRMATION · 24 Sep · Evening") — shown instead of `reason` once this is in the guest's plan. */
  plannedLabel: string | null;
  /** True when this selected item shares its exact date+moment with another selected item. */
  conflict: boolean;
  onOpen: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }

  const softAttributes = experience.attributes.filter((attr) => attr.attribute_type !== "dietary").slice(0, 3);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-card border bg-ivory-50 text-left shadow-card transition-[border-color,box-shadow] duration-200 hover:border-ivory-400 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:flex-row ${
        selected ? "border-sky-400 ring-1 ring-sky-400" : "border-ivory-300"
      }`}
    >
      <div className="aspect-[16/9] w-full shrink-0 overflow-hidden sm:aspect-auto sm:min-h-40 sm:w-52">
        <FallbackImage
          src={experience.image_url}
          alt={experience.title}
          className="h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 p-5">
        <div className="min-w-0">
          <p className="truncate font-display text-xl text-navy-950">{experience.title}</p>
          <p className="text-sm text-navy-500">Hosted by {experience.provider.display_name}</p>
        </div>

        {experience.short_description ? (
          <p className="line-clamp-2 text-sm text-navy-700">{experience.short_description}</p>
        ) : null}

        {softAttributes.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {softAttributes.map((attr, i) => (
              <span
                key={`${attr.attribute_type}-${attr.attribute_value}-${i}`}
                className="rounded-full bg-navy-100 px-2.5 py-0.5 text-xs font-medium text-navy-700 capitalize"
              >
                {attr.attribute_value.replace(/[-_]/g, " ")}
              </span>
            ))}
          </div>
        ) : null}

        {conflict ? (
          <p className="w-fit rounded-full bg-gold-100 px-2.5 py-1 text-xs font-medium text-gold-700">
            ⚠ Scheduling conflict
          </p>
        ) : selected && plannedLabel ? (
          <p className="text-xs font-medium text-navy-700">{plannedLabel}</p>
        ) : reason ? (
          <p className="text-xs font-medium text-sky-700">{reason}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-row items-center justify-between gap-3 border-t border-ivory-200 px-5 py-4 sm:w-40 sm:flex-col sm:items-end sm:justify-center sm:gap-2 sm:border-t-0 sm:border-l sm:p-5 sm:text-right">
        <div>
          <p className="font-display text-xl leading-none text-navy-950">
            {formatCurrency(experience.price_per_person, experience.currency)}
          </p>
          <p className="mt-1 text-xs text-navy-500">per person</p>
        </div>
        <span className="shrink-0 text-sm font-medium text-sky-600">View details →</span>
      </div>
    </div>
  );
}
