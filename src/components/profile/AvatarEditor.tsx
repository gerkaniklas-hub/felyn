"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  avatarPathForUser,
} from "@/lib/storage/avatars";

type State = { status: "idle" | "pending" } | { status: "error"; message: string };

/**
 * Milestone 1: profile photo upload/change/removal against the private
 * "avatars" bucket (0015). Uploads go straight from the browser to Supabase
 * Storage using the guest's own session — bucket-level RLS (owner-only) and
 * the bucket's own file_size_limit/allowed_mime_types are the real
 * enforcement boundary; the checks here are only for immediate feedback.
 *
 * Only the storage PATH is ever stored (in user_metadata.avatar_path) — the
 * bucket is private, so there is no public URL to store. The page that
 * renders this component is responsible for turning that path into a
 * signed URL server-side on each load (see getSignedAvatarUrl).
 */
export function AvatarEditor({
  userId,
  initialSignedUrl,
}: {
  userId: string;
  initialSignedUrl: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialSignedUrl);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    if (!AVATAR_ALLOWED_TYPES.includes(file.type)) {
      setState({ status: "error", message: "Please choose a JPEG, PNG, or WebP image." });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setState({ status: "error", message: "That image is larger than 5MB. Please choose a smaller one." });
      return;
    }

    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const path = avatarPathForUser(userId);

    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) {
      setState({ status: "error", message: "We couldn't upload that photo. Please try again." });
      return;
    }

    const { error: metadataError } = await supabase.auth.updateUser({ data: { avatar_path: path } });
    if (metadataError) {
      setState({ status: "error", message: "Your photo uploaded, but we couldn't save it to your profile." });
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    setState({ status: "idle" });
    router.refresh();
  }

  async function handleRemove() {
    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const path = avatarPathForUser(userId);

    await supabase.storage.from(AVATAR_BUCKET).remove([path]);
    const { error } = await supabase.auth.updateUser({ data: { avatar_path: null } });
    if (error) {
      setState({ status: "error", message: "We couldn't remove your photo. Please try again." });
      return;
    }

    setPreviewUrl(null);
    setState({ status: "idle" });
    router.refresh();
  }

  return (
    <div className="flex items-center gap-4">
      <FallbackImage src={previewUrl} alt="Your profile photo" className="h-20 w-20 shrink-0 rounded-full" />
      <div className="flex flex-col gap-2">
        <div className="flex gap-3">
          <button
            type="button"
            disabled={state.status === "pending"}
            onClick={() => inputRef.current?.click()}
            className="text-sm font-medium text-sky-600 hover:text-sky-700 disabled:opacity-40"
          >
            {previewUrl ? "Change photo" : "Add photo"}
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
          accept={AVATAR_ALLOWED_TYPES.join(",")}
          onChange={handleFileChange}
          className="hidden"
        />
        {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
        <p className="text-xs text-navy-400">JPEG, PNG, or WebP · up to 5MB</p>
      </div>
    </div>
  );
}
