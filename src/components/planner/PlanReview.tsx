"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { formatCurrency, formatDateRange } from "@/lib/format";
import { submitBookingRequest, withdrawBookingRequest } from "@/lib/matching/booking-requests";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
  getDeclineReasonLabel,
  getGuestItemStatusLabel,
  getItemStatusTone,
  type ActiveBookingRequestStatus,
} from "@/lib/matching/booking-status";
import { getPlannedMomentLabel, type PlannedMoment } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import { FallbackImage } from "./FallbackImage";
import type { PlanItem } from "./PlanSummary";

const MOMENT_ORDER: Record<PlannedMoment, number> = { morning: 0, afternoon: 1, evening: 2 };

export type ReviewStay = {
  id: string;
  property_name: string;
  location_text: string;
  check_in: string;
  check_out: string;
  guest_count: number;
};

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string }
  | {
      status: "success";
      itemCount: number;
      estimatedTotal: number;
      currency: string;
      addedToExistingRequest: boolean;
    };

type WithdrawState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "withdrawing" }
  | { status: "error"; message: string };

function bySlot(a: PlanItem, b: PlanItem): number {
  if (a.slot.date !== b.slot.date) return a.slot.date < b.slot.date ? -1 : 1;
  return MOMENT_ORDER[a.slot.moment] - MOMENT_ORDER[b.slot.moment];
}

