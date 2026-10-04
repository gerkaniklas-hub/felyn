import type { SupabaseClient, User } from "@supabase/supabase-js";
import { validatePhone } from "@/lib/phone";
import { PENDING_PHONE_COUNTRY_KEY, PENDING_PHONE_NUMBER_KEY } from "./constants";

/**
 * The account's canonical contact record (public.user_contact_details,
 * 0027). The only place Felyn stores a guest's or host's phone number.
 * RLS limits every query here to the signed-in user's own row.
 */
export type ContactDetails = {
  /** E.164, e.g. "+4915123456789". Format it for display; don't show it raw. */
  phoneNumber: string;
  /** ISO country the user picked, e.g. "DE". */
  phoneCountry: string;
  /** Always null for now: SMS verification isn't built yet. */
  phoneVerifiedAt: string | null;
};

export type SavePhoneResult = { ok: true } | { ok: false; error: string };

const UNIQUE_VIOLATION = "23505";
export const PHONE_IN_USE_ERROR =
  "This mobile number is already linked to another Felyn account. Please use a different number.";
const GENERIC_ERROR = "We couldn't save your mobile number. Please try again.";

/** Throws on a read error, so a failed read is never mistaken for "no number yet". */
export async function getContactDetails(supabase: SupabaseClient, userId: string): Promise<ContactDetails | null> {
  const { data, error } = await supabase
    .from("user_contact_details")
    .select("phone_number, phone_country, phone_verified_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getContactDetails failed (code ${error.code})`);
  if (!data) return null;
  return { phoneNumber: data.phone_number, phoneCountry: data.phone_country, phoneVerifiedAt: data.phone_verified_at };
}

/**
 * Creates or updates the user's contact record. `phone` must come from
 * validatePhone() run on the server — callers never pass raw form input.
 * Update-then-insert rather than upsert: the client may only update
 * phone_number/phone_country (0027), and an upsert would also try to set
 * user_id.
 */
export async function savePhoneNumber(
  supabase: SupabaseClient,
  userId: string,
  phone: { e164: string; country: string },
): Promise<SavePhoneResult> {
  const values = { phone_number: phone.e164, phone_country: phone.country };

  const { data: updated, error: updateError } = await supabase
    .from("user_contact_details")
    .update(values)
    .eq("user_id", userId)
    .select("user_id");
  if (updateError) return toSaveError(updateError);
  if (updated && updated.length > 0) return { ok: true };

  const { error: insertError } = await supabase.from("user_contact_details").insert({ user_id: userId, ...values });
  if (!insertError) return { ok: true };
  // Created at the same moment by another request (e.g. two tabs): update it instead.
  if (insertError.code === UNIQUE_VIOLATION && insertError.message.includes("user_contact_details_pkey")) {
    const { error: retryError } = await supabase.from("user_contact_details").update(values).eq("user_id", userId);
    return retryError ? toSaveError(retryError) : { ok: true };
  }
  return toSaveError(insertError);
}

function toSaveError(error: { code?: string; message: string }): SavePhoneResult {
  if (error.code === UNIQUE_VIOLATION && error.message.includes("user_contact_details_phone_number_key")) {
    return { ok: false, error: PHONE_IN_USE_ERROR };
  }
  console.error(`savePhoneNumber failed (code ${error.code ?? "unknown"})`);
  return { ok: false, error: GENERIC_ERROR };
}

export type PendingSignupPhone =
  | { status: "none" }
  | { status: "saved" }
  | { status: "failed"; error: string; country: string; number: string };

/**
 * Moves the number entered at signup (held in user_metadata until the
 * account had a session, see constants.ts) into user_contact_details,
 * re-validating it first: user_metadata is user-editable, so it is treated
 * as untrusted input like any form. On success the pending keys are cleared.
 */
export async function savePendingSignupPhone(supabase: SupabaseClient, user: User): Promise<PendingSignupPhone> {
  const meta = user.user_metadata ?? {};
  const number = typeof meta[PENDING_PHONE_NUMBER_KEY] === "string" ? meta[PENDING_PHONE_NUMBER_KEY] : "";
  const country = typeof meta[PENDING_PHONE_COUNTRY_KEY] === "string" ? meta[PENDING_PHONE_COUNTRY_KEY] : "";
  if (!number && !country) return { status: "none" };

  const validation = validatePhone(country, number);
  if (!validation.ok) return { status: "failed", error: validation.error, country, number };

  const result = await savePhoneNumber(supabase, user.id, validation);
  if (!result.ok) return { status: "failed", error: result.error, country, number };

  await clearPendingSignupPhone(supabase, user);
  return { status: "saved" };
}

/** Best effort: once the contact record exists the pending keys are ignored anyway. */
export async function clearPendingSignupPhone(supabase: SupabaseClient, user: User): Promise<void> {
  const meta = user.user_metadata ?? {};
  if (meta[PENDING_PHONE_NUMBER_KEY] == null && meta[PENDING_PHONE_COUNTRY_KEY] == null) return;
  const { error } = await supabase.auth.updateUser({
    data: { [PENDING_PHONE_NUMBER_KEY]: null, [PENDING_PHONE_COUNTRY_KEY]: null },
  });
  if (error) console.error(`clearPendingSignupPhone failed (code ${error.code ?? "unknown"})`);
}
