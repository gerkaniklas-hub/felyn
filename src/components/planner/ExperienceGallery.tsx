"use client";

import { useState } from "react";
import type { MatchedGalleryImage } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";
import { ExperienceGalleryViewer } from "./ExperienceGalleryViewer";

const GRID_HEIGHT = "h-72 sm:h-80 lg:h-96";

/**
 * The experience detail page's ONE unified photo gallery — replaces what
 * used to be a separate hero banner (always the primary image) followed by
 * a second, near-duplicate gallery section below it. Desktop shows a
 * cohesive grid whose shape adapts to how many photos exist (1 / 2 / 3+,
 * no empty slots ever); mobile shows a big primary image plus a compact
 * thumbnail strip. Tapping any image opens ExperienceGalleryViewer, the
 * full-screen next/prev/counter viewer, at that exact photo.
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

  if (deduped.length === 0) {
    return (
      <div className={`overflow-hidden rounded-2xl ${GRID_HEIGHT}`}>
        <FallbackImage src={null} alt={title} className="h-full w-full" />
      </div>
    );
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden sm:block">
        <GalleryGrid images={deduped} title={title} onOpen={setLightboxIndex} />
      </div>

      {/* Mobile: big primary + a compact, horizontally scrollable thumbnail strip. */}
      <div className="flex flex-col gap-2 sm:hidden">
        <button
          type="button"
          onClick={() => setLightboxIndex(0)}
          className="block w-full overflow-hidden rounded-2xl"
        >
          <FallbackImage
            src={deduped[0].image_url}
            alt={deduped[0].caption ?? title}
            className="aspect-[4/3] w-full"
          />
        </button>
        {deduped.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {deduped.map((image, index) => (
              <button
                key={`${image.image_url}-${index}`}
                type="button"
                onClick={() => setLightboxIndex(index)}
                aria-label={`View photo ${index + 1} of ${deduped.length}`}
                className="h-16 w-16 shrink-0 overflow-hidden rounded-lg"
              >
                <FallbackImage src={image.image_url} alt={image.caption ?? `${title} photo ${index + 1}`} className="h-full w-full" />
              </button>
            ))}
          </div>
        ) : null}
      </div>

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

function GalleryGrid({
  images,
  title,
  onOpen,
}: {
  images: MatchedGalleryImage[];
  title: string;
  onOpen: (index: number) => void;
}) {
  const tileProps = { images, title, onOpen };

  if (images.length === 1) {
    return <GalleryTile {...tileProps} image={images[0]} index={0} className="aspect-[16/9] w-full" />;
  }

  if (images.length === 2) {
    return (
      <div className={`grid grid-cols-[3fr_2fr] gap-2 ${GRID_HEIGHT}`}>
        <GalleryTile {...tileProps} image={images[0]} index={0} className="h-full w-full" />
        <GalleryTile {...tileProps} image={images[1]} index={1} className="h-full w-full" />
      </div>
    );
  }

  const overflowCount = images.length > 3 ? images.length - 3 : undefined;

  return (
    <div className={`grid grid-cols-2 grid-rows-2 gap-2 ${GRID_HEIGHT}`}>
      <GalleryTile {...tileProps} image={images[0]} index={0} className="row-span-2 h-full w-full" />
      <GalleryTile {...tileProps} image={images[1]} index={1} className="h-full w-full" />
      <GalleryTile {...tileProps} image={images[2]} index={2} className="h-full w-full" overlayCount={overflowCount} />
    </div>
  );
}

function GalleryTile({
  image,
  index,
  className,
  overlayCount,
  images,
  title,
  onOpen,
}: {
  image: MatchedGalleryImage;
  index: number;
  className: string;
  overlayCount?: number;
  images: MatchedGalleryImage[];
  title: string;
  onOpen: (index: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      aria-label={overlayCount ? `View all ${images.length} photos` : `View photo ${index + 1} of ${images.length}`}
      className={`relative overflow-hidden rounded-2xl ${className}`}
    >
      <FallbackImage src={image.image_url} alt={image.caption ?? `${title} photo ${index + 1}`} className="h-full w-full" />
      {overlayCount ? (
        <span className="absolute inset-0 flex items-center justify-center bg-navy-950/50 text-lg font-medium text-ivory-50">
          +{overlayCount} more
        </span>
      ) : null}
    </button>
  );
}
