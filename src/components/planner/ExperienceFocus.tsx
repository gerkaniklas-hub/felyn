"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Eyebrow } from "@/components/ui/page";
import { ClockIcon, MapPinIcon, UsersIcon } from "@/components/navigation/icons";
import { formatCurrency } from "@/lib/format";
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
  const description = experience.description ?? experience.short_description;

  const backButton = (
    <button
      type="button"
      onClick={onClose}
      className="inline-flex h-11 items-center self-start text-sm font-medium text-sky-600 hover:text-sky-700"
    >
      {closeLabel}
    </button>
  );

  const plannedList =
    plannedEntries.length > 0 ? (
      <ul className="flex flex-col gap-2">
        {plannedEntries.map((entry) => (
          <li
            key={entry.selectionId}
            className="rounded-xl border border-ivory-300 bg-ivory-100 px-4 py-3 text-sm text-navy-700"
          >
            <p className="font-medium text-navy-900">{entry.label}</p>
            <p className="text-navy-500">
              {ENTRY_STATUS_LABEL[entry.status]}
              {entry.status === "DECLINED" && getDeclineReasonLabel(entry.declineReason)
                ? ` — ${getDeclineReasonLabel(entry.declineReason)}`
                : ""}
            </p>
            {entry.conflict ? (
              <p className="mt-1 w-fit rounded-xl bg-gold-100 px-2.5 py-1 text-xs font-medium text-gold-700">
                ⚠ Scheduling conflict — another experience is also planned for this date and moment.
              </p>
            ) : null}
            {entry.onEdit || entry.onRemove ? (
              <div className="mt-1 flex gap-4">
                {entry.onEdit ? (
                  <button type="button" onClick={entry.onEdit} className="font-medium text-sky-600 hover:text-sky-700">
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
    ) : null;

  const addButton =
    onAddToPlan && !locked ? (
      <Button type="button" className="w-full" onClick={onAddToPlan}>
        Add to my plan
      </Button>
    ) : null;

  if (compact) {
    // compact is a slim summary (used once a provider panel opens beside
    // it) — a single small thumbnail, not the full gallery.
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto rounded-card border border-ivory-300 bg-ivory-50 p-5 shadow-card">
        {backButton}
        <div className="aspect-[16/10] overflow-hidden rounded-xl">
          <FallbackImage src={experience.image_url} alt={experience.title} className="h-full w-full" />
        </div>
        <div className="flex flex-col gap-3">
          <p className="font-display text-lg leading-snug text-navy-950">{experience.title}</p>
          {reason ? <p className="text-sm text-navy-500">{reason}</p> : null}
          {plannedList}
        </div>
        {addButton ? <div className="mt-auto pt-2">{addButton}</div> : null}
      </div>
    );
  }

  return (
    // A container, so the two-column composition follows the space this panel
    // actually has (full screen on Explore, a centred column in the planner)
    // rather than the viewport.
    <div className="@container flex h-full flex-col gap-6 overflow-y-auto rounded-panel border border-ivory-300 bg-ivory-50 p-5 sm:p-8 lg:p-10">
      {backButton}

      <ExperienceGallery images={experience.gallery} title={experience.title} />

      {/* Title, host, and why it was suggested — full width, straight under the photo */}
      <div className="flex min-w-0 flex-col gap-4">
        <Heading level={1}>{experience.title}</Heading>
        {/* A <div>, not a <p>: FallbackImage renders a <div> placeholder tile
            (missing/failed/demo photo), and a <div> inside a <p> is invalid HTML. */}
        <div className="flex items-center gap-3 text-[15px] text-navy-600">
          <FallbackImage
            src={experience.provider.profile_photo_url}
            alt={experience.provider.display_name}
            className="h-9 w-9 shrink-0 rounded-full"
          />
          <span>
            Hosted by <span className="font-medium text-navy-900">{experience.provider.display_name}</span>
            {experience.provider.base_location ? ` · ${experience.provider.base_location}` : ""}
          </span>
        </div>
        {reason ? <p className="text-sm font-medium text-sky-700">{reason}</p> : null}
        {plannedList}
      </div>

      <div className="grid grid-cols-1 gap-8 border-t border-ivory-300 pt-8 @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:gap-x-12 @5xl:grid-cols-[minmax(0,1fr)_19rem]">
        {/* The key facts and the action: first on a narrow panel, a quiet side column on a wide one */}
        <aside className="flex flex-col gap-5 self-start @3xl:col-start-2 @3xl:row-start-1 @3xl:border-l @3xl:border-ivory-300 @3xl:pl-10">
          <div className="flex items-baseline gap-2">
            <p className="font-display text-2xl leading-none text-navy-950">
              {formatCurrency(experience.price_per_person, experience.currency)}
            </p>
            <p className="text-sm text-navy-500">per person</p>
          </div>
          <dl className="flex flex-col gap-3 text-[15px] text-navy-700">
            <div className="flex items-center gap-3">
              <dt className="sr-only">Guests</dt>
              <UsersIcon className="h-5 w-5 shrink-0 text-navy-400" />
              <dd>
                {experience.min_guests}–{experience.max_guests} guests
              </dd>
            </div>
            <div className="flex items-center gap-3">
              <dt className="sr-only">Duration</dt>
              <ClockIcon className="h-5 w-5 shrink-0 text-navy-400" />
              <dd>{formatDuration(experience.duration_minutes)}</dd>
            </div>
            {experience.provider.base_location ? (
              <div className="flex items-center gap-3">
                <dt className="sr-only">Location</dt>
                <MapPinIcon className="h-5 w-5 shrink-0 text-navy-400" />
                <dd className="min-w-0">{experience.provider.base_location}</dd>
              </div>
            ) : null}
          </dl>
          {addButton}
          {onRequest ? (
            <div>
              <Button type="button" className="w-full" onClick={onRequest}>
                Request experience
              </Button>
              <p className="mt-2 text-center text-xs text-navy-500">The host confirms every request.</p>
            </div>
          ) : null}
        </aside>

        {/* The story: description, what to expect, dietary, the host */}
        <div className="flex min-w-0 flex-col gap-8 @3xl:col-start-1 @3xl:row-start-1">
          {description ? (
            <p className="max-w-2xl text-base leading-relaxed text-navy-700">{description}</p>
          ) : null}

          {softAttributes.length > 0 ? (
            <div>
              <Eyebrow className="mb-3">What to expect</Eyebrow>
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
              <Eyebrow className="mb-3">Dietary</Eyebrow>
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
            className="flex w-full items-center gap-4 rounded-card border border-ivory-300 bg-ivory-50 p-4 text-left shadow-card transition-[border-color,box-shadow] hover:border-ivory-400 hover:shadow-float sm:p-5"
          >
            <FallbackImage
              src={experience.provider.profile_photo_url}
              alt={experience.provider.display_name}
              className="h-14 w-14 shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-xl text-navy-950">{experience.provider.display_name}</span>
              <span className="block truncate text-sm text-navy-500">
                {experience.provider.base_location ?? "Felyn provider"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-medium text-sky-600">
              Meet {experience.provider.display_name.split(" ")[0]} →
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
