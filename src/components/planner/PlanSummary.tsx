"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { formatDayLabel } from "@/lib/matching/timeline";
import { getPlannedMomentLabel, type PlannedSlot } from "@/lib/matching/plan";
import type { RecommendedExperience } from "@/lib/matching/actions";
import {
  getGuestItemStatusLabel,
  isSlotOccupyingStatus,
  type DeclineReason,
  type PlanItemStatus,
} from "@/lib/matching/booking-status";

export type PlanItem = {
  /** The owning PlanSelection's id (or the request item's id) — use this as the list key, never experience.id (the same experience can appear twice, on different dates). */
  selectionId: string;
  recommendation: RecommendedExperience;
  slot: PlannedSlot;
  /** "DRAFT" = added to the plan but not requested yet; anything else is a persisted request item's own status. */
  status: PlanItemStatus;
  /** This experience's own group size — not the stay's. */
  guestCount: number;
  /** Price at request time for request items; the current price for a draft. */
  pricePerPerson: number;
  preferredTime: string | null;
  hostNote: string;
  declineReason: DeclineReason | null;
  /** Stage 2c-B: anchors for the 30-day post-decision messaging window — see getMessagingWindowState in booking-status.ts. Null unless the item is DECLINED/CANCELLED respectively. */
  decidedAt: string | null;
  cancelledAt: string | null;
};

/**
 * Persistent "Your Felyn plan" summary — stays on screen (bottom-right on
 * desktop, full-width on mobile) while the guest browses, so their plan is
 * never lost from view. Counts only items that still hold a slot
 * (drafts, awaiting, confirmed) — declined/withdrawn ones are history.
 */
export function PlanSummary({
  items,
  estimatedTotal,
  currency,
  hasConflicts,
  onReview,
}: {
  items: PlanItem[];
  estimatedTotal: number;
  currency: string;
  /** True when two occupying items share the exact same date+moment (M6.5). */
  hasConflicts: boolean;
  onReview: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = items.filter((item) => isSlotOccupyingStatus(item.status));
  const draftCount = active.filter((item) => item.status === "DRAFT").length;

  return (
    <div className="fixed right-4 bottom-4 left-4 z-30 sm:right-6 sm:left-auto sm:w-80">
      <div className="rounded-2xl border border-ivory-300 bg-ivory-50/95 shadow-lg backdrop-blur">
        {active.length > 0 && expanded ? (
          <div className="max-h-64 overflow-y-auto border-b border-ivory-300 p-4">
            <p className="mb-3 text-xs font-medium tracking-wide text-navy-300">YOUR FELYN PLAN</p>
            <ul className="flex flex-col gap-3">
              {active.map(({ selectionId, recommendation, slot, status, guestCount }) => (
                <li key={selectionId}>
                  <p className="text-xs text-navy-300">
                    {formatDayLabel(slot.date)} · {getPlannedMomentLabel(slot.moment)} · {guestCount} guest
                    {guestCount === 1 ? "" : "s"}
                  </p>
                  <p className="text-sm text-navy-900">{recommendation.experience.title}</p>
                  <p className="text-xs text-navy-500">
                    {status === "DRAFT" ? "Not yet requested" : getGuestItemStatusLabel(status)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => active.length > 0 && setExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left"
        >
          <span className="text-sm text-navy-700">
            {active.length === 0
              ? "Add experiences to build your plan"
              : `${active.length} experience${active.length === 1 ? "" : "s"} · ${formatCurrency(
                  estimatedTotal,
                  currency,
                )} estimated total`}
          </span>
          {active.length > 0 ? <span className="shrink-0 text-navy-300">{expanded ? "▾" : "▴"}</span> : null}
        </button>

        {items.length > 0 ? (
          <div className="flex flex-col gap-2 px-5 pb-4">
            {hasConflicts ? (
              <p className="text-xs font-medium text-gold-700">⚠ A scheduling conflict needs to be resolved</p>
            ) : null}
            <Button type="button" size="md" className="w-full" onClick={onReview}>
              {draftCount > 0 ? `Review & request (${draftCount} new)` : "View your plan"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
