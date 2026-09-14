"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { OCCASIONS } from "@/lib/onboarding/constants";
import { saveOccasions, type ActionState } from "./actions";

const initialState: ActionState = {};

export function OccasionForm({
  stayId,
  selected,
}: {
  stayId: string;
  selected: string[];
}) {
  const [state, formAction, isPending] = useActionState(saveOccasions, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="stayId" value={stayId} />
      <div className="flex flex-wrap gap-2">
        {OCCASIONS.map((occasion) => (
          <label key={occasion.value} className="cursor-pointer">
            <input
              type="checkbox"
              name="occasions"
              value={occasion.value}
              defaultChecked={selected.includes(occasion.value)}
              className="peer sr-only"
            />
            <span className="inline-flex rounded-full border border-ivory-400 bg-ivory-50 px-4 py-2 text-sm font-medium text-navy-700 transition-colors peer-checked:border-navy-900 peer-checked:bg-navy-900 peer-checked:text-ivory-50">
              {occasion.label}
            </span>
          </label>
        ))}
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
