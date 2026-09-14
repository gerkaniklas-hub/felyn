"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string };

export async function saveStay(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const stayId = String(formData.get("stayId") ?? "").trim();
  const propertyName = String(formData.get("propertyName") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  const checkIn = String(formData.get("checkIn") ?? "").trim();
  const checkOut = String(formData.get("checkOut") ?? "").trim();
  const guestCount = Number(formData.get("guestCount") ?? "");

  if (!propertyName || !location || !checkIn || !checkOut) {
    return { error: "Please fill in every field." };
  }
  if (!Number.isInteger(guestCount) || guestCount < 1) {
    return { error: "Enter a valid number of guests." };
  }
  if (checkOut <= checkIn) {
    return { error: "Check-out must be after check-in." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const payload = {
    user_id: user.id,
    property_name: propertyName,
    location_text: location,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    source: "manual" as const,
  };

  let id = stayId;

  if (stayId) {
    const { error } = await supabase.from("stays").update(payload).eq("id", stayId);
    if (error) {
      return { error: "Something went wrong. Please try again." };
    }
  } else {
    const { data, error } = await supabase
      .from("stays")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) {
      return { error: "Something went wrong. Please try again." };
    }
    id = data.id as string;
  }

  redirect(`/onboarding/confirm-stay?stay=${id}`);
}
