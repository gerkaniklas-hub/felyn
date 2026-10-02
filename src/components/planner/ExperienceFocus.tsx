"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { formatPrice } from "@/lib/format";
import type { RecommendedExperience } from "@/lib/matching/actions";
import { getDeclineReasonLabel, type DeclineReason, type PlanItemStatus } from "@/lib/matching/booking-status";
import { FallbackImage } from "./FallbackImage";
import { ExperienceGallery } from "./ExperienceGallery";

function humanize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(minutes: number): string {
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
}

/** One place this experience already sits in the guest's plan (a draft, or a persisted request item). */
export type FocusPlanEntry = {
  selectionId: string;
  /** e.g. "12 DEC · Evening · 4 guests". */
  label: string;
  status: PlanItemStatus;
  declineReason: DeclineReason | null;
  conflict: boolean;
  /** Drafts only. */
  onEdit?: () => void;
  onRemove?: () => void;
};

const ENTRY_STATUS_LABEL: Record<PlanItemStatus, string> = {
  DRAFT: "In your plan · not yet requested",
  REQUESTED: "Awaiting confirmation",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
  CANCELLED: "Cancelled",
};

/**
 * Layer 2 of the Stay Planner's master/detail view. Everything shown here
 * comes straight off the MatchedExperience the M5.1 hard filter already
 * verified — nothing is invented. `compact` renders a slim summary instead
 * of the full detail, used once a provider panel opens next to this one.
 * "Add to my plan" here only OPENS the configuration step (see
 * ExperienceConfigModal) — nothing is added until the guest confirms it there.
 */
