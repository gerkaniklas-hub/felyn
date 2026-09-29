"use server";

import { OCCASIONS } from "@/lib/onboarding/constants";
import { getStay, getStayOccasions, getStayPreferences } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getHardFilteredExperiences, type MatchedExperience } from "./hard-filter";
import { getProviderProfile, type ProviderProfile } from "./provider-profile";
import { rankExperiencesWithAI } from "./soft-rank";
import { assertGuestJourney, assertSharedActionAllowedForJourney } from "@/lib/journey-server";

export type RecommendedExperience = {
  experience: MatchedExperience;
  reason: string;
};

const FALLBACK_REASON = "Matches your stay's dates, group size, budget and dietary needs.";

function deterministicFallback(eligible: MatchedExperience[], count: number): RecommendedExperience[] {
  return eligible.slice(0, count).map((experience) => ({ experience, reason: FALLBACK_REASON }));
}

/**
 * M5.2 entry point: stay_id -> up to `count` recommended experiences + a
 * "why we picked this" reason each. `count` defaults to 3 (the original
 * M5.2/M5.3 behavior); the M6 Stay Planner passes a larger number to get
 * variety across the stay, capped by however many actually pass the hard
 * filter — never padded beyond that.
 *
 * 1. Hard-filters via M5.1's getHardFilteredExperiences (RLS-scoped —
 *    the source of truth for every hard constraint).
 * 2. Asks OpenAI to rank the eligible set by soft fit only.
 * 3. Re-validates every returned id against the hard-filtered shortlist —
 *    an id that isn't in that list is never trusted, regardless of what
 *    the model returned.
 * 4. On any AI failure, or if validation leaves us short, falls back to a
 *    deterministic pick (the first N eligible experiences) so the guest
 *    flow never breaks.
 */
export async function getRecommendedExperiences(
  stayId: string,
  count: number = 3,
): Promise<RecommendedExperience[]> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();

  const eligible = await getHardFilteredExperiences(supabase, stayId);
  if (eligible.length === 0) return [];

  const pickCount = Math.min(count, eligible.length);

  const [stay, occasions, preferences] = await Promise.all([
    getStay(supabase, stayId),
    getStayOccasions(supabase, stayId),
    getStayPreferences(supabase, stayId),
  ]);
  if (!stay) return deterministicFallback(eligible, pickCount);

  const occasionLabels = occasions.map(
    (value) => OCCASIONS.find((option) => option.value === value)?.label ?? value,
  );

  let aiPicks: { id: string; reason: string }[];
  try {
    aiPicks = await rankExperiencesWithAI(
      eligible,
      { occasionLabels, preferencesText: preferences?.raw_text ?? null },
      pickCount,
    );
  } catch {
    return deterministicFallback(eligible, pickCount);
  }

  // Validate: only ids that are actually in the hard-filtered shortlist are
  // ever trusted, deduped, and capped at pickCount.
  const eligibleById = new Map(eligible.map((experience) => [experience.id, experience]));
  const seen = new Set<string>();
  const validated: RecommendedExperience[] = [];
  for (const pick of aiPicks) {
    if (validated.length === pickCount) break;
    if (seen.has(pick.id)) continue;
    const experience = eligibleById.get(pick.id);
    if (!experience) continue; // never trust an id the AI invented
    if (typeof pick.reason !== "string" || pick.reason.trim().length === 0) continue;
    seen.add(pick.id);
    validated.push({ experience, reason: pick.reason.trim() });
  }

  if (validated.length === 0) return deterministicFallback(eligible, pickCount);

  // Pad any shortfall (e.g. the model returned fewer valid picks than
  // asked) with the next deterministic eligible experiences.
  if (validated.length < pickCount) {
    for (const experience of eligible) {
      if (validated.length === pickCount) break;
      if (seen.has(experience.id)) continue;
      seen.add(experience.id);
      validated.push({ experience, reason: FALLBACK_REASON });
    }
  }

  return validated;
}

/**
 * M6 provider focus panel: fetches the RLS-safe public profile for one
 * provider on demand (called directly from the Stay Planner client
 * component when a guest opens "Meet <provider>"). Returns null if the
 * provider has no public profile visible to this guest (e.g. no published
 * experience) rather than throwing — the UI treats that as "unavailable."
 */
export async function getProviderProfileAction(providerId: string): Promise<ProviderProfile | null> {
  await assertSharedActionAllowedForJourney(); // also used by the provider dashboard and messaging
  const supabase = await createSupabaseServerClient();
  return getProviderProfile(supabase, providerId);
}
