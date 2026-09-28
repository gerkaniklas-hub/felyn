"use client";

import { useState } from "react";
import type { MatchedGalleryImage } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";
import { ExperienceGalleryViewer } from "./ExperienceGalleryViewer";

/**
 * Option B (compact, restrained photo presentation — supersedes an earlier,
 * larger grid layout that didn't fit Felyn's premium-but-understated design
 * or the likely photo quality/quantity at this early marketplace stage).
 *
 * ONE compact primary photo, the same restrained dimensions used for the
 * discovery card (ExperienceCard's own aspect-[4/3]) — photos stay
 * visually secondary to the title/description/host/booking information
 * around them, never a dominant hero. When more than one photo exists, a
 * small "View N photos" pill is the only other affordance; tapping either
 * the photo or the pill opens the SAME full-screen ExperienceGalleryViewer
 * lightbox (next/prev/counter/keyboard/touch) reused as-is.
 *
 * Images are de-duplicated by URL defensively — this only ever guards
 * against a data artifact, gallery data usually has no duplicates.
 */
export function ExperienceGallery({ images, title }: { images: MatchedGalleryImage[]; title: string }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const deduped: MatchedGalleryImage[] = [];
  const seenUrls = new Set<string>();
  for (const image of images) {
    if (seenUrls.has(image.image_url)) continue;
    seenUrls.add(image.image_url);
    deduped.push(image);
  }

  const primary = deduped[0] ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => deduped.length > 0 && setLightboxIndex(0)}
        disabled={deduped.length === 0}
        aria-label={deduped.length > 0 ? `View photos of ${title}` : undefined}
        className="relative block aspect-[4/3] w-full max-w-xs overflow-hidden rounded-2xl disabled:cursor-default"
      >
        <FallbackImage src={primary?.image_url ?? null} alt={primary?.caption ?? title} className="h-full w-full" />
        {deduped.length > 1 ? (
          <span className="absolute right-2 bottom-2 rounded-full bg-navy-950/70 px-2.5 py-1 text-xs font-medium text-ivory-50">
            View {deduped.length} photos
          </span>
        ) : null}
      </button>

      {lightboxIndex != null ? (
        <ExperienceGalleryViewer
          images={deduped}
          title={title}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </>
  );
}
