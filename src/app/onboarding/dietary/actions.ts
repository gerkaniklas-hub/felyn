"use server";

import { redirect } from "next/navigation";
import type { DietaryType } from "@/lib/onboarding/constants";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string };

export async function saveDietary(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const stayId = String(formData.get("stayId") ?? "");
  if (!stayId) {
    return { error: "Something went wrong. Please start over." };
  }

  const selected = formData.getAll("dietary") as string[];

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  await supabase.from("stay_dietary_requirements").delete().eq("stay_id", stayId);

  if (selected.length > 0) {
    const rows = selected.map((type) => {
      const guestCountRaw = formData.get(`guestCount_${type}`);
      const notesRaw = formData.get(`notes_${type}`);
      const guestCount = guestCountRaw ? Number(guestCountRaw) : null;
      return {
        stay_id: stayId,
        user_id: user.id,
        type: type as DietaryType,
        guest_count: guestCount && guestCount > 0 ? guestCount : null,
        notes: notesRaw ? String(notesRaw).trim() || null : null,
      };
    });

    const { error } = await supabase.from("stay_dietary_requirements").insert(rows);
    if (error) {
      return { error: "Something went wrong. Please try again." };
    }
  }

  redirect(`/onboarding/budget?stay=${stayId}`);
}
