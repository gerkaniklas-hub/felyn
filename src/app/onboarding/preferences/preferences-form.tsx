"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { savePreferences, type ActionState } from "./actions";

const initialState: ActionState = {};

export function PreferencesForm({
  stayId,
  rawText,
}: {
  stayId: string;
  rawText: string | null;
}) {
  const [state, formAction, isPending] = useActionState(savePreferences, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="stayId" value={stayId} />
      <Textarea
        label="Tell us in your own words"
        name="rawText"
        defaultValue={rawText ?? ""}
        placeholder="We're eight friends looking for something relaxed for our first evening. Two people are vegetarian and we'd like to spend around €60 per person."
        rows={5}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
