"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CancelReasonForm } from "@/components/booking/CancelReasonForm";
import { cancelBookingRequestItemAsGuest } from "@/lib/matching/booking-requests";
import { GUEST_CANCEL_REASONS, type CancelReason } from "@/lib/matching/booking-status";

type State = { status: "idle" } | { status: "confirming" } | { status: "pending"; error: string | null };

/**
 * Booking-lifecycle milestone: the guest's cancellation entry point for a
 * CONFIRMED experience, rendered only from ExperienceStatusGroups (shared
 * by /experiences and /stays/[stayId]) — deliberately not duplicated into
 * the planner's RequestedItemCard. Calls the guest cancellation Server
 * Action directly, the same pattern RemoveStayButton/PlanReview already
 * use for deleteStay/withdrawBookingRequest.
 */
export function CancelExperienceButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(reason: CancelReason, note: string) {
    setState({ status: "pending", error: null });
    const result = await cancelBookingRequestItemAsGuest(itemId, reason, note);
    if (!result.ok) {
      setState({ status: "pending", error: result.error });
      return;
    }
    router.refresh();
  }

  if (state.status === "confirming" || state.status === "pending") {
    return (
      <CancelReasonForm
        reasons={GUEST_CANCEL_REASONS}
        pending={state.status === "pending"}
        error={state.status === "pending" ? state.error : null}
        onCancel={() => setState({ status: "idle" })}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setState({ status: "confirming" })}
      className="self-start text-sm font-medium text-navy-400 hover:text-navy-700"
    >
      Cancel experience
    </button>
  );
}