export function ExperienceFocus({
  recommendation,
  compact,
  plannedEntries = [],
  onAddToPlan,
  onRequest,
  locked = false,
  onOpenProvider,
  onClose,
  closeLabel = "← Back to your plan",
}: {
  recommendation: RecommendedExperience;
  compact: boolean;
  /** Every non-withdrawn place this experience is already in the plan — it can appear on several dates. */
  plannedEntries?: FocusPlanEntry[];
  /** Opens the configuration step. Absent (or `locked`) = browse-only, no "Add to my plan" button. */
  onAddToPlan?: () => void;
  /** Browse-only mode (used by the Explore page): never shows an add action. */
  locked?: boolean;
  /** Explore / Home: opens the "Request experience" form. Absent everywhere else (e.g. the planner), so no button there. */
  onRequest?: () => void;
  onOpenProvider: () => void;
  onClose: () => void;
  closeLabel?: string;
  /**
   * Accepted but unused. The Explore page (browse-only, deliberately not
   * touched by the planner redesign) still passes these old planner props;
   * keeping them optional means it compiles and behaves exactly as before.
   */
  selected?: boolean;
  suggestedLabel?: string | null;
  plannedSlot?: unknown;
  plannableDates?: string[];
  onChangeSlot?: (slot: never) => void;
  onToggleSelect?: () => void;
}) {
  const { experience, reason } = recommendation;
  const softAttributes = experience.attributes.filter((attr) => attr.attribute_type !== "dietary");
  const dietaryAttributes = experience.attributes.filter((attr) => attr.attribute_type === "dietary");

  return (
    <div
      className={`flex h-full flex-col overflow-y-auto rounded-2xl border border-ivory-300 bg-ivory-50 ${
        compact ? "gap-3 p-4" : "gap-6 p-6 sm:p-8"
      }`}
    >
      <button
        type="button"
        onClick={onClose}
        className="h-11 self-start text-sm font-medium text-sky-600 hover:text-sky-700"
      >
        {closeLabel}
      </button>

      {compact ? (
        // compact is a slim summary (used once a provider panel opens
        // beside it) — a single small thumbnail, not the full gallery.
        <div className="h-20 overflow-hidden rounded-xl">
          <FallbackImage src={experience.image_url} alt={experience.title} className="h-full w-full" />
        </div>
      ) : (
        <ExperienceGallery images={experience.gallery} title={experience.title} />
      )}

      <div>
        <Heading level={compact ? 3 : 2}>{experience.title}</Heading>
        {!compact ? (
          // A <div>, not a <p>: FallbackImage renders a <div> placeholder tile
          // (missing/failed/demo photo), and a <div> inside a <p> is invalid HTML.
          <div className="mt-1 flex items-center gap-2 text-sm text-navy-500">
            <FallbackImage
              src={experience.provider.profile_photo_url}
              alt={experience.provider.display_name}
              className="h-6 w-6 shrink-0 rounded-full"
            />
            <span>
              Hosted by {experience.provider.display_name}
              {experience.provider.base_location ? ` · ${experience.provider.base_location}` : ""}
            </span>
          </div>
        ) : null}
        {reason ? <p className="mt-1 text-sm text-navy-500">{reason}</p> : null}
        {plannedEntries.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {plannedEntries.map((entry) => (
              <li
                key={entry.selectionId}
                className="rounded-xl border border-ivory-300 bg-ivory-100 px-3 py-2 text-sm text-navy-700"
              >
                <p className="font-medium text-navy-900">{entry.label}</p>
                <p className="text-navy-500">
                  {ENTRY_STATUS_LABEL[entry.status]}
                  {entry.status === "DECLINED" && getDeclineReasonLabel(entry.declineReason)
                    ? ` — ${getDeclineReasonLabel(entry.declineReason)}`
                    : ""}
                </p>
                {entry.conflict ? (
                  <p className="mt-1 w-fit rounded-md bg-gold-100 px-2 py-1 text-xs font-medium text-gold-700">
                    ⚠ Scheduling conflict — another experience is also planned for this date and moment.
                  </p>
                ) : null}
                {entry.onEdit || entry.onRemove ? (
                  <div className="mt-1 flex gap-4">
                    {entry.onEdit ? (
                      <button
                        type="button"
                        onClick={entry.onEdit}
                        className="font-medium text-sky-600 hover:text-sky-700"
                      >
                        Edit
                      </button>
                    ) : null}
                    {entry.onRemove ? (
                      <button
                        type="button"
                        onClick={entry.onRemove}
                        className="font-medium text-navy-500 hover:text-navy-900"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!compact ? (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-navy-700">
            <span>{formatPrice(experience.price_per_person, experience.currency)}</span>
            <span>
              {experience.min_guests}–{experience.max_guests} guests
            </span>
            <span>{formatDuration(experience.duration_minutes)}</span>
          </div>

          {experience.description || experience.short_description ? (
            <p className="text-navy-700">{experience.description ?? experience.short_description}</p>
          ) : null}

          {softAttributes.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">WHAT TO EXPECT</p>
              <div className="flex flex-wrap gap-2">
                {softAttributes.map((attr, i) => (
                  <Badge key={`${attr.attribute_type}-${attr.attribute_value}-${i}`} tone="navy">
                    {humanize(attr.attribute_value)}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {dietaryAttributes.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium tracking-wide text-navy-300">DIETARY</p>
              <div className="flex flex-wrap gap-2">
                {dietaryAttributes.map((attr, i) => (
                  <Badge key={`dietary-${attr.attribute_value}-${i}`} tone="sky">
                    {humanize(attr.attribute_value)}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            onClick={onOpenProvider}
            className="flex items-center gap-3 rounded-xl border border-ivory-300 bg-ivory-100 p-4 text-left transition-colors hover:bg-ivory-200"
          >
            <FallbackImage
              src={experience.provider.profile_photo_url}
              alt={experience.provider.display_name}
              className="h-12 w-12 shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-base text-navy-950">{experience.provider.display_name}</span>
              <span className="block truncate text-sm text-navy-500">
                {experience.provider.base_location ?? "Felyn provider"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-medium text-sky-600">
              Meet {experience.provider.display_name.split(" ")[0]} →
            </span>
          </button>
        </>
      ) : null}

      {onAddToPlan && !locked ? (
        <div className="mt-auto pt-2">
          <Button type="button" className="w-full" onClick={onAddToPlan}>
            Add to my plan
          </Button>
        </div>
      ) : null}

      {onRequest && !compact ? (
        <div className="mt-auto pt-2">
          <Button type="button" className="w-full" onClick={onRequest}>
            Request experience
          </Button>
          <p className="mt-2 text-center text-xs text-navy-500">The host confirms every request.</p>
        </div>
      ) : null}
    </div>
  );
}
