"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { BUDGET_OPTIONS } from "@/lib/onboarding/constants";
import { saveBudget, type ActionState } from "./actions";

const initialState: ActionState = {};

function currentValue(min: number | null, max: number | null, flexible: boolean) {
  if (flexible) return "flexible";
  const match = BUDGET_OPTIONS.find((o) => o.min === min && o.max === max);
  return match?.value ?? "";
}

export function BudgetForm({
  stayId,
  budgetMin,
  budgetMax,
  budgetFlexible,
}: {
  stayId: string;
  budgetMin: number | null;
  budgetMax: number | null;
  budgetFlexible: boolean;
}) {
  const [state, formAction, isPending] = useActionState(saveBudget, initialState);
  const selected = currentValue(budgetMin, budgetMax, budgetFlexible);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="stayId" value={stayId} />
      <div className="flex flex-col gap-2">
        {BUDGET_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-ivory-300 px-4 py-3 has-[:checked]:border-navy-900 has-[:checked]:bg-ivory-200"
          >
            <input
              type="radio"
              name="budget"
              value={option.value}
              defaultChecked={selected === option.value}
              className="h-4 w-4 accent-navy-900"
            />
            <span className="font-medium text-navy-900">{option.label}</span>
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
