"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GuestExperienceItem } from "@/lib/matching/guest-experiences";
import { GuestExperienceRow } from "./GuestExperienceRow";

type TabKey = "upcoming" | "past" | "cancelled";

const PAGE_SIZE = 10;

/**
 * Phase 4/5 of the consolidated improvements: replaces the old single
 * unstructured list on /experiences with Upcoming / Past / Cancelled &
 * Declined tabs, upcoming shown first and selected by default. Built
 * entirely from the same GuestExperienceItem[] the page already fetches —
 * no new query, no new table. "Past" isn't the automatic completion job's
 * completed_at (that only drives the profile's achievement count, see
 * Profile) — it's simply a confirmed/requested item whose date has already
 * passed, which is available immediately rather than waiting on that job.
 *
 * Each tab renders progressively (PAGE_SIZE at a time, "Show more" to
 * reveal further ones) rather than the whole history at once — the data is
 * already fully fetched server-side (a single, already-cheap query), this
 * only limits how much gets mounted into the DOM at once.
 */
export function GuestExperienceTabs({ items }: { items: GuestExperienceItem[] }) {
  const today = new Date().toISOString().slice(0, 10);

  const { upcoming, past, cancelled } = useMemo(() => {
    const upcoming: GuestExperienceItem[] = [];
    const past: GuestExperienceItem[] = [];
    const cancelled: GuestExperienceItem[] = [];
    for (const item of items) {
      if (item.status === "CANCELLED" || item.status === "DECLINED" || item.status === "WITHDRAWN") {
        cancelled.push(item);
      } else if (item.plannedDate >= today) {
        upcoming.push(item);
      } else {
        past.push(item);
      }
    }
    upcoming.sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1));
    past.sort((a, b) => (a.plannedDate > b.plannedDate ? -1 : 1));
    cancelled.sort((a, b) => (a.plannedDate > b.plannedDate ? -1 : 1));
    return { upcoming, past, cancelled };
  }, [items, today]);

  const [activeTab, setActiveTab] = useState<TabKey>("upcoming");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const tabs: { key: TabKey; label: string; items: GuestExperienceItem[] }[] = [
    { key: "upcoming", label: "Upcoming", items: upcoming },
    { key: "past", label: "Past", items: past },
    { key: "cancelled", label: "Cancelled / Declined", items: cancelled },
  ];

  const active = tabs.find((t) => t.key === activeTab)!;
  const visibleItems = active.items.slice(0, visibleCount);

  function selectTab(key: TabKey) {
    setActiveTab(key);
    setVisibleCount(PAGE_SIZE);
  }

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Your experiences" className="flex flex-wrap gap-2 border-b border-ivory-300">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => selectTab(tab.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-navy-900 text-navy-900"
                : "border-transparent text-navy-400 hover:text-navy-700"
            }`}
          >
            {tab.label} ({tab.items.length})
          </button>
        ))}
      </div>

      {active.items.length === 0 ? (
        <p className="text-sm text-navy-400">
          {activeTab === "upcoming"
            ? "Nothing upcoming yet."
            : activeTab === "past"
              ? "No past experiences yet."
              : "Nothing cancelled or declined."}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {visibleItems.map((item) => (
              <GuestExperienceRow key={item.id} item={item} />
            ))}
          </div>
          {visibleCount < active.items.length ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="self-center"
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
            >
              Show more ({active.items.length - visibleCount} more)
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
