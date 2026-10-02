"use client";

import { useState } from "react";
import { RequestExperienceModal } from "@/components/booking/RequestExperienceModal";
import { ExperienceCard } from "@/components/planner/ExperienceCard";
import { ExperienceFocus } from "@/components/planner/ExperienceFocus";
import { ProviderFocus } from "@/components/planner/ProviderFocus";
import { getProviderProfileAction } from "@/lib/matching/actions";
import type { GuestStayOption } from "@/lib/matching/explore";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import type { ProviderProfile } from "@/lib/matching/provider-profile";

type FocusState =
  | { type: "none" }
  | { type: "experience"; experienceId: string }
  | { type: "provider"; experienceId: string; providerId: string };

/**
 * /explore: a simple, stay-independent browse grid. Reuses the same
 * layered Experience -> Provider navigation the Stay Planner uses
 * (ExperienceCard / ExperienceFocus / ProviderFocus) — every card renders
 * `locked` so no "+"/"Add to my plan" control appears, since there's no
 * plan here to add into. The detail panel offers "Request experience"
 * instead (RequestExperienceModal), with or without one of the guest's trips.
 */
export function ExploreBrowser({
  experiences,
  stays = [],
}: {
  experiences: MatchedExperience[];
  /** The guest's own stays, offered as "Add to a trip" in the request form when one covers the chosen date. */
  stays?: GuestStayOption[];
}) {
  const [focus, setFocus] = useState<FocusState>({ type: "none" });
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [providerProfiles, setProviderProfiles] = useState<
    Record<string, ProviderProfile | "loading" | null>
  >({});

  const experienceById = new Map(experiences.map((experience) => [experience.id, experience]));
  const focusedExperience = focus.type !== "none" ? experienceById.get(focus.experienceId) : undefined;
  const requestingExperience = requestingId ? experienceById.get(requestingId) : undefined;

  async function openProvider(providerId: string, experienceId: string) {
    setFocus({ type: "provider", providerId, experienceId });
    if (providerProfiles[providerId] === undefined) {
      setProviderProfiles((prev) => ({ ...prev, [providerId]: "loading" }));
      const profile = await getProviderProfileAction(providerId);
      setProviderProfiles((prev) => ({ ...prev, [providerId]: profile }));
    }
  }

  function closeProvider() {
    setFocus((prev) =>
      prev.type === "provider" ? { type: "experience", experienceId: prev.experienceId } : prev,
    );
  }

  if (experiences.length === 0) {
    return <p className="text-navy-700">No experiences are available to browse yet.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {experiences.map((experience) => (
          <ExperienceCard
            key={experience.id}
            experience={experience}
            reason=""
            selected={false}
            locked
            onOpen={() => setFocus({ type: "experience", experienceId: experience.id })}
            onToggleSelect={() => {}}
          />
        ))}
      </div>

      {focus.type !== "none" && focusedExperience ? (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-ivory-100 p-4">
          <ExperienceFocus
            recommendation={{ experience: focusedExperience, reason: "" }}
            selected={false}
            compact={focus.type === "provider"}
            suggestedLabel={null}
            plannedSlot={null}
            plannableDates={[]}
            locked
            onChangeSlot={() => {}}
            onToggleSelect={() => {}}
            onOpenProvider={() => openProvider(focusedExperience.provider_id, focus.experienceId)}
            onRequest={() => setRequestingId(focusedExperience.id)}
            onClose={() => setFocus({ type: "none" })}
          />
        </div>
      ) : null}

      {focus.type === "provider" ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-ivory-100 p-4">
          <ProviderFocus
            profile={providerProfiles[focus.providerId] ?? "loading"}
            providerName={focusedExperience?.provider.display_name ?? ""}
            onClose={closeProvider}
          />
        </div>
      ) : null}
      {requestingExperience ? (
        <RequestExperienceModal experience={requestingExperience} stays={stays} onClose={() => setRequestingId(null)} />
      ) : null}
    </>
  );
}
