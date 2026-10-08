"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

/**
 * Shown only after requestExperience has actually returned `ok: true` (see
 * RequestExperienceModal) — never on a validation or server error, and never
 * when the guest closes the form. Same card treatment as the other booking
 * success modals (BookingConfirmedModal, the planner's "request is on its
 * way"). Deliberately says nothing about payment yet.
 */
export function RequestSentModal({ onDone, onViewRequest }: { onDone: () => void; onViewRequest: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDone();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-10 sm:py-16">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-sent-title"
        aria-describedby="request-sent-description"
        className="w-full max-w-sm rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-2xl text-sky-700">
            ✓
          </span>
          <Heading level={2} id="request-sent-title">
            Request sent
          </Heading>
          <p id="request-sent-description" className="text-navy-700">
            Your experience request has been sent to the host.
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-left">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">What happens next</p>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-navy-700">
            <li>The host reviews your request.</li>
            <li>If they accept, you&apos;ll receive a confirmation.</li>
            <li>You&apos;ll then be able to continue with the booking.</li>
          </ol>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <Button type="button" className="w-full" autoFocus onClick={onDone}>
            Done
          </Button>
          <Button type="button" variant="secondary" className="w-full" onClick={onViewRequest}>
            View request
          </Button>
        </div>
      </div>
    </div>
  );
}
