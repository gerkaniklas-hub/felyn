"use client";

import { NO_TRIP_LINKED_LABEL } from "@/lib/matching/booking-status";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

/**
 * Confirmation success feedback (task 3) — shown only after
 * `confirmBookingRequestItem` has actually returned `ok: true` (see
 * RequestItemActions), never optimistically. The guest notification and
 * calendar/upcoming visibility are both real side effects of that same
 * successful update — the DB trigger from 0009 fires within the same
 * statement, so if this modal is showing, both already happened.
 */
export function BookingConfirmedModal({
  experienceTitle,
  guestCount,
  stayName,
  onDone,
}: {
  experienceTitle: string;
  guestCount: number;
  stayName: string;
  onDone: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Request accepted"
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-10 sm:py-16"
    >
      <div className="w-full max-w-sm rounded-card border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-2xl text-sky-700">
            ✓
          </span>
          <Heading level={2}>Request accepted</Heading>
          <p className="text-navy-700">
            You&apos;ve accepted {experienceTitle} for {guestCount} guest{guestCount === 1 ? "" : "s"}
            {stayName === NO_TRIP_LINKED_LABEL ? "" : ` at ${stayName}`}.
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-left">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-navy-400 uppercase">WHAT&apos;S NEXT</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-navy-700">
            <li>• The guest has been notified and asked to pay.</li>
            <li>• The time is reserved for them in your calendar until their payment deadline.</li>
            <li>• It becomes a confirmed booking once they pay; if they don&apos;t, the time is freed.</li>
          </ul>
        </div>

        <Button type="button" className="mt-5 w-full" onClick={onDone}>
          View booking details
        </Button>
      </div>
    </div>
  );
}
