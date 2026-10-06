"use client";

import { formatCurrency } from "@/lib/format";
import type { ExperienceCategory } from "@/lib/matching/hard-filter";
import {
  DISCOVERY_DIETARY_OPTIONS,
  type DiscoveryDietaryOption,
  type DiscoveryFiltersState,
  type PriceBounds,
} from "@/lib/matching/discovery-filters";

const EXPERIENCE_TYPE_OPTIONS: { value: ExperienceCategory; label: string }[] = [
  { value: "food", label: "Food" },
  { value: "drink", label: "Drinks" },
  { value: "food_drink", label: "Food & drinks" },
];

// Both thumbs share this class list — the classic dual-range-slider trick:
// two native <input type="range"> stacked with pointer-events disabled on
// the track and re-enabled only on each thumb, so whichever handle the
// guest actually grabs is the one that moves.
const RANGE_THUMB_CLASS =
  "pointer-events-none absolute inset-0 h-5 w-full cursor-pointer appearance-none bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 " +
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-navy-900 " +
  "[&::-webkit-slider-thumb]:shadow [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 " +
  "[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-navy-900";

function BudgetRangeSlider({
  bounds,
  valueMin,
  valueMax,
  currency,
  onChange,
}: {
  bounds: PriceBounds;
  valueMin: number;
  valueMax: number;
  currency: string;
  onChange: (next: { min: number; max: number }) => void;
}) {
  const span = Math.max(bounds.max - bounds.min, 1);
  const minPct = ((valueMin - bounds.min) / span) * 100;
  const maxPct = ((valueMax - bounds.min) / span) * 100;

  return (
    <div>
      <div className="flex items-center justify-between text-sm font-medium text-navy-900">
        <span>{formatCurrency(valueMin, currency)}</span>
        <span>{formatCurrency(valueMax, currency)}</span>
      </div>
      <div className="relative mt-3 h-5">
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-ivory-300" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-sky-500"
          style={{ left: `${minPct}%`, right: `${100 - maxPct}%` }}
        />
        <input
          type="range"
          aria-label="Minimum budget per person"
          min={bounds.min}
          max={bounds.max}
          value={valueMin}
          onChange={(event) => onChange({ min: Math.min(Number(event.target.value), valueMax - 1), max: valueMax })}
          className={RANGE_THUMB_CLASS}
        />
        <input
          type="range"
          aria-label="Maximum budget per person"
          min={bounds.min}
          max={bounds.max}
          value={valueMax}
          onChange={(event) => onChange({ min: valueMin, max: Math.max(Number(event.target.value), valueMin + 1) })}
          className={RANGE_THUMB_CLASS}
        />
      </div>
    </div>
  );
}

/**
 * Section 4/5/6/7's "FILTER EXPERIENCES" panel — budget range, dietary
 * requirements, experience type. Every change here only updates
 * StayPlanner's client-side `filters` state (see experienceMatchesFilters);
 * no server call, no new AI ranking, ever.
 */
export function DiscoveryFilters({
  filters,
  onChange,
  onClear,
  active,
  priceBounds,
  currency,
}: {
  filters: DiscoveryFiltersState;
  onChange: (next: DiscoveryFiltersState) => void;
  onClear: () => void;
  active: boolean;
  priceBounds: PriceBounds;
  currency: string;
}) {
  const valueMin = filters.minBudget ?? priceBounds.min;
  const valueMax = filters.maxBudget ?? priceBounds.max;

  function toggleDietary(option: DiscoveryDietaryOption) {
    const next = new Set(filters.dietary);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange({ ...filters, dietary: next });
  }

  function toggleType(value: ExperienceCategory) {
    const next = new Set(filters.experienceTypes);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filters, experienceTypes: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">FILTER EXPERIENCES</p>
        {active ? (
          <button type="button" onClick={onClear} className="text-xs font-medium text-sky-600 hover:text-sky-700">
            Clear filters
          </button>
        ) : null}
      </div>

      <div>
        <p className="mb-1 text-sm font-medium text-navy-900">Budget per person</p>
        {priceBounds.max > priceBounds.min ? (
          <BudgetRangeSlider
            bounds={priceBounds}
            valueMin={valueMin}
            valueMax={valueMax}
            currency={currency}
            onChange={({ min, max }) => onChange({ ...filters, minBudget: min, maxBudget: max })}
          />
        ) : (
          <p className="text-sm text-navy-500">{formatCurrency(priceBounds.min, currency)} per person</p>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-navy-900">Dietary requirements</p>
        <div className="flex flex-col gap-2">
          {DISCOVERY_DIETARY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-navy-700">
              <input
                type="checkbox"
                checked={filters.dietary.has(option.value)}
                onChange={() => toggleDietary(option.value)}
                className="h-4 w-4 rounded border-navy-300 text-sky-600 focus:ring-sky-400"
              />
              <span>{option.label}</span>
              {option.value === "allergies_other" ? (
                <span className="text-xs text-navy-300">(not yet verifiable)</span>
              ) : null}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-navy-900">Experience type</p>
        <div className="flex flex-col gap-2">
          {EXPERIENCE_TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-navy-700">
              <input
                type="checkbox"
                checked={filters.experienceTypes.has(option.value)}
                onChange={() => toggleType(option.value)}
                className="h-4 w-4 rounded border-navy-300 text-sky-600 focus:ring-sky-400"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
