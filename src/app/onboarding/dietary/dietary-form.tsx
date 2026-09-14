"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DIETARY_TYPES,
  DIETARY_TYPES_WITH_NOTES,
  type DietaryType,
} from "@/lib/onboarding/constants";
import type { StayDietaryRequirement } from "@/lib/onboarding/types";
import { saveDietary, type ActionState } from "./actions";

const initialState: ActionState = {};

export function DietaryForm({
  stayId,
  existing,
}: {
  stayId: string;
  existing: StayDietaryRequirement[];
}) {
  const [state, formAction, isPending] = useActionState(saveDietary, initialState);
  const [checked, setChecked] = useState<Set<DietaryType>>(
    () => new Set(existing.map((row) => row.type)),
  );

  function toggle(type: DietaryType) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="stayId" value={stayId} />
      {DIETARY_TYPES.map((option) => {
        const isChecked = checked.has(option.value);
        const row = existing.find((r) => r.type === option.value);

        return (
          <div key={option.value} className="rounded-xl border border-ivory-300 p-4">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                name="dietary"
                value={option.value}
                checked={isChecked}
                onChange={() => toggle(option.value)}
                className="h-4 w-4 accent-navy-900"
              />
              <span className="font-medium text-navy-900">{option.label}</span>
            </label>
            {isChecked && (
              <div className="mt-3 flex flex-col gap-3 pl-7">
                <Input
                  label="Number of guests"
                  name={`guestCount_${option.value}`}
                  type="number"
                  min={1}
                  defaultValue={row?.guest_count ?? undefined}
                  placeholder="e.g. 2"
                />
                {DIETARY_TYPES_WITH_NOTES.includes(option.value) && (
                  <Textarea
                    label={
                      option.value === "allergy"
                        ? "Please specify allergies"
                        : "Please specify"
                    }
                    name={`notes_${option.value}`}
                    defaultValue={row?.notes ?? ""}
                    rows={2}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
