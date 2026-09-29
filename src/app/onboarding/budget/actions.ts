"use server";

import { redirect } from "next/navigation";
import { BUDGET_OPTIONS } from "@/lib/onboarding/constants";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertGuestJourney } from "@/lib/journey-server";

export type ActionState = { error?: string };

export async function saveBudget(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertGuestJourney();
  const stayId = String(formData.get("stayId") ?? "");
  const value = String(formData.get("budget") ?? "");

  if (!stayId) {
    return { error: "Something went wrong. Please start over." };
  }

  const option = BUDGET_OPTIONS.find((o) => o.value === value);
  if (!option) {
    return { error: "Select a budget range." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("stays")
    .update({
      budget_min: option.min,
      budget_max: option.max,
      budget_flexible: option.flexible,
    })
    .eq("id", stayId);

  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/onboarding/review?stay=${stayId}`);
}
