"use client";

import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { formatPrice } from "@/lib/format";
import type { ProviderProfile } from "@/lib/matching/provider-profile";
import { FallbackImage } from "./FallbackImage";

/**
 * Layer 3 of the Stay Planner's master/detail view. Only RLS-safe public
 * data reaches here (see getProviderProfile) — no user_id, no internal
 * ids, no verification_status. `profile` is `"loading"` while the on-demand
 * fetch is in flight, `null` if the provider has no public profile.
 */
export function ProviderFocus({
  profile,
  providerName,
  onClose,
  unavailableMessage = "We couldn't load this provider right now.",
}: {
  profile: ProviderProfile | "loading" | null;
  providerName: string;
  onClose: () => void;
  /** Shown when `profile` is null. Guest views keep the default; a host previewing their own profile passes a "not public yet" explanation. */
  unavailableMessage?: string;
}) {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto rounded-2xl border border-ivory-300 bg-ivory-50 p-6 sm:p-8">
      <button
        type="button"
        onClick={onClose}
        className="self-start text-sm font-medium text-sky-600 hover:text-sky-700"
      >
        ← Back to experience
      </button>

      {profile === "loading" || profile === null ? (
        <div className="flex flex-1 items-center justify-center text-center text-sm text-navy-500">
          {profile === "loading"
            ? `Loading ${providerName}'s story…`
            : unavailableMessage}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <FallbackImage
              src={profile.profile_photo_url}
              alt={profile.display_name}
              className="h-20 w-20 shrink-0 rounded-full"
            />
            <div>
              <Heading level={2}>{profile.display_name}</Heading>
              {profile.base_location ? <p className="text-sm text-navy-500">{profile.base_location}</p> : null}
            </div>
          </div>

          {profile.bio ? <p className="text-navy-700">{profile.bio}</p> : null}

          {profile.languages.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">LANGUAGES</p>
              <p className="text-navy-700">{profile.languages.join(" · ")}</p>
            </div>
          ) : null}

          {profile.specialties.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">SPECIALTIES</p>
              <div className="flex flex-wrap gap-2">
                {profile.specialties.map((specialty) => (
                  <Badge key={specialty} tone="gold">
                    {specialty.replace(/[-_]/g, " ")}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {profile.gallery.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">GALLERY</p>
              <div className="grid grid-cols-3 gap-2">
                {profile.gallery.map((image, i) => (
                  <FallbackImage
                    key={i}
                    src={image.image_url}
                    alt={image.caption ?? profile.display_name}
                    className="aspect-square rounded-lg"
                  />
                ))}
              </div>
            </div>
          ) : null}

          {profile.otherExperiences.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">OTHER EXPERIENCES</p>
              <ul className="flex flex-col gap-2">
                {profile.otherExperiences.map((exp) => (
                  <li
                    key={exp.id}
                    className="flex items-center justify-between rounded-lg bg-ivory-200 px-4 py-3 text-sm"
                  >
                    <span className="text-navy-900">{exp.title}</span>
                    <span className="text-navy-500">{formatPrice(exp.price_per_person, exp.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
