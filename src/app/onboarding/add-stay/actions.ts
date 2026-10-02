"use server";

import { redirect } from "next/navigation";
import { assertGuestJourney } from "@/lib/journey-server";
import { getLocation, getLocationDisplayText } from "@/lib/locations";
import { getCanonicalLocations } from "@/lib/matching/explore";
import { getStay } from "@/lib/onboarding/queries";
import { validateStayDates, type CheckOutError } from "@/lib/onboarding/stay-dates";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; checkOutError?: CheckOutError; locationError?: string };

/**
 * Saves the simplified Add a stay form (create, or edit with `stayId`).
 * The stay is the context for exploring, so this is the whole journey: no
 * occasion, dietary, budget or preference steps. It completes the stay
 * straight away (onboarding_completed_at) so it shows on Trips and the
 * stay page as before.
 *
 * Location must be a canonical location (public.locations), re-checked here
 * against the database rather than trusted from the form. It's stored as
 * stays.location_id, with its readable full name also written to
 * location_text, which the planner and existing screens still read.
 * property_name stays NOT NULL in the database: left empty, it falls back
 * to the location's name.
 */
export async function saveStay(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await assertGuestJourney();

  const stayId = String(formData.get("stayId") ?? "").trim();
  const propertyNameInput = String(formData.get("propertyName") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim();
  const checkIn = String(formData.get("checkIn") ?? "").trim();
  const checkOut = String(formData.get("checkOut") ?? "").trim();
  const guestCount = Number(formData.get("guestCount") ?? "");

  if (!locationId) {
    return { locationError: "Choose where you're staying from the list." };
  }
  if (!checkIn || !checkOut) {
    return { error: "Add your check-in and check-out dates." };
  }
  if (!Number.isInteger(guestCount) || guestCount < 1) {
    return { error: "Enter a valid number of guests." };
  }
  const checkOutError = validateStayDates(checkIn, checkOut);
  if (checkOutError) {
    return { checkOutError };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const locations = await getCanonicalLocations(supabase);
  const location = getLocation(locations, locationId);
  if (!location) {
    return { locationError: "We couldn't find that location. Please choose it again from the list." };
  }

  const payload = {
    user_id: user.id,
    property_name: propertyNameInput || location.name,
    location_id: location.id,
    location_text: getLocationDisplayText(locations, location),
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    source: "manual" as const,
  };

  let id = stayId;
  if (stayId) {
    // RLS-scoped: null for a stay that isn't this guest's.
    const existing = await getStay(supabase, stayId);
    if (!existing) {
      return { error: "We couldn't find this stay." };
    }
    const { error } = await supabase
      .from("stays")
      .update({ ...payload, onboarding_completed_at: existing.onboarding_completed_at ?? new Date().toISOString() })
      .eq("id", stayId);
    if (error) {
      return { error: "Something went wrong. Please try again." };
    }
  } else {
    const { data, error } = await supabase
      .from("stays")
      .insert({ ...payload, onboarding_completed_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error || !data) {
      return { error: "Something went wrong. Please try again." };
    }
    id = data.id as string;
  }

  redirect(`/onboarding/stay-ready?stay=${id}`);
}
