import { Badge } from "@/components/ui/badge";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
  getRequestStatusCaption,
  getRequestStatusTone,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
} from "@/lib/matching/booking-status";

export type PlanStatusStage = "plan" | ActiveBookingRequestStatus;

const STEP_LABELS = ["Plan", "Request", "Confirmed"] as const;

/** Which step of STEP_LABELS is "done" (✓) vs "current" (●) vs "not yet" (○) for a given stage. */
function markersFor(stage: PlanStatusStage): ("done" | "current" | "pending")[] {
  if (stage === "plan") return ["current", "pending", "pending"];
  if (stage === "REQUESTED") return ["done", "current", "pending"];
  return ["done", "done", "current"];
}

/**
 * M7.2: a small, persistent "Plan → Request → Confirmed" progression —
 * a subtle hospitality status line, not a checkout wizard. Purely
 * presentational; StayPlanner decides the stage from the stay's active
 * booking request (or lack of one).
 */
export function PlanStatus({
  stage,
  itemStatuses,
}: {
  stage: PlanStatusStage;
  /** P1.1: when provided (once REQUESTED/CONFIRMED), overrides the caption with an honest per-item-derived one (e.g. "Partially confirmed") — never persisted, purely a display computation. */
  itemStatuses?: BookingItemStatus[];
}) {
  const markers = markersFor(stage);

  let caption: string | null = null;
  let tone: "gold" | "sky" | "navy" = "gold";
  if (stage !== "plan") {
    if (itemStatuses && itemStatuses.length > 0) {
      const aggregateStage = deriveAggregateItemStage(itemStatuses);
      caption = getAggregateItemStageCaption(aggregateStage);
      tone = getAggregateItemStageTone(aggregateStage);
    } else {
      caption = getRequestStatusCaption(stage as ActiveBookingRequestStatus);
      tone = getRequestStatusTone(stage as ActiveBookingRequestStatus);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* A small stepper: filled = done, ringed = where the plan is now, outlined = still to come. */}
      <ol className="flex items-center gap-2 text-xs font-medium">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            {i > 0 ? (
              <span
                aria-hidden="true"
                className={`h-px w-6 ${markers[i] === "pending" ? "bg-ivory-400" : "bg-navy-300"}`}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] leading-none ${
                markers[i] === "done"
                  ? "bg-navy-900 text-ivory-50"
                  : markers[i] === "current"
                    ? "border-[1.5px] border-sky-600 bg-ivory-50"
                    : "border border-ivory-400 bg-ivory-50"
              }`}
            >
              {markers[i] === "done" ? "✓" : markers[i] === "current" ? <span className="h-1.5 w-1.5 rounded-full bg-sky-600" /> : null}
            </span>
            <span className={markers[i] === "pending" ? "text-navy-400" : "text-navy-900"}>
              {label}
              <span className="sr-only">
                {markers[i] === "done" ? " (done)" : markers[i] === "current" ? " (current step)" : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {caption ? <Badge tone={tone}>{caption}</Badge> : null}
    </div>
  );
}
