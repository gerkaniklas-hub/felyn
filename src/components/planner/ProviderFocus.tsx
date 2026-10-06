"use client";

import { Badge } from "@/components/ui/badge";
import { MapPinIcon } from "@/components/navigation/icons";
import { Heading } from "@/components/ui/heading";
import { Eyebrow } from "@/components/ui/page";
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
    <div className="flex h-full flex-col gap-8 overflow-y-auto rounded-panel border border-ivory-300 bg-ivory-50 p-5 sm:p-8 lg:p-10">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex h-11 items-center self-start text-sm font-medium text-sky-600 hover:text-sky-700"
      >
        ← Back to experience
      </button>

      {profile === "loading" || profile === null ? (
        <div className="flex flex-1 items-center justify-center py-12 text-center text-sm text-navy-500">
          {profile === "loading"
            ? `Loading ${providerName}'s story…`
            : unavailableMessage}
        </div>
      ) : (
        <>
          <div className="flex flex-col items-start gap-5 border-b border-ivory-300 pb-8">
            <Eyebrow>Host</Eyebrow>
            <FallbackImage
              src={profile.profile_photo_url}
              alt={profile.display_name}
              className="h-24 w-24 shrink-0 rounded-full border-4 border-ivory-50 shadow-float sm:h-28 sm:w-28"
            />
            <div className="min-w-0">
              <Heading level={1}>{profile.display_name}</Heading>
              {profile.base_location ? (
                <p className="mt-2 flex items-center gap-1.5 text-[15px] text-navy-500">
                  <MapPinIcon className="h-4 w-4 shrink-0 text-navy-400" />
                  {profile.base_location}
                </p>
              ) : null}
            </div>
          </div>

          {profile.bio ? <p className="max-w-2xl text-base leading-relaxed text-navy-700">{profile.bio}</p> : null}

          {profile.languages.length > 0 || profile.specialties.length > 0 ? (
            <div className="grid gap-6 sm:grid-cols-2">
              {profile.languages.length > 0 ? (
                <div>
                  <Eyebrow className="mb-3">Languages</Eyebrow>
                  <p className="text-[15px] text-navy-700">{profile.languages.join(" · ")}</p>
                </div>
              ) : null}

              {profile.specialties.length > 0 ? (
                <div>
                  <Eyebrow className="mb-3">Specialties</Eyebrow>
                  <div className="flex flex-wrap gap-2">
                    {profile.specialties.map((specialty) => (
                      <Badge key={specialty} tone="gold">
                        {specialty.replace(/[-_]/g, " ")}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {profile.gallery.length > 0 ? (
            <div>
              <Eyebrow className="mb-3">Gallery</Eyebrow>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {profile.gallery.map((image, i) => (
                  <FallbackImage
                    key={i}
                    src={image.image_url}
                    alt={image.caption ?? profile.display_name}
                    className="aspect-square w-full rounded-xl"
                  />
                ))}
              </div>
            </div>
          ) : null}

          {profile.otherExperiences.length > 0 ? (
            <div>
              <Eyebrow className="mb-3">Other experiences</Eyebrow>
              <ul className="flex flex-col gap-2">
                {profile.otherExperiences.map((exp) => (
                  <li
                    key={exp.id}
                    className="flex items-center justify-between gap-4 rounded-xl border border-ivory-300 bg-ivory-100/70 px-4 py-3.5"
                  >
                    <span className="min-w-0 font-display text-base text-navy-950">{exp.title}</span>
                    <span className="shrink-0 text-sm text-navy-500">
                      {formatPrice(exp.price_per_person, exp.currency)}
                    </span>
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
