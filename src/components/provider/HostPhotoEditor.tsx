"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { removeHostProfilePhoto, setHostProfilePhoto } from "@/lib/provider/profile-actions";
import {
  EXPERIENCE_IMAGE_ALLOWED_TYPES,
  EXPERIENCE_IMAGE_MAX_BYTES,
  EXPERIENCE_IMAGES_BUCKET,
  hostProfilePhotoPath,
} from "@/lib/storage/experience-images";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type State = { status: "idle" | "pending" } | { status: "error"; message: string };

/**
 * The host's public profile photo — the same look and behaviour as the guest
 * AvatarEditor (change/remove right away, no separate save), but stored where guests
 * can see it: the public experience-images bucket, in the host's own
 * "<provider_id>/profile/" folder (0022's storage policies only let a host write
 * there). The browser uploads under a new name; setHostProfilePhoto then saves it and
 * removes the old file — or deletes the new file again if saving fails.
 */
export function HostPhotoEditor({
  providerId,
  photoUrl,
  displayName,
}: {
  providerId: string;
  photoUrl: string | null;
  displayName: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(photoUrl);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    if (!EXPERIENCE_IMAGE_ALLOWED_TYPES.includes(file.type)) {
      setState({ status: "error", message: "Please choose a JPEG, PNG, or WebP image." });
      return;
    }
    if (file.size > EXPERIENCE_IMAGE_MAX_BYTES) {
      setState({ status: "error", message: "That image is larger than 5MB. Please choose a smaller one." });
      return;
    }

    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const path = hostProfilePhotoPath(providerId, file.type);
    const { error: uploadError } = await supabase.storage
      .from(EXPERIENCE_IMAGES_BUCKET)
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      setState({ status: "error", message: "We couldn't upload that photo. Please try again." });
      return;
    }

    const { data } = supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).getPublicUrl(path);
    const result = await setHostProfilePhoto(data.publicUrl);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }

    setPreviewUrl(data.publicUrl);
    setState({ status: "idle" });
    router.refresh();
  }

  async function handleRemove() {
    setState({ status: "pending" });
    const result = await removeHostProfilePhoto();
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setPreviewUrl(null);
    setState({ status: "idle" });
    router.refresh();
  }

  return (
    <div className="flex items-center gap-4">
      <FallbackImage src={previewUrl} alt={displayName} className="h-20 w-20 shrink-0 rounded-full" />
      <div className="flex flex-col gap-2">
        <div className="flex gap-3">
          <button
            type="button"
            disabled={state.status === "pending"}
            onClick={() => inputRef.current?.click()}
            className="text-sm font-medium text-sky-600 hover:text-sky-700 disabled:opacity-40"
          >
            {state.status === "pending" ? "Saving…" : previewUrl ? "Change photo" : "Add photo"}
          </button>
          {previewUrl ? (
            <button
              type="button"
              disabled={state.status === "pending"}
              onClick={handleRemove}
              className="text-sm font-medium text-navy-400 hover:text-navy-700 disabled:opacity-40"
            >
              Remove
            </button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={EXPERIENCE_IMAGE_ALLOWED_TYPES.join(",")}
          onChange={handleFileChange}
          className="hidden"
        />
        {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
        <p className="text-xs text-navy-400">JPEG, PNG, or WebP · up to 5MB</p>
      </div>
    </div>
  );
}
