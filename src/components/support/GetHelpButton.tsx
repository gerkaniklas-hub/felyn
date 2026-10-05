"use client";

import Link from "next/link";
import { useState } from "react";
import type { SupportRequesterRole } from "@/lib/support/constants";
import { getSupportConversationHref } from "@/lib/support/inbox";
import { ContactFelynForm } from "./ContactFelynForm";

/**
 * A booking's "Get help" — for the guest (/bookings/[itemId], default) or the host
 * (/provider/requests/[itemId], requesterRole "host"). The booking is attached
 * automatically — they only pick a topic and write. If they already have an
 * open conversation with the Felyn Team about this booking, Get help simply
 * opens it in Messages instead of starting another (the database would reuse it
 * anyway). `initialOpen` supports "Contact Felyn again" from a closed conversation.
 */
export function GetHelpButton({
  bookingItemId,
  booking,
  existingThreadId,
  initialOpen = false,
  requesterRole = "guest",
}: {
  bookingItemId: string;
  booking: { experienceTitle: string; dateLabel: string; timeLabel: string; guestCount: number };
  existingThreadId: string | null;
  initialOpen?: boolean;
  requesterRole?: SupportRequesterRole;
}) {
  const [open, setOpen] = useState(initialOpen && !existingThreadId);

  const triggerClass =
    "inline-flex h-9 items-center justify-center self-start rounded-full border border-navy-300 px-4 text-sm font-medium text-navy-900 transition-colors hover:bg-ivory-200";

  if (existingThreadId) {
    return (
      <div className="flex flex-col gap-1">
        <Link href={getSupportConversationHref(existingThreadId, requesterRole)} className={triggerClass}>
          Get help
        </Link>
        <p className="text-xs text-navy-500">You&apos;re already talking to the Felyn Team about this booking.</p>
      </div>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClass}>
        Get help
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-navy-950/40 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="get-help-title"
        >
          <div className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-3xl bg-ivory-50 p-6 shadow-xl sm:rounded-3xl sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium tracking-wide text-navy-300 uppercase">Talk to Felyn</p>
                <h2 id="get-help-title" className="mt-1 font-display text-2xl text-navy-950">
                  Get help with this booking
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-full p-2 text-navy-500 hover:bg-ivory-200"
              >
                <span aria-hidden="true" className="text-xl leading-none">
                  ×
                </span>
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-ivory-300 bg-ivory-100 px-4 py-3">
              <p className="font-medium text-navy-900">{booking.experienceTitle}</p>
              <p className="mt-0.5 text-sm text-navy-500">
                {booking.dateLabel} · {booking.timeLabel} · {booking.guestCount}{" "}
                {booking.guestCount === 1 ? "guest" : "guests"}
              </p>
            </div>

            <div className="mt-6">
              <ContactFelynForm
                bookingItemId={bookingItemId}
                defaultCategory="booking"
                onCancel={() => setOpen(false)}
                requesterRole={requesterRole}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
