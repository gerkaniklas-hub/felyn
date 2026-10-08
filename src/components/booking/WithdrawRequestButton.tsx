"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { withdrawBookingRequestItem } from "@/lib/matching/booking-requests";

/**
 * A compact outlined pill like the other secondary actions, tinted as the
 * destructive booking action so it never reads like "Get help" (support) or
 * like the page's primary action.
 */
const WITHDRAW_TRIGGER_CLASS =
  "inline-flex h-9 items-center justify-center self-start rounded-full border border-red-200 bg-ivory-50 px-4 text-sm font-medium text-red-700 transition-colors hover:border-red-300 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory-100";

type State = { status: "idle" } | { status: "confirming"; error: string | null } | { status: "pending" } | { status: "withdrawn" };

/**
 * The guest's "Withdraw request" for ONE still-REQUESTED experience on its
 * booking detail page — the same transition the stay planner already offers
 * (withdrawBookingRequestItem -> the 0031 database function
 * booking_item_withdraw, REQUESTED -> WITHDRAWN). The page renders this only
 * while the item is REQUESTED; the database refuses any other state anyway.
 * A confirmation dialog comes first, so a request is never withdrawn by one
 * stray tap. On success the page is refreshed, so it shows WITHDRAWN and no
 * longer offers this action.
 */
export function WithdrawRequestButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = state.status === "confirming" || state.status === "pending";

  // Escape keeps the request (the safe choice, which also gets focus when the dialog opens).
  const pending = state.status === "pending";
  useEffect(() => {
    if (!open || pending) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setState({ status: "idle" });
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  function keepRequest() {
    setState({ status: "idle" });
    triggerRef.current?.focus();
  }

  async function confirmWithdraw() {
    setState({ status: "pending" });
    const result = await withdrawBookingRequestItem(itemId);
    if (!result.ok) {
      setState({ status: "confirming", error: result.error });
      return;
    }
    setState({ status: "withdrawn" });
    router.refresh();
  }

  if (state.status === "withdrawn") return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setState({ status: "confirming", error: null })}
        className={WITHDRAW_TRIGGER_CLASS}
      >
        Withdraw request
      </button>

      {open ? (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-16">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="withdraw-request-title"
            aria-describedby="withdraw-request-description"
            className="w-full max-w-md rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl"
          >
            <Heading level={3} id="withdraw-request-title">
              Withdraw request?
            </Heading>
            <p id="withdraw-request-description" className="mt-3 text-sm text-navy-500">
              Are you sure you want to withdraw this experience request? The host will no longer be able to accept it.
            </p>
            {state.status === "confirming" && state.error ? (
              <p role="alert" className="mt-3 rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">
                {state.error}
              </p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button
                autoFocus
                type="button"
                variant="secondary"
                className="w-full sm:flex-1"
                disabled={state.status === "pending"}
                onClick={keepRequest}
              >
                Keep request
              </Button>
              <Button
                type="button"
                className="w-full sm:flex-1"
                disabled={state.status === "pending"}
                onClick={confirmWithdraw}
              >
                {state.status === "pending" ? "Withdrawing…" : "Withdraw request"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
