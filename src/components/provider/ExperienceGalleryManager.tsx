"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { FallbackImage } from "@/components/planner/FallbackImage";
import {
  addExperienceGalleryImage,
  removeExperienceGalleryImage,
  reorderExperienceGalleryImage,
} from "@/lib/provider/experience-actions";
import type { ProviderExperienceGalleryImage } from "@/lib/provider/experiences";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  EXPERIENCE_IMAGES_BUCKET,
  EXPERIENCE_IMAGE_ALLOWED_TYPES,
  EXPERIENCE_IMAGE_MAX_BYTES,
  experienceImagePath,
} from "@/lib/storage/experience-images";

type State = { status: "idle" | "uploading" | "busy" } | { status: "error"; message: string };

/**
 * Stage 3: photo upload/preview/reorder/removal for one experience's
 * gallery. The upload itself goes straight from the browser to the new
 * "experience-images" bucket (0022) using the host's own session — bucket
 * RLS (owner-only, folder-scoped by provider id) and the bucket's own
 * file_size_limit/allowed_mime_types are the real enforcement boundary;
 * the checks here are only for immediate feedback, exactly like
 * AvatarEditor's own upload path. Only after a successful upload is the
 * experience_gallery DB row created, via the addExperienceGalleryImage
 * server action (ownership-checked again there, independent of storage
 * RLS).
 */
export function ExperienceGalleryManager({
  providerId,
  experienceId,
  images,
}: {
  providerId: string;
  experienceId: string;
  images: ProviderExperienceGalleryImage[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ status: "idle" });

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

    setState({ status: "uploading" });
    const supabase = createSupabaseBrowserClient();
    const path = experienceImagePath(providerId, experienceId, file.type);

    const { error: uploadError } = await supabase.storage
      .from(EXPERIENCE_IMAGES_BUCKET)
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      setState({ status: "error", message: "We couldn't upload that photo. Please try again." });
      return;
    }

    const { data: publicUrlData } = supabase.storage.from(EXPERIENCE_IMAGES_BUCKET).getPublicUrl(path);
    const result = await addExperienceGalleryImage(experienceId, publicUrlData.publicUrl);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }

    setState({ status: "idle" });
    router.refresh();
  }

  async function handleRemove(image: ProviderExperienceGalleryImage) {
    setState({ status: "busy" });
    const result = await removeExperienceGalleryImage(image.id, experienceId, image.imageUrl);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "idle" });
    router.refresh();
  }

  async function handleReorder(imageId: string, direction: "up" | "down") {
    setState({ status: "busy" });
    const result = await reorderExperienceGalleryImage(experienceId, imageId, direction);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "idle" });
    router.refresh();
  }

  const busy = state.status === "uploading" || state.status === "busy";

  return (
    <div className="flex flex-col gap-3">
      {images.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image, index) => (
            <div key={image.id} className="flex flex-col gap-1.5">
              <FallbackImage
                src={image.imageUrl}
                alt={image.caption ?? "Experience photo"}
                className="aspect-square w-full rounded-xl"
              />
              <div className="flex items-center justify-between gap-1 text-xs">
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    onClick={() => handleReorder(image.id, "up")}
                    className="font-medium text-navy-500 hover:text-navy-900 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === images.length - 1}
                    onClick={() => handleReorder(image.id, "down")}
                    className="font-medium text-navy-500 hover:text-navy-900 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleRemove(image)}
                  className="font-medium text-navy-400 hover:text-red-600 disabled:opacity-30"
                >
                  Remove
                </button>
              </div>
              {index === 0 ? <p className="text-xs text-sky-700">Primary photo</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-navy-400">No photos yet — add at least one before publishing.</p>
      )}

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="text-sm font-medium text-sky-600 hover:text-sky-700 disabled:opacity-40"
        >
          {state.status === "uploading" ? "Uploading…" : "Add photo"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={EXPERIENCE_IMAGE_ALLOWED_TYPES.join(",")}
          onChange={handleFileChange}
          className="hidden"
        />
        {state.status === "error" ? <p className="mt-1 text-sm text-red-600">{state.message}</p> : null}
        <p className="mt-1 text-xs text-navy-400">JPEG, PNG, or WebP · up to 5MB each</p>
      </div>
    </div>
  );
}
