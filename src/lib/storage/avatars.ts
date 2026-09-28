import type { SupabaseClient } from "@supabase/supabase-js";

export const AVATAR_BUCKET = "avatars";
export const AVATAR_SIGNED_URL_TTL_SECONDS = 300;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Fixed, extension-less path — one object per guest (see 0015's own comment for why). */
export function avatarPathForUser(userId: string): string {
  return `${userId}/avatar`;
}

/**
 * Server-side only: the avatars bucket is private (0015), so a photo can
 * only ever be shown via a short-lived signed URL generated fresh on each
 * render — never a public URL. createSignedUrl still goes through the
 * bucket's own RLS, so a path outside the caller's own "<user_id>/..."
 * folder simply fails rather than resolving to another guest's photo.
 */
export async function getSignedAvatarUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}
