import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { MarketplaceResultCard } from "./MarketplaceResultCard";

export type ResultCardData = {
  /** experience id — unique within a single list, since a list never repeats an experience. */
  key: string;
  experience: MatchedExperience;
  reason: string;
  selected: boolean;
  plannedLabel: string | null;
  conflict: boolean;
  onOpen: () => void;
};

/**
 * Replaces ExperienceCarousel: a vertically scrollable stack of wide
 * marketplace result cards, grouped exactly like the product spec's mockup
 * — a true AI-ranked "Recommended for you" set, then the rest of the same
 * day's hard-filter-eligible pool as "More experiences". Purely
 * presentational; both lists already come from the same combinedPool
 * StayPlanner had before this redesign.
 */
export function ExperienceResultList({
  recommended,
  moreIdeas,
}: {
  recommended: ResultCardData[];
  moreIdeas: ResultCardData[];
}) {
  if (recommended.length === 0 && moreIdeas.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {recommended.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium tracking-wide text-navy-300">RECOMMENDED FOR YOU</p>
          {recommended.map((card) => (
            <MarketplaceResultCard
              key={card.key}
              experience={card.experience}
              reason={card.reason}
              selected={card.selected}
              plannedLabel={card.plannedLabel}
              conflict={card.conflict}
              onOpen={card.onOpen}
            />
          ))}
        </div>
      ) : null}

      {moreIdeas.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium tracking-wide text-navy-300">MORE EXPERIENCES</p>
          {moreIdeas.map((card) => (
            <MarketplaceResultCard
              key={card.key}
              experience={card.experience}
              reason={card.reason}
              selected={card.selected}
              plannedLabel={card.plannedLabel}
              conflict={card.conflict}
              onOpen={card.onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
