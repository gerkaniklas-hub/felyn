"use client";

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
      aria-label="Booking confirmed"
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 py-10 sm:py-16"
    >
      <div className="w-full max-w-sm rounded-2xl border border-ivory-300 bg-ivory-50 p-6 shadow-xl">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-2xl text-sky-700">
            ✓
          </span>
          <Heading level={2}>Booking confirmed!</Heading>
          <p className="text-navy-700">
            You&apos;ve confirmed {experienceTitle} for {guestCount} guest{guestCount === 1 ? "" : "s"} at {stayName}.
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-left">
          <p className="text-xs font-medium tracking-wide text-navy-300">WHAT&apos;S NEXT</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-navy-700">
            <li>• The guest has been notified.</li>
            <li>• This booking is now in your calendar and upcoming bookings.</li>
            <li>• You&apos;ll be able to message the guest about it once conversations are available.</li>
          </ul>
        </div>

        <Button type="button" className="mt-5 w-full" onClick={onDone}>
          View booking details
        </Button>
      </div>
    </div>
  );
}
