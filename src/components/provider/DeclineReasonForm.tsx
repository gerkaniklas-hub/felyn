"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DECLINE_REASONS, type DeclineReason } from "@/lib/matching/booking-status";

/**
 * P1.2: the structured decline step shown after a provider clicks
 * "Decline" — shared by the calendar modal and the request detail page so
 * the flow (and the reason list) stay in exactly one place.
 */
export function DeclineReasonForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (reason: DeclineReason, note: string) => void;
}) {
  const [reason, setReason] = useState<DeclineReason>(DECLINE_REASONS[0].value);
  const [note, setNote] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-navy-900">Why are you declining this request?</p>
      <select
        value={reason}
        onChange={(event) => setReason(event.target.value as DeclineReason)}
        className="h-11 rounded-full border border-ivory-400 bg-ivory-50 px-4 text-sm text-navy-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
      >
        {DECLINE_REASONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-navy-700">
        Additional note (optional)
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          className="rounded-card border border-ivory-400 bg-ivory-50 px-3 py-2 text-sm font-normal text-navy-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        />
      </label>
      {error ? (
        <p className="rounded-xl bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" className="flex-1" onClick={onCancel} disabled={pending}>
          Keep request
        </Button>
        <Button type="button" className="flex-1" onClick={() => onSubmit(reason, note)} disabled={pending}>
          {pending ? "Declining…" : "Decline request"}
        </Button>
      </div>
    </div>
  );
}
