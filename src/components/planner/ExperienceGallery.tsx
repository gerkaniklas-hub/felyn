"use client";

import { useState } from "react";
import type { MatchedGalleryImage } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";
import { ExperienceGalleryViewer } from "./ExperienceGalleryViewer";

/**
 * ONE primary photo across the top of the experience detail panel — 16:10
 * on a narrow panel, 2:1 wider, then a fixed 18–20rem band on a wide one
 * (its @container), so the experience details start above the fold. Always
 * cropped with object-cover so any upload sits in the same frame. When more than one photo exists, a
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
        className="group relative block aspect-[16/10] w-full overflow-hidden rounded-card disabled:cursor-default @xl:aspect-[2/1] @3xl:aspect-auto @3xl:h-72 @5xl:h-80"
      >
        <FallbackImage
          src={primary?.image_url ?? null}
          alt={primary?.caption ?? title}
          className="h-full w-full transition-transform duration-700 ease-out group-hover:scale-[1.02]"
        />
        {deduped.length > 1 ? (
          <span className="absolute right-3 bottom-3 rounded-full bg-navy-950/70 px-3 py-1.5 text-xs font-medium text-ivory-50 backdrop-blur-sm">
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
