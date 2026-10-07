"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  EXPERIENCE_IMAGES_BUCKET,
  experienceImagePathFromPublicUrl,
  isHostProfilePhotoPath,
} from "@/lib/storage/experience-images";
import { validateHostProfile, type HostProfileInput } from "./profile";

/**
 * A host editing their own public profile. Server Actions are reachable directly, so
 * every action first resolves the caller's OWN providers row from their session
 * (never from client input) and requires it to be approved ('verified'). Every write
 * then runs with that same session client — never a service-role client — so the
 * database enforces it again: 0030's column-limited UPDATE + "Approved hosts update
 * their own public profile" policy (only display_name, bio, base_location,
 * profile_photo_url; only their own row; the photo only from their own folder), and
 * 0002's owner policy on provider_languages.
 */

export type ProfileActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't save your profile. Please try again.";
const NOT_A_HOST = "Profile editing is available once your host profile is approved.";

type OwnHost = { supabase: SupabaseClient; providerId: string; photoUrl: string | null };

async function ownApprovedHost(): Promise<OwnHost | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("providers")
    .select("id, verification_status, profile_photo_url")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data || data.verification_status !== "verified") return null;
  return { supabase, providerId: data.id as string, photoUrl: (data.profile_photo_url as string | null) ?? null };
}

/** Name, location, "About you" and languages — saved together by "Save changes". */
export async function updateHostPublicProfile(input: HostProfileInput): Promise<ProfileActionResult> {
  const host = await ownApprovedHost();
  if (!host) return { ok: false, error: NOT_A_HOST };
  const { supabase, providerId } = host;

  const { data: languageRows, error: languagesReadError } = await supabase
    .from("provider_languages")
    .select("language")
    .eq("provider_id", providerId);
  if (languagesReadError) return { ok: false, error: GENERIC_ERROR };
  const currentLanguages = ((languageRows as { language: string }[] | null) ?? []).map((row) => row.language);

  const validation = validateHostProfile(input, currentLanguages);
  if (!validation.ok) return validation;
  const { displayName, bio, baseLocation, languages } = validation.values;

  const { data: updated, error: updateError } = await supabase
    .from("providers")
    .update({ display_name: displayName, bio, base_location: baseLocation })
    .eq("id", providerId)
    .select("id");
  if (updateError || !updated || updated.length !== 1) return { ok: false, error: GENERIC_ERROR };

  const toAdd = languages.filter((language) => !currentLanguages.includes(language));
  const toRemove = currentLanguages.filter((language) => !languages.includes(language));
  if (toAdd.length > 0) {
    const { error } = await supabase
      .from("provider_languages")
      .insert(toAdd.map((language) => ({ provider_id: providerId, language })));
    if (error) return { ok: false, error: "Your details were saved, but your languages couldn't be updated. Please try again." };
  }
  if (toRemove.length > 0) {
    const { error } = await supabase
      .from("provider_languages")
      .delete()
      .eq("provider_id", providerId)
      .in("language", toRemove);
    if (error) return { ok: false, error: "Your details were saved, but your languages couldn't be updated. Please try again." };
  }
  return { ok: true };
}

/**
 * Saves an already-uploaded profile photo (the browser uploads it to the host's own
 * "<provider_id>/profile/" folder first). If saving fails, the new file is deleted
 * again so nothing is left behind; once saved, the previous photo's file is removed.
 */
export async function setHostProfilePhoto(publicUrl: string): Promise<ProfileActionResult> {
  const host = await ownApprovedHost();
  if (!host) return { ok: false, error: NOT_A_HOST };
  const { supabase, providerId, photoUrl: previousUrl } = host;

  const newPath = experienceImagePathFromPublicUrl(publicUrl);
  if (!newPath || !isHostProfilePhotoPath(providerId, newPath)) {
    return { ok: false, error: "That photo can't be used. Please upload it again." };
  }

  const { data: updated, error } = await supabase
    .from("providers")
    .update({ profile_photo_url: publicUrl })
    .eq("id", providerId)
    .select("id");
  if (error || !updated || updated.length !== 1) {
    await supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).remove([newPath]);
    return { ok: false, error: "We couldn't save your new photo. Please try again." };
  }

  await removeOwnPhotoFile(supabase, providerId, previousUrl, newPath);
  return { ok: true };
}

/** Clears the profile photo, then removes its file (best effort). */
export async function removeHostProfilePhoto(): Promise<ProfileActionResult> {
  const host = await ownApprovedHost();
  if (!host) return { ok: false, error: NOT_A_HOST };
  const { supabase, providerId, photoUrl: previousUrl } = host;

  const { data: updated, error } = await supabase
    .from("providers")
    .update({ profile_photo_url: null })
    .eq("id", providerId)
    .select("id");
  if (error || !updated || updated.length !== 1) {
    return { ok: false, error: "We couldn't remove your photo. Please try again." };
  }

  await removeOwnPhotoFile(supabase, providerId, previousUrl, null);
  return { ok: true };
}

/**
 * Best-effort cleanup of a previous profile photo — only when it is a file in this
 * host's own profile folder (never a photo set by Felyn elsewhere) and not the one
 * just saved. A failure only leaves an unused file behind.
 */
async function removeOwnPhotoFile(
  supabase: SupabaseClient,
  providerId: string,
  previousUrl: string | null,
  keepPath: string | null,
): Promise<void> {
  if (!previousUrl) return;
  const previousPath = experienceImagePathFromPublicUrl(previousUrl);
  if (!previousPath || previousPath === keepPath || !isHostProfilePhotoPath(providerId, previousPath)) return;
  await supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).remove([previousPath]);
}
