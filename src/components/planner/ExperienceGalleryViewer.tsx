"use client";

import { useEffect, useRef } from "react";
import type { MatchedGalleryImage } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";

const SWIPE_THRESHOLD_PX = 40;

/**
 * Full-screen gallery viewer, opened from ExperienceGallery. Next/previous,
 * a visible "N of M" counter, Escape/click-outside/× to close, arrow-key
 * navigation on desktop, and swipe navigation on mobile — all built with
 * plain React/touch events (no carousel library is installed in this
 * project, and this is simple enough not to need one).
 */
export function ExperienceGalleryViewer({
  images,
  title,
  index,
  onIndexChange,
  onClose,
}: {
  images: MatchedGalleryImage[];
  title: string;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const touchStartX = useRef<number | null>(null);

  const goPrev = () => onIndexChange((index - 1 + images.length) % images.length);
  const goNext = () => onIndexChange((index + 1) % images.length);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") goPrev();
      else if (event.key === "ArrowRight") goNext();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goPrev/goNext close over `index`, which is already a dependency via re-running this effect on every render they'd change.
  }, [index, images.length, onClose]);

  if (images.length === 0) return null;
  const active = images[index];

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-navy-950/95"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} photos`}
      onClick={onClose}
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        if (touchStartX.current == null) return;
        const delta = e.changedTouches[0].clientX - touchStartX.current;
        if (delta > SWIPE_THRESHOLD_PX) goPrev();
        else if (delta < -SWIPE_THRESHOLD_PX) goNext();
        touchStartX.current = null;
      }}
    >
      <div className="flex items-center justify-between px-4 py-4 text-ivory-50 sm:px-6">
        <span className="text-sm font-medium">
          {index + 1} of {images.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close gallery"
          className="text-2xl leading-none text-ivory-50 hover:text-ivory-200"
        >
          ×
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-2 pb-4" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 ? (
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous photo"
            className="absolute left-2 z-10 hidden h-11 w-11 items-center justify-center rounded-full bg-ivory-50/10 text-2xl text-ivory-50 hover:bg-ivory-50/20 sm:flex"
          >
            ‹
          </button>
        ) : null}

        <div className="flex h-full max-h-[80vh] w-full max-w-5xl items-center justify-center">
          <FallbackImage
            src={active.image_url}
            alt={active.caption ?? `${title} photo ${index + 1}`}
            fit="contain"
            className="max-h-full max-w-full rounded-lg"
          />
        </div>

        {images.length > 1 ? (
          <button
            type="button"
            onClick={goNext}
            aria-label="Next photo"
            className="absolute right-2 z-10 hidden h-11 w-11 items-center justify-center rounded-full bg-ivory-50/10 text-2xl text-ivory-50 hover:bg-ivory-50/20 sm:flex"
          >
            ›
          </button>
        ) : null}
      </div>
    </div>
  );
}
