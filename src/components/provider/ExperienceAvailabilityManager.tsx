"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addAvailabilityWindow,
  removeAvailabilityWindow,
  type AvailabilityFormState,
} from "@/lib/provider/experience-actions";
import type { ProviderExperienceAvailabilityWindow } from "@/lib/provider/experiences";

const initialState: AvailabilityFormState = {};

/**
 * Stage 3: simple MVP availability windows (0002's experience_availability
 * — "date windows an experience could potentially be offered in, not a
 * real provider calendar", per that table's own comment). Dates are plain
 * calendar dates; times, if given, are plain 'HH:MM' Tenerife-local
 * times-of-day — no timezone conversion, matching every other
 * date/time field in this app.
 */
export function ExperienceAvailabilityManager({
  experienceId,
  windows,
}: {
  experienceId: string;
  windows: ProviderExperienceAvailabilityWindow[];
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(addAvailabilityWindow, initialState);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // On a successful add, the new row only exists in `windows` (a server-
  // rendered prop) after a refresh — mirrors the router.refresh() pattern
  // every other mutating action in this app already uses.
  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);

  async function handleRemove(id: string) {
    setRemovingId(id);
    setRemoveError(null);
    const result = await removeAvailabilityWindow(id, experienceId);
    setRemovingId(null);
    if (!result.ok) {
      setRemoveError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {windows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-ivory-300 rounded-xl border border-ivory-300">
          {windows.map((window) => (
            <li key={window.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-sm">
                <p className="text-navy-900">
                  {window.availableFrom} → {window.availableUntil}
                </p>
                <p className="text-navy-500">
                  {window.startTime && window.endTime ? `${window.startTime}–${window.endTime}` : "All day"}
                  {window.maxBookings != null ? ` · max ${window.maxBookings} bookings` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={removingId === window.id}
                onClick={() => handleRemove(window.id)}
                className="text-sm font-medium text-navy-400 hover:text-red-600 disabled:opacity-40"
              >
                {removingId === window.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-navy-400">No availability windows yet — add at least one before publishing.</p>
      )}
      {removeError ? <p className="text-sm text-red-600">{removeError}</p> : null}

      <form
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-3 rounded-xl border border-dashed border-ivory-400 p-4"
      >
        <input type="hidden" name="experienceId" value={experienceId} />
        <p className="text-sm font-medium text-navy-700">Add a window</p>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Available from" name="availableFrom" type="date" required />
          <Input label="Available until" name="availableUntil" type="date" required />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Start time (optional)" name="startTime" type="time" />
          <Input label="End time (optional)" name="endTime" type="time" />
          <Input label="Max bookings (optional)" name="maxBookings" type="number" min={1} />
        </div>
        <p className="text-xs text-navy-400">Times are Tenerife local time. Leave both blank for an all-day window.</p>
        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={isPending}>
          {isPending ? "Adding…" : "Add window"}
        </Button>
      </form>
    </div>
  );
}
