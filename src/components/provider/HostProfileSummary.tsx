import { FallbackImage } from "@/components/planner/FallbackImage";
import type { ProviderIdentity } from "@/lib/provider/dashboard";
import { ViewPublicProfileButton } from "./ViewPublicProfileButton";

function humanize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A read-only summary of the host's public profile — the same fields guests see
 * (photo, name, location, specialties, bio, languages) plus how many experiences
 * are published, and the existing "View public profile" preview. Used on the
 * Dashboard (supporting column) and the Profile page. Nothing here edits.
 */
export function HostProfileSummary({ identity }: { identity: ProviderIdentity }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <FallbackImage src={identity.profilePhotoUrl} alt={identity.displayName} className="h-14 w-14 shrink-0 rounded-full" />
        <div className="min-w-0">
          <p className="truncate font-display text-xl leading-snug text-navy-950">{identity.displayName}</p>
          {identity.baseLocation ? <p className="truncate text-sm text-navy-500">{identity.baseLocation}</p> : null}
        </div>
      </div>

      {identity.specialties.length > 0 ? (
        <p className="text-sm font-medium text-navy-700">
          {identity.specialties.slice(0, 3).map((value) => humanize(value)).join(" & ")}
        </p>
      ) : null}
      {identity.bio ? <p className="line-clamp-3 text-sm leading-relaxed text-navy-600">{identity.bio}</p> : null}
      {identity.languages.length > 0 ? <p className="text-sm text-navy-500">{identity.languages.join(" · ")}</p> : null}

      <div className="flex flex-col gap-2 border-t border-ivory-300 pt-4">
        <p className="text-sm text-navy-700">
          {identity.publishedExperienceCount} published experience
          {identity.publishedExperienceCount === 1 ? "" : "s"}
        </p>
        {identity.publishedExperienceCount > 0 ? (
          <div>
            <ViewPublicProfileButton providerId={identity.id} providerName={identity.displayName} />
          </div>
        ) : (
          // provider_public_profiles only lists hosts with a published experience,
          // so there is nothing public to preview yet.
          <p className="text-sm text-navy-500">
            Your public profile becomes visible to guests once you publish your first experience.
          </p>
        )}
      </div>
    </div>
  );
}
