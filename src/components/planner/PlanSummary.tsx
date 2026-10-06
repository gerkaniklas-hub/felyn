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
 * "Your Felyn plan" summary at the end of the planner — counts what the guest
 * has planned and opens the review. Sits in the page flow (never floating),
 * so it never covers planner controls or experience cards. Counts only items that still hold a slot
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

  // Always in the normal page flow at the end of the planner, at every width:
  // never docked or floating, so it can never sit over the date strip, the
  // time-of-day control, a planned item's actions or an experience card.
  // Once the plan holds anything it gets the raised (populated) surface.
  const docked = items.length > 0;

  return (
    <div className="mt-8">
      <div
        className={`mx-auto max-w-3xl rounded-card border border-ivory-300 ${
          docked ? "bg-ivory-50/95 shadow-float backdrop-blur" : "bg-ivory-50/70"
        }`}
      >
        {active.length > 0 && expanded ? (
          <div className="max-h-64 overflow-y-auto border-b border-ivory-300 px-5 py-4">
            <ul className="flex flex-col gap-3">
              {active.map(({ selectionId, recommendation, slot, status, guestCount }) => (
                <li key={selectionId}>
                  <p className="text-xs text-navy-400">
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

        {/* One compact row wherever the summary and button fit side by side; on a narrow
            phone the button wraps under the summary instead of squeezing it. */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:gap-6 sm:px-5 sm:py-4">
          <button
            type="button"
            onClick={() => active.length > 0 && setExpanded((v) => !v)}
            className={`flex min-w-0 flex-1 basis-56 items-center justify-between gap-3 text-left ${
              active.length > 0 ? "" : "cursor-default"
            }`}
          >
            <span className="min-w-0">
              <span className="hidden text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase sm:block">
                Your Felyn plan
              </span>
              <span className="block text-sm text-navy-700 sm:mt-0.5">
                {active.length === 0
                  ? "Add experiences to build your plan"
                  : `${active.length} experience${active.length === 1 ? "" : "s"} · ${formatCurrency(
                      estimatedTotal,
                      currency,
                    )} estimated total`}
              </span>
            </span>
            {active.length > 0 ? <span className="shrink-0 text-navy-400">{expanded ? "▾" : "▴"}</span> : null}
          </button>

          {items.length > 0 ? (
            <Button type="button" size="sm" className="w-full shrink-0 min-[30rem]:w-auto" onClick={onReview}>
              {draftCount > 0 ? `Review & request (${draftCount} new)` : "View your plan"}
            </Button>
          ) : null}
        </div>
        {items.length > 0 && hasConflicts ? (
          <p className="-mt-1 px-4 pb-3 text-xs font-medium text-gold-700 sm:px-5">
            ⚠ A scheduling conflict needs to be resolved
          </p>
        ) : null}
      </div>
    </div>
  );
}
