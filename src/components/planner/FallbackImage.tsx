"use client";

import { useState } from "react";

/**
 * M4b's seed image URLs deliberately point at `assets.felyn-demo.test` — a
 * name on the IANA-reserved `.test` TLD, guaranteed to never resolve. Left
 * to the browser, every one of these (there can be dozens, since the same
 * demo experience is reused as a card across many day sections) pays a
 * real, sometimes slow, DNS lookup before failing. Recognizing the
 * reserved TLD up front skips that request entirely and goes straight to
 * the same fallback tile `onError` would have produced anyway.
 */
function isKnownFakeDemoHost(src: string): boolean {
  try {
    return new URL(src).hostname.endsWith(".test");
  } catch {
    return false;
  }
}

/**
 * Rather than showing a broken-image icon (or trying to invent a real
 * remote URL), this renders a plain ivory tile whenever there's no image,
 * the image is a known-fake demo placeholder, or a real image URL fails to
 * load.
 */
export function FallbackImage({
  src,
  alt,
  className = "",
  fit = "cover",
}: {
  src: string | null;
  alt: string;
  className?: string;
  /** "cover" (default, unchanged everywhere existing) fills its box, cropping as needed. "contain" (the full-screen gallery viewer) shows the whole image, letterboxed if its aspect ratio doesn't match. */
  fit?: "cover" | "contain";
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed || isKnownFakeDemoHost(src)) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-ivory-200 to-ivory-400 ${className}`}
      >
        <span className="font-display text-sm text-navy-500">Felyn</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- demo asset URLs aren't on a configured next/image remote host
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={`${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
    />
  );
}
