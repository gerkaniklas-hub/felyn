"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CANCELLATION_NOTE_MAX_LENGTH, type CancelReason } from "@/lib/matching/booking-status";

/**
 * Booking-lifecycle milestone: the structured cancellation step shown when
 * a guest or host cancels an already-CONFIRMED experience — shared by both
 * sides (unlike DeclineReasonForm, which is provider-only) so the flow
 * stays in exactly one place, following the same visual pattern. The
 * caller supplies which reason list applies (GUEST_CANCEL_REASONS or
 * PROVIDER_CANCEL_REASONS, from booking-status.ts) — this component never
 * decides that itself.
 */
export function CancelReasonForm({
  reasons,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  reasons: { value: CancelReason; label: string }[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (reason: CancelReason, note: string) => void;
}) {
  const [reason, setReason] = useState<CancelReason>(reasons[0].value);
  const [note, setNote] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-navy-900">Why are you cancelling this experience?</p>
      <select
        value={reason}
        onChange={(event) => setReason(event.target.value as CancelReason)}
        className="h-11 rounded-xl border border-ivory-400 bg-ivory-50 px-3 text-sm text-navy-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
      >
        {reasons.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-navy-700">
        Additional note (optional)
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, CANCELLATION_NOTE_MAX_LENGTH))}
          rows={3}
          maxLength={CANCELLATION_NOTE_MAX_LENGTH}
          className="rounded-xl border border-ivory-400 bg-ivory-50 px-3 py-2 text-sm font-normal text-navy-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        />
        <span className="self-end text-xs font-normal text-navy-300">
          {note.length}/{CANCELLATION_NOTE_MAX_LENGTH}
        </span>
      </label>
      {error ? (
        <p className="rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" className="flex-1" onClick={onCancel} disabled={pending}>
          Keep experience
        </Button>
        <Button type="button" className="flex-1" onClick={() => onSubmit(reason, note)} disabled={pending}>
          {pending ? "Cancelling…" : "Cancel experience"}
        </Button>
      </div>
    </div>
  );
}
