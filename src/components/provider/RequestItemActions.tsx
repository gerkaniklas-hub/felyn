"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CancelReasonForm } from "@/components/booking/CancelReasonForm";
import { Button } from "@/components/ui/button";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  PROVIDER_CANCEL_REASONS,
  type BookingItemStatus,
  type CancelledBy,
  type CancelReason,
  type DeclineReason,
} from "@/lib/matching/booking-status";
import { cancelBookingRequestItemAsProvider, confirmBookingRequestItem, declineBookingRequestItem } from "@/lib/provider/actions";
import { BookingConfirmedModal } from "./BookingConfirmedModal";
import { DeclineReasonForm } from "./DeclineReasonForm";

type DecisionState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "confirmed" }
  | { status: "declining"; pending: boolean; error: string | null }
  | { status: "cancelling"; pending: boolean; error: string | null }
  | { status: "error"; message: string };

/**
 * P1.1/P1.2: the provider's Confirm/Decline for ONE booking_request_item —
 * used on the request detail page. Only ever touches this one item (see
 * lib/provider/actions.ts); never the parent booking_request's status.
 * Decline goes through the same structured-reason step as before. Confirm
 * now shows a success modal (task 3) ONLY once the server action has
 * actually returned ok — `router.refresh()` is deferred until the guest
 * dismisses it, so the page never flips to "Confirmed" behind the modal.
 *
 * Booking-lifecycle milestone: a CONFIRMED item is no longer a dead end —
 * the provider can cancel it (immediate, no acceptance step), through the
 * same structured-reason pattern as decline, using the provider-specific
 * reason list from booking-status.ts.
 */
export function RequestItemActions({
  itemId,
  status,
  declineReason,
  declineNote,
  cancelledBy,
  cancellationReason,
  cancellationNote,
  experienceTitle,
  guestCount,
  stayName,
}: {
  itemId: string;
  status: BookingItemStatus;
  declineReason?: DeclineReason | null;
  declineNote?: string | null;
  cancelledBy?: CancelledBy | null;
  cancellationReason?: CancelReason | null;
  cancellationNote?: string | null;
  /** Only needed for the post-confirm success modal's copy. */
  experienceTitle: string;
  guestCount: number;
  stayName: string;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<DecisionState>({ status: "idle" });

  if (status === "DECLINED") {
    const reasonLabel = getDeclineReasonLabel(declineReason ?? null);
    return (
      <div className="flex flex-col gap-1 text-sm text-navy-600">
        <p>You declined this experience.</p>
        {reasonLabel ? <p className="text-navy-500">Reason: {reasonLabel}</p> : null}
        {declineNote ? <p className="text-navy-500">&quot;{declineNote}&quot;</p> : null}
      </div>
    );
  }

  if (status === "CANCELLED") {
    const reasonLabel = getCancelReasonLabel(cancellationReason ?? null);
    return (
      <div className="flex flex-col gap-1 text-sm text-navy-600">
        <p>This experience was cancelled by {cancelledBy === "provider" ? "you" : "the guest"}.</p>
        {reasonLabel ? <p className="text-navy-500">Reason: {reasonLabel}</p> : null}
        {cancellationNote ? <p className="text-navy-500">&quot;{cancellationNote}&quot;</p> : null}
      </div>
    );
  }

  async function handleConfirm() {
    setDecision({ status: "confirming" });
    const result = await confirmBookingRequestItem(itemId);
    if (!result.ok) {
      setDecision({ status: "error", message: result.error });
      return;
    }
    setDecision({ status: "confirmed" });
  }

  function dismissConfirmed() {
    setDecision({ status: "idle" });
    router.refresh();
  }

  async function handleDecline(reason: DeclineReason, note: string) {
    setDecision({ status: "declining", pending: true, error: null });
    const result = await declineBookingRequestItem(itemId, reason, note);
    if (!result.ok) {
      setDecision({ status: "declining", pending: false, error: result.error });
      return;
    }
    router.refresh();
  }

  async function handleCancel(reason: CancelReason, note: string) {
    setDecision({ status: "cancelling", pending: true, error: null });
    const result = await cancelBookingRequestItemAsProvider(itemId, reason, note);
    if (!result.ok) {
      setDecision({ status: "cancelling", pending: false, error: result.error });
      return;
    }
    router.refresh();
  }

  if (decision.status === "confirmed") {
    return (
      <BookingConfirmedModal
        experienceTitle={experienceTitle}
        guestCount={guestCount}
        stayName={stayName}
        onDone={dismissConfirmed}
      />
    );
  }

  if (decision.status === "declining") {
    return (
      <DeclineReasonForm
        pending={decision.pending}
        error={decision.error}
        onCancel={() => setDecision({ status: "idle" })}
        onSubmit={handleDecline}
      />
    );
  }

  if (decision.status === "cancelling") {
    return (
      <CancelReasonForm
        reasons={PROVIDER_CANCEL_REASONS}
        pending={decision.pending}
        error={decision.error}
        onCancel={() => setDecision({ status: "idle" })}
        onSubmit={handleCancel}
      />
    );
  }

  if (status === "CONFIRMED") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-navy-600">You&apos;ve confirmed this experience for the guest.</p>
        <button
          type="button"
          onClick={() => setDecision({ status: "cancelling", pending: false, error: null })}
          className="self-start text-sm font-medium text-navy-400 hover:text-navy-700"
        >
          Cancel this experience
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {decision.status === "error" ? (
        <p className="rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">{decision.message}</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          className="flex-1"
          disabled={decision.status === "confirming"}
          onClick={handleConfirm}
        >
          {decision.status === "confirming" ? "Confirming…" : "Confirm"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          disabled={decision.status === "confirming"}
          onClick={() => setDecision({ status: "declining", pending: false, error: null })}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
