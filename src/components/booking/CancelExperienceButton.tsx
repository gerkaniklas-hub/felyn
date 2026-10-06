"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CancelReasonForm } from "@/components/booking/CancelReasonForm";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { cancelBookingRequestItemAsGuest } from "@/lib/matching/booking-requests";
import { GUEST_CANCEL_REASONS, type CancelReason } from "@/lib/matching/booking-status";

type State = { status: "idle" } | { status: "confirming" } | { status: "pending"; error: string | null } | { status: "success" };

/**
 * Phase 8 of the consolidated improvements: the guest's cancellation entry
 * point for a CONFIRMED experience (rendered by GuestExperienceRow and the
 * booking detail page). Previously called router.refresh() the instant the
 * server action resolved, with no visible confirmation at all — this now
 * waits for the server's actual result, shows a dedicated success modal
 * only once cancellation is confirmed, and only refreshes the surrounding
 * page (clearing the cancelled item from any "active confirmed" view)
 * after the guest dismisses it. Cancellation itself — policy, reason
 * requirements, permissions, the 30-day messaging window — is entirely
 * unchanged; this only fixes what happens in the UI after a successful
 * call to the existing cancelBookingRequestItemAsGuest action.
 */
export function CancelExperienceButton({ itemId, stayId }: { itemId: string; stayId?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(reason: CancelReason, note: string) {
    setState({ status: "pending", error: null });
    const result = await cancelBookingRequestItemAsGuest(itemId, reason, note);
    if (!result.ok) {
      setState({ status: "pending", error: result.error });
      return;
    }
    setState({ status: "success" });
  }

  function dismissSuccess() {
    setState({ status: "idle" });
    router.refresh();
  }

  if (state.status === "success") {
    return (
      <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
        <div className="w-full max-w-sm rounded-card border border-ivory-300 bg-ivory-50 p-6 text-center shadow-xl">
          <Heading level={3}>Your cancellation is confirmed.</Heading>
          <p className="mt-3 text-sm text-navy-600">
            Your experience has been cancelled. You can explore other experiences for your stay.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Button type="button" className="w-full" onClick={() => router.push("/explore")}>
              Explore experiences
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => (stayId ? router.push(`/stays/${stayId}`) : dismissSuccess())}
            >
              Back to My Trips
            </Button>
          </div>
        </div>
      </div>
    );
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
