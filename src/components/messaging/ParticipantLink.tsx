"use client";

import { useState } from "react";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { ProviderFocus } from "@/components/planner/ProviderFocus";
import { getProviderProfileAction } from "@/lib/matching/actions";
import type { ProviderProfile } from "@/lib/matching/provider-profile";

const SIZE_CLASS = { sm: "h-8 w-8", md: "h-9 w-9" } as const;

/**
 * The other participant's avatar + name, shared by the Messages inbox and
 * the floating chat header (task 7: "click the host's name/image to open
 * their profile"). Reuses the SAME existing mechanism the rest of Felyn
 * already uses to show a provider's public profile — ProviderFocus, opened
 * on demand via getProviderProfileAction — rather than a dedicated routed
 * page, since no such route exists anywhere in the app.
 *
 * When `providerId` is null (a provider viewing a guest's name — no guest
 * profile page exists anywhere in Felyn), this renders as plain, non-
 * interactive text rather than linking to something that doesn't exist.
 */
export function ParticipantLink({
  label,
  imageUrl,
  providerId,
  size = "md",
  className = "",
}: {
  label: string;
  imageUrl: string | null;
  providerId: string | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const [focus, setFocus] = useState<{ profile: ProviderProfile | "loading" | null } | null>(null);

  async function open() {
    if (!providerId) return;
    setFocus({ profile: "loading" });
    const profile = await getProviderProfileAction(providerId);
    setFocus({ profile });
  }

  const content = (
    <>
      <FallbackImage src={imageUrl} alt={label} className={`${SIZE_CLASS[size]} shrink-0 rounded-full`} />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );

  return (
    <>
      {providerId ? (
        <button
          type="button"
          onClick={open}
          className={`flex items-center gap-2 text-left hover:text-sky-700 ${className}`}
        >
          {content}
        </button>
      ) : (
        <span className={`flex items-center gap-2 text-navy-900 ${className}`}>{content}</span>
      )}

      {focus ? (
        <div className="fixed inset-0 z-[96] overflow-y-auto bg-ivory-100/95 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="mx-auto h-full max-w-lg">
            <ProviderFocus profile={focus.profile} providerName={label} onClose={() => setFocus(null)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
