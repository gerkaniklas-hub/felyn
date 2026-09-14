"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string };

export async function savePreferences(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const stayId = String(formData.get("stayId") ?? "");
  const rawText = String(formData.get("rawText") ?? "").trim();

  if (!stayId) {
    return { error: "Something went wrong. Please start over." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase
    .from("stay_preferences")
    .upsert(
      { stay_id: stayId, user_id: user.id, raw_text: rawText || null },
      { onConflict: "stay_id" },
    );

  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/onboarding/dietary?stay=${stayId}`);
}