function ReviewRow({
  item,
  currency,
  conflict,
  children,
}: {
  item: PlanItem;
  currency: string;
  conflict?: boolean;
  /** The row's actions. */
  children?: ReactNode;
}) {
  const { experience } = item.recommendation;
  const isMuted = item.status === "DECLINED" || item.status === "WITHDRAWN";
  return (
    <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-4">
        <FallbackImage
          src={experience.image_url}
          alt={experience.title}
          className={`h-16 w-16 shrink-0 rounded-xl ${isMuted ? "opacity-60" : ""}`}
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">
            {formatDayLabel(item.slot.date)} · {getPlannedMomentLabel(item.slot.moment)}
            {item.preferredTime
              ? item.status === "REQUESTED" || item.status === "DRAFT"
                ? ` · prefers ${item.preferredTime}`
                : ` · ${item.preferredTime}`
              : ""}
          </p>
          <p className={`truncate font-display text-base ${isMuted ? "text-navy-500" : "text-navy-950"}`}>
            {experience.title}
          </p>
          <p className="text-sm text-navy-500">{experience.provider.display_name}</p>
          {item.status !== "DRAFT" ? (
            <Badge tone={getItemStatusTone(item.status)} className="mt-1.5 w-fit">
              {getGuestItemStatusLabel(item.status)}
            </Badge>
          ) : null}
          {item.status === "DECLINED" && getDeclineReasonLabel(item.declineReason) ? (
            <p className="mt-1 text-sm text-navy-500">{getDeclineReasonLabel(item.declineReason)}</p>
          ) : null}
          {item.hostNote && !isMuted ? (
            <p className="mt-1 line-clamp-2 break-words text-sm text-navy-500">Note: {item.hostNote}</p>
          ) : null}
          {conflict ? (
            <p className="mt-1.5 w-fit rounded-full bg-gold-100 px-2.5 py-1 text-xs font-medium text-gold-700">
              ⚠ Same date &amp; moment as another experience
            </p>
          ) : null}
          {children ? <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">{children}</div> : null}
        </div>
      </div>
      {!isMuted ? (
        <p className="shrink-0 text-sm text-navy-700">
          {item.guestCount} guest{item.guestCount === 1 ? "" : "s"} · {formatCurrency(item.pricePerPerson, currency)} pp ·{" "}
          <span className="font-medium">{formatCurrency(item.pricePerPerson * item.guestCount, currency)}</span>
        </p>
      ) : null}
    </div>
  );
}

const linkClass = "w-fit text-sm font-medium text-sky-600 hover:text-sky-700";
const quietClass = "w-fit text-sm font-medium text-navy-500 hover:text-navy-900";

/**
 * The plan review — one screen for everything in the guest's plan, whether
 * or not a request already exists: NEW items not yet requested (editable),
 * items already requested/confirmed (status only; awaiting ones can be
 * withdrawn, confirmed ones are locked), and a history of declined/
 * withdrawn ones (with a way back to discovery for that slot). Submitting
 * sends ONLY the new items; the server adds them to the stay's existing
 * request when there is one (see submitBookingRequest), so nothing already
 * requested or confirmed is ever re-sent or reset.
 */
export function PlanReview({
  stay,
  items,
  requestedTotal,
  draftTotal,
  currency,
  conflictingIds,
  activeRequest,
  onEditDraft,
  onRemoveDraft,
  onClose,
  onSubmitted,
  onWithdrawn,
  onWithdrawItem,
  onExplore,
}: {
  stay: ReviewStay;
  /** Every item — drafts, requested/confirmed, and declined/withdrawn history. */
  items: PlanItem[];
  /** The active request's server-computed total (0 when there is none). */
  requestedTotal: number;
  draftTotal: number;
  currency: string;
  /** Selection ids sharing an exact date+moment with another occupying selection — see plan.ts. */
  conflictingIds: Set<string>;
  activeRequest: { id: string; status: ActiveBookingRequestStatus } | null;
  onEditDraft: (selectionId: string) => void;
  onRemoveDraft: (selectionId: string) => void;
  onClose: () => void;
  /** Called once, right after items are successfully requested, so the caller can clear the now-requested drafts. */
  onSubmitted: () => void;
  /** Called once a whole-request withdrawal is confirmed. */
  onWithdrawn: () => void;
  /** Opens the individual-withdrawal confirmation for one REQUESTED item. */
  onWithdrawItem: (selectionId: string) => void;
  /** Selects that date+moment and opens discovery for it. */
  onExplore: (date: string, moment: PlannedMoment) => void;
}) {
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const [withdraw, setWithdraw] = useState<WithdrawState>({ status: "idle" });

  const drafts = items.filter((item) => item.status === "DRAFT").sort(bySlot);
  const requested = items.filter((item) => item.status === "REQUESTED" || item.status === "CONFIRMED").sort(bySlot);
  const history = items.filter((item) => item.status === "DECLINED" || item.status === "WITHDRAWN").sort(bySlot);
  const hasConflicts = drafts.some((item) => conflictingIds.has(item.selectionId));

  async function handleSubmit() {
    if (drafts.length === 0 || hasConflicts || submission.status === "submitting") return;
    setSubmission({ status: "submitting" });
    const result = await submitBookingRequest(
      stay.id,
      drafts.map((item) => ({
        experienceId: item.recommendation.experience.id,
        plannedDate: item.slot.date,
        plannedMoment: item.slot.moment,
        guestCount: item.guestCount,
        preferredTime: item.preferredTime,
        hostNote: item.hostNote.trim() === "" ? null : item.hostNote,
      })),
    );
    if (!result.ok) {
      setSubmission({ status: "error", message: result.error });
      return;
    }
    setSubmission({
      status: "success",
      itemCount: result.itemCount,
      estimatedTotal: result.estimatedTotal,
      currency: result.currency,
      addedToExistingRequest: result.addedToExistingRequest,
    });
    onSubmitted();
  }

  async function handleWithdraw() {
    if (!activeRequest) return;
    setWithdraw({ status: "withdrawing" });
    const result = await withdrawBookingRequest(activeRequest.id);
    if (!result.ok) {
      setWithdraw({ status: "error", message: result.error });
      return;
    }
    onWithdrawn();
  }

  if (submission.status === "success") {
    return (
      <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-8 sm:py-12">
        <div className="w-full max-w-lg rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl sm:p-8">
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Heading level={2}>
              {submission.addedToExistingRequest ? "Added to your request" : "Your request is on its way"}
            </Heading>
            <p className="max-w-sm text-navy-500">
              Your request has been sent. The host reviews{" "}
              {submission.addedToExistingRequest ? "your new experiences" : "your experiences"}, and if they accept,
              you&apos;ll receive a confirmation — you can keep adding more in the meantime.
            </p>

            <div className="mt-3 w-full max-w-sm rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-left">
              <p className="font-display text-base text-navy-950">{stay.property_name}</p>
              <p className="text-sm text-navy-500">{stay.location_text}</p>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm text-navy-700">
                <span>
                  {submission.itemCount} new experience{submission.itemCount === 1 ? "" : "s"}
                </span>
                <span className="text-right font-medium">
                  {formatCurrency(submission.estimatedTotal, submission.currency)} plan total
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-gold-700">Pending confirmation</p>
            </div>

            <Button type="button" className="mt-2 w-full sm:w-auto" onClick={onClose}>
              Back to your plan
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (activeRequest && (withdraw.status === "confirming" || withdraw.status === "withdrawing" || withdraw.status === "error")) {
    return (
      <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-8 sm:py-12">
        <div className="w-full max-w-md rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl sm:p-8">
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <Heading level={3}>Withdraw this request?</Heading>
            <p className="text-navy-500">
              Your whole current request will be cancelled and your plan will become editable again. You can then
              submit a new request.
            </p>
            {withdraw.status === "error" ? (
              <p className="w-full rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
                {withdraw.message}
              </p>
            ) : null}
            <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <Button
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={withdraw.status === "withdrawing"}
                onClick={() => setWithdraw({ status: "idle" })}
              >
                Keep request
              </Button>
              <Button
                type="button"
                className="w-full sm:w-auto"
                disabled={withdraw.status === "withdrawing"}
                onClick={handleWithdraw}
              >
                {withdraw.status === "withdrawing" ? "Withdrawing…" : "Withdraw request"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const aggregateStage = activeRequest
    ? deriveAggregateItemStage(requested.concat(history).map((item) => (item.status === "DRAFT" ? "REQUESTED" : item.status)))
    : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-8 sm:py-12">
      <div className="w-full max-w-2xl rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">YOUR FELYN PLAN</p>
            <Heading level={2} className="mt-1">
              {stay.property_name}
            </Heading>
            <p className="text-sm text-navy-500">{stay.location_text}</p>
            <p className="text-sm text-navy-500">
              {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guest
              {stay.guest_count === 1 ? "" : "s"}
            </p>
            {aggregateStage ? (
              <Badge tone={getAggregateItemStageTone(aggregateStage)} className="mt-2">
                {getAggregateItemStageCaption(aggregateStage)}
              </Badge>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-11 shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
          >
            Close
          </button>
        </div>

        {drafts.length + requested.length + history.length === 0 ? (
          <p className="mt-6 border-y border-ivory-300 py-8 text-center text-navy-500">
            Your plan is empty — close this and choose a few experiences first.
          </p>
        ) : null}

        {drafts.length > 0 ? (
          <section className="mt-6">
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">
              {activeRequest ? "NEW — NOT YET REQUESTED" : "READY TO REQUEST"}
            </p>
            <div className="mt-1 flex flex-col divide-y divide-ivory-300 border-y border-ivory-300">
              {drafts.map((item) => (
                <ReviewRow
                  key={item.selectionId}
                  item={item}
                  currency={currency}
                  conflict={conflictingIds.has(item.selectionId)}
                >
                  <button type="button" onClick={() => onEditDraft(item.selectionId)} className={linkClass}>
                    Edit
                  </button>
                  <button type="button" onClick={() => onRemoveDraft(item.selectionId)} className={quietClass}>
                    Remove
                  </button>
                </ReviewRow>
              ))}
            </div>
          </section>
        ) : null}

        {requested.length > 0 ? (
          <section className="mt-6">
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">YOUR REQUEST</p>
            <div className="mt-1 flex flex-col divide-y divide-ivory-300 border-y border-ivory-300">
              {requested.map((item) => (
                <ReviewRow key={item.selectionId} item={item} currency={currency} conflict={conflictingIds.has(item.selectionId)}>
                  {item.status === "REQUESTED" ? (
                    <button type="button" onClick={() => onWithdrawItem(item.selectionId)} className={quietClass}>
                      Withdraw request
                    </button>
                  ) : null}
                </ReviewRow>
              ))}
            </div>
          </section>
        ) : null}

        {history.length > 0 ? (
          <section className="mt-6">
            <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">DECLINED &amp; WITHDRAWN</p>
            <div className="mt-1 flex flex-col divide-y divide-ivory-300 border-y border-ivory-300">
              {history.map((item) => (
                <ReviewRow key={item.selectionId} item={item} currency={currency}>
                  <button type="button" onClick={() => onExplore(item.slot.date, item.slot.moment)} className={linkClass}>
                    {item.status === "DECLINED" ? "Explore alternatives →" : "Explore experiences →"}
                  </button>
                </ReviewRow>
              ))}
            </div>
          </section>
        ) : null}

        {hasConflicts ? (
          <p className="mt-4 rounded-xl bg-gold-100 px-3 py-2 text-center text-sm font-medium text-gold-700 sm:text-left">
            ⚠ Two or more experiences share the same date and moment. Remove one or change its time of day before
            requesting.
          </p>
        ) : null}

        {submission.status === "error" ? (
          <p className="mt-4 rounded-xl bg-gold-100 px-3 py-2 text-center text-sm font-medium text-gold-700 sm:text-left">
            {submission.message}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-center text-sm text-navy-700 sm:text-left">
            {activeRequest ? (
              <p>{formatCurrency(requestedTotal, currency)} requested so far</p>
            ) : null}
            {drafts.length > 0 ? (
              <p>
                {drafts.length} new experience{drafts.length === 1 ? "" : "s"} · +{formatCurrency(draftTotal, currency)}
              </p>
            ) : null}
            <p className="font-medium">
              {formatCurrency(requestedTotal + draftTotal, currency)} estimated total
            </p>
          </div>
          {drafts.length > 0 ? (
            <Button
              type="button"
              className="w-full sm:w-auto"
              disabled={hasConflicts || submission.status === "submitting"}
              onClick={handleSubmit}
            >
              {submission.status === "submitting"
                ? "Requesting…"
                : activeRequest
                  ? `Request ${drafts.length} more experience${drafts.length === 1 ? "" : "s"}`
                  : "Request these experiences"}
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-center text-xs text-navy-300 sm:text-left">
          This is an estimated total, not a confirmed booking — requested times are preferences until the host
          confirms, and payment comes in a later milestone.
        </p>

        {activeRequest ? (
          <div className="mt-4 border-t border-ivory-300 pt-3 text-center sm:text-right">
            <Button type="button" variant="ghost" size="sm" onClick={() => setWithdraw({ status: "confirming" })}>
              Withdraw entire request
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
