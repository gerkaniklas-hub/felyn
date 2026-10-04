"use server";

import { redirect } from "next/navigation";
import { validatePhone } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeAccountDestination } from "./constants";
import { clearPendingSignupPhone, savePhoneNumber } from "./queries";

export type ContactPhoneFormState = {
  error?: string;
  errorField?: "country" | "number";
  /** Set after a successful save; changes on every save so the form can show "Saved." again. */
  savedAt?: number;
};

/**
 * Shared by the guest Profile and the host /provider/profile: one contact
 * record per account, whichever experience it is edited from. The number
 * is validated again here — the browser check is only for quick feedback.
 */
export async function saveContactPhone(
  _prevState: ContactPhoneFormState,
  formData: FormData,
): Promise<ContactPhoneFormState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const validation = validatePhone(String(formData.get("phoneCountry") ?? ""), String(formData.get("phoneNumber") ?? ""));
  if (!validation.ok) return { error: validation.error, errorField: validation.field };

  const result = await savePhoneNumber(supabase, user.id, validation);
  if (!result.ok) return { error: result.error, errorField: "number" };
  return { savedAt: Date.now() };
}

/**
 * The /account/mobile step: saves the number, then continues to the bound
 * destination (re-checked against the allow-list, never trusted as sent).
 */
export async function completeMobileStep(
  destination: string,
  _prevState: ContactPhoneFormState,
  formData: FormData,
): Promise<ContactPhoneFormState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const validation = validatePhone(String(formData.get("phoneCountry") ?? ""), String(formData.get("phoneNumber") ?? ""));
  if (!validation.ok) return { error: validation.error, errorField: validation.field };

  const result = await savePhoneNumber(supabase, user.id, validation);
  if (!result.ok) return { error: result.error, errorField: "number" };

  await clearPendingSignupPhone(supabase, user);
  redirect(safeAccountDestination(destination));
}
