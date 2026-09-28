/**
 * Stage 3: host experience-photo storage (0022's "experience-images"
 * bucket). Unlike avatars.ts (private bucket, signed URLs), this bucket is
 * PUBLIC — the returned public URL is what gets written straight into
 * experience_gallery.image_url, exactly like the app already renders any
 * other image_url value (see FallbackImage / explore.ts / hard-filter.ts).
 */
export const EXPERIENCE_IMAGES_BUCKET = "experience-images";
export const EXPERIENCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const EXPERIENCE_IMAGE_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Path convention: "<provider_id>/<experience_id>/<random>.<ext>" — see
 * 0022's own header comment for why the first segment is the OWNING
 * PROVIDER's id (what the bucket's RLS actually checks), not the
 * experience id. providerId must be the caller's own resolved provider id
 * (never trust a client-supplied one for anything security-relevant) —
 * this function only builds a path string, it enforces nothing itself.
 */
export function experienceImagePath(providerId: string, experienceId: string, mimeType: string): string {
  const ext = EXTENSION_BY_TYPE[mimeType] ?? "jpg";
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${providerId}/${experienceId}/${randomId}.${ext}`;
}

/**
 * Recovers the storage object path from a public URL previously returned
 * by getPublicUrl for this bucket, so a gallery removal can also best-
 * effort delete the underlying object. Returns null for anything that
 * doesn't look like one of this bucket's own public URLs — notably the
 * seed data's fake `https://assets.felyn-demo.test/...` image_url values
 * (see FallbackImage's own handling of that same reserved-TLD placeholder
 * scheme), which were never uploaded here and have no object to delete.
 * Never throws — a failed parse just means "nothing to clean up".
 */
export function experienceImagePathFromPublicUrl(url: string): string | null {
  const marker = `/object/public/${EXPERIENCE_IMAGES_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = url.slice(index + marker.length);
  return path.length > 0 ? path : null;
}
