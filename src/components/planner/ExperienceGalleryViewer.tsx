"use client";

import { useState } from "react";
import { FallbackImage } from "./FallbackImage";
import type { MatchedGalleryImage } from "@/lib/matching/hard-filter";

/**
 * Guest-facing gallery for the experience detail panel (ExperienceFocus,
 * shared by both the planner and Explore — see that component's own
 * comment). A large image with a thumbnail strip beneath it, no external
 * carousel library (none is installed in this project). Renders nothing
 * for 0 or 1 images — ExperienceFocus's own hero banner already covers
 * that case, so this component only adds value once there's more than one
 * photo to browse.
 */
export function ExperienceGalleryViewer({ images, title }: { images: MatchedGalleryImage[]; title: string }) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (images.length <= 1) return null;

  const active = images[Math.min(activeIndex, images.length - 1)];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-navy-300">PHOTOS</p>
      <div className="overflow-hidden rounded-xl">
        <FallbackImage
          src={active.image_url}
          alt={active.caption ?? title}
          className="aspect-[4/3] w-full sm:aspect-video"
        />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((image, index) => (
          <button
            key={`${image.image_url}-${index}`}
            type="button"
            onClick={() => setActiveIndex(index)}
            aria-label={`View photo ${index + 1} of ${images.length}`}
            aria-current={index === activeIndex}
            className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg transition-opacity ${
              index === activeIndex ? "opacity-100 ring-2 ring-sky-500" : "opacity-70 hover:opacity-100"
            }`}
          >
            <FallbackImage src={image.image_url} alt={image.caption ?? `${title} photo ${index + 1}`} className="h-full w-full" />
          </button>
        ))}
      </div>
    </div>
  );
}
