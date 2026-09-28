"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DiscoveryFiltersState, PriceBounds } from "@/lib/matching/discovery-filters";
import { DiscoveryFilters } from "./DiscoveryFilters";

/**
 * Replaces the sidebar's permanently tall filter panel: a compact "Filters"
 * button (with an active-count badge and a one-tap "Clear") that opens the
 * SAME DiscoveryFilters content in a right-hand drawer on desktop and a
 * bottom sheet on mobile. Filter state itself still lives in StayPlanner,
 * so it survives switching dates/moments; nothing here ever calls the
 * server or OpenAI.
 */
export function FilterDrawer({
  filters,
  onFiltersChange,
  onClear,
  activeCount,
  priceBounds,
  currency,
  resultCount,
}: {
  filters: DiscoveryFiltersState;
  onFiltersChange: (next: DiscoveryFiltersState) => void;
  onClear: () => void;
  activeCount: number;
  priceBounds: PriceBounds;
  currency: string;
  /** How many experiences the current filters + slot leave visible — shown on the drawer's "Show" button. */
  resultCount: number;
}) {
  const [open, setOpen] = useState(false);
  const active = activeCount > 0;

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className={`inline-flex h-11 items-center gap-2 rounded-full border px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
            active
              ? "border-navy-900 bg-navy-900 text-ivory-50"
              : "border-navy-300 bg-transparent text-navy-900 hover:bg-ivory-200"
          }`}
        >
          Filters
          {active ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold-300 px-1.5 text-xs font-semibold text-navy-950">
              {activeCount}
            </span>
          ) : null}
        </button>
        {active ? (
          <button
            type="button"
            onClick={onClear}
            className="text-sm font-medium text-sky-600 hover:text-sky-700"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Filter experiences">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-navy-950/40"
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-3xl bg-ivory-50 shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[24rem] sm:rounded-t-none sm:rounded-l-3xl">
            <div className="flex items-center justify-between px-5 pt-5">
              <p className="font-display text-xl text-navy-950">Filters</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-11 px-2 text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <DiscoveryFilters
                filters={filters}
                onChange={onFiltersChange}
                onClear={onClear}
                active={active}
                priceBounds={priceBounds}
                currency={currency}
              />
            </div>
            <div className="border-t border-ivory-300 p-4">
              <Button type="button" className="w-full" onClick={() => setOpen(false)}>
                Show {resultCount} experience{resultCount === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
