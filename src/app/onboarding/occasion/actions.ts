"use server";

import { redirect } from "next/navigation";
import type { Occasion } from "@/lib/onboarding/constants";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string };

export async function saveOccasions(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const stayId = String(formData.get("stayId") ?? "");
  const occasions = formData.getAll("occasions") as string[];

  if (!stayId) {
    return { error: "Something went wrong. Please start over." };
  }
  if (occasions.length === 0) {
    return { error: "Select at least one option." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  await supabase.from("stay_occasions").delete().eq("stay_id", stayId);

  const rows = occasions.map((occasion) => ({
    stay_id: stayId,
    user_id: user.id,
    occasion: occasion as Occasion,
  }));

  const { error } = await supabase.from("stay_occasions").insert(rows);
  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/onboarding/preferences?stay=${stayId}`);
}
