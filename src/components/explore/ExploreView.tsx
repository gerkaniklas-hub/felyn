"use client";

import { useMemo, useState } from "react";
import { MapPinIcon, SearchIcon } from "@/components/navigation/icons";
import type { ExperienceCategory, MatchedExperience } from "@/lib/matching/hard-filter";
import { ExploreBrowser } from "./ExploreBrowser";

/** Every category Felyn experiences can have today (see the experiences.category check constraint). */
const FOOD_AND_DRINK: ExperienceCategory[] = ["food", "drink", "food_drink"];

type CategoryKey = "all" | "food_drink";

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "food_drink", label: "Food & Drink" },
];

/** Shown so guests can see where Felyn is heading; not selectable until such experiences exist. */
const COMING_SOON = ["Nature", "Water", "Culture", "Wellness", "For Families"];

/** Lowercase and strip accents, so "orotava" matches "La Orotava" and "guimar" matches "Güímar". */
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * /explore's search, location and category controls, in front of the
 * existing ExploreBrowser grid. Filtering is purely client-side over the
 * list the page already loads: no backend filter, no geocoding.
 *
 * - Search matches title, host name, cuisine and short description.
 * - Location matches the host's base location and any of their service
 *   locations (the only stored location data; experiences have none of
 *   their own). Partial, case- and accent-insensitive.
 * - All three combine; an empty field doesn't filter.
 */
export function ExploreView({
  experiences,
  serviceLocationsByProvider,
}: {
  experiences: MatchedExperience[];
  serviceLocationsByProvider: Record<string, string[]>;
}) {
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState<CategoryKey>("all");

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    const where = normalize(location.trim());
    return experiences.filter((experience) => {
      if (category === "food_drink" && !FOOD_AND_DRINK.includes(experience.category)) return false;
      if (where) {
        const places = [experience.provider.base_location, ...(serviceLocationsByProvider[experience.provider_id] ?? [])];
        if (!places.some((place) => place && normalize(place).includes(where))) return false;
      }
      if (!q) return true;
      return [experience.title, experience.provider.display_name, experience.cuisine, experience.short_description]
        .filter(Boolean)
        .some((value) => normalize(value as string).includes(q));
    });
  }, [experiences, serviceLocationsByProvider, query, location, category]);

  const inputClass =
    "h-12 w-full rounded-full border border-ivory-300 bg-ivory-50 pr-4 pl-12 text-sm text-navy-900 placeholder:text-navy-300 focus:border-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 sm:h-14 sm:rounded-none sm:border-0 sm:bg-transparent sm:focus-visible:ring-0";

  return (
    <div className="flex flex-col gap-6">
      {/* Phone: two stacked fields. Wider: one rounded bar split into "what" and "where". */}
      <div
        role="search"
        className="flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:rounded-full sm:border sm:border-ivory-300 sm:bg-ivory-50 sm:shadow-sm sm:focus-within:border-sky-300"
      >
        <label className="relative block sm:flex-[1.4]">
          <span className="sr-only">Search experiences</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-navy-300 sm:left-5" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search experiences, hosts or cuisines"
            className={`${inputClass} sm:pl-13`}
          />
        </label>
        <span aria-hidden="true" className="hidden h-8 w-px shrink-0 bg-ivory-300 sm:block" />
        <label className="relative block sm:flex-1">
          <span className="sr-only">Location</span>
          <MapPinIcon className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-navy-300" />
          <input
            type="search"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Where?"
            className={inputClass}
          />
        </label>
      </div>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {CATEGORIES.map((item) => {
          const active = category === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(item.key)}
              className={`h-10 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${
                active
                  ? "border-navy-900 bg-navy-900 text-ivory-50"
                  : "border-ivory-300 bg-ivory-50 text-navy-700 hover:border-navy-300"
              }`}
            >
              {item.label}
            </button>
          );
        })}
        {COMING_SOON.map((label) => (
          <span
            key={label}
            aria-disabled="true"
            className="inline-flex h-10 shrink-0 cursor-default items-center gap-2 rounded-full border border-dashed border-ivory-400 px-4 text-sm text-navy-300"
          >
            {label}
            <span className="rounded-full bg-ivory-200 px-2 py-0.5 text-[10px] font-medium tracking-wide text-navy-500 uppercase">
              Soon
            </span>
          </span>
        ))}
      </div>

      {filtered.length === 0 && experiences.length > 0 ? (
        <p className="rounded-3xl border border-dashed border-ivory-400 bg-ivory-50 px-6 py-10 text-center text-sm text-navy-500">
          No experiences match your search. Try a different place or clear a filter.
        </p>
      ) : (
        <ExploreBrowser experiences={filtered} />
      )}
    </div>
  );
}
