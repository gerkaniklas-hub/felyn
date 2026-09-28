"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function completeOnboarding(formData: FormData) {
  const stayId = String(formData.get("stayId") ?? "");
  if (!stayId) {
    redirect("/onboarding/add-stay");
  }

  const supabase = await createSupabaseServerClient();
  await supabase
    .from("stays")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", stayId);

  redirect(`/recommendations?stay=${stayId}`);
}
