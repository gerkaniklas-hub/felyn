"use client";

import { Badge } from "@/components/ui/badge";
import { MessageLauncherButton } from "@/components/messaging/MessageLauncherButton";
import { formatCurrency } from "@/lib/format";
import {
  getDeclineReasonLabel,
  getMessagingClosedLabel,
  getMessagingOpenCaption,
  getMessagingWindowState,
  type BookingItemStatus,
  type DeclineReason,
  type PlanItemStatus,
} from "@/lib/matching/booking-status";
import { getPlannedMomentLabel, type PlannedSlot } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import { FallbackImage } from "./FallbackImage";

/** Tailwind classes per status — the whole card changes weight, not just a small badge (P1.4 §7). */
const STATUS_CARD_CLASS: Record<PlanItemStatus, string> = {
  CONFIRMED: "border-2 border-sky-500 bg-sky-50 shadow-sm",
  REQUESTED: "border border-gold-300 bg-ivory-50",
  DRAFT: "border border-dashed border-sky-400 bg-ivory-50",
  DECLINED: "border border-ivory-300 bg-ivory-100",
  WITHDRAWN: "border border-ivory-200 bg-ivory-50 opacity-60",
  CANCELLED: "border border-ivory-200 bg-ivory-50 opacity-60",
};

const STATUS_BADGE_LABEL: Record<PlanItemStatus, string> = {
  CONFIRMED: "CONFIRMED",
  REQUESTED: "AWAITING CONFIRMATION",
  DRAFT: "NOT YET REQUESTED",
  DECLINED: "DECLINED",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED",
};

/**
 * One experience's card in the guest's plan for a date+moment: a persisted
 * request item (awaiting / confirmed / declined / withdrawn) or a draft
 * that hasn't been requested yet. The status decides which actions exist —
 * confirmed items have none (locked), awaiting ones can be withdrawn, drafts
 * can be edited or removed, declined ones lead back to discovery. Shows this
 * item's OWN guest count, price and preferences, not the stay's.
 */
export function RequestedItemCard({
  experience,
  slot,
  status,
  declineReason,
  decidedAt,
  cancelledAt,
  guestCount,
  pricePerPerson,
  preferredTime,
  hostNote,
  currency,
  conflict = false,
  itemId,
  bookingHref,
  unreadMessageCount = 0,
  onOpen,
  onWithdraw,
  onEdit,
  onRemove,
  onExplore,
}: {
  experience: MatchedExperience;
  slot: PlannedSlot;
  status: PlanItemStatus;
  declineReason: DeclineReason | null;
  /** Stage 2c-B: anchors for the 30-day post-decision messaging window — see getMessagingWindowState in booking-status.ts. Null unless the item is DECLINED/CANCELLED respectively; irrelevant for a DRAFT. */
  decidedAt: string | null;
  cancelledAt: string | null;
  guestCount: number;
  /** The price this item was requested at (a draft: the experience's current price). */
  pricePerPerson: number;
  preferredTime: string | null;
  hostNote: string | null;
  currency: string;
  conflict?: boolean;
  /**
   * The real booking_request_items.id — null for a DRAFT (no such row
   * exists yet to attach messages to). Messaging is hidden entirely until
   * an item has actually been requested.
   */
  itemId?: string | null;
  /** The guest's own stay page — where the floating chat header's "view booking" link points. Only needed when itemId is set. */
  bookingHref?: string;
  unreadMessageCount?: number;
  /** Opens the existing ExperienceFocus detail panel — always available, viewing is never restricted. */
  onOpen: () => void;
  /** Only for a REQUESTED item. */
  onWithdraw?: () => void;
  /** Only for a DRAFT. */
  onEdit?: () => void;
  /** Only for a DRAFT. */
  onRemove?: () => void;
  /** Only for a DECLINED item — "Explore alternatives →" for the same date/moment. */
  onExplore?: () => void;
}) {
  const reasonLabel = status === "DECLINED" ? getDeclineReasonLabel(declineReason) : null;
  const isMuted = status === "DECLINED" || status === "WITHDRAWN" || status === "CANCELLED";
  const mutedText = isMuted ? "text-navy-300" : "text-navy-700";
  // DRAFT is excluded (no persisted item, nothing to compute a window for)
  // — TypeScript narrows `status` to BookingItemStatus in this branch,
  // which getMessagingWindowState requires.
  const windowState = status !== "DRAFT" ? getMessagingWindowState(status, decidedAt, cancelledAt) : null;
  const canMessage = itemId != null && bookingHref != null && windowState != null;
  const hostFirstName = experience.provider.display_name.split(" ")[0];

  return (
    <div className={`flex gap-4 rounded-2xl p-4 transition-colors ${STATUS_CARD_CLASS[status]}`}>
      <button type="button" onClick={onOpen} aria-label={`View ${experience.title}`} className="shrink-0 self-start">
        <FallbackImage
          src={experience.image_url}
          alt={experience.title}
          className={`h-20 w-20 rounded-xl ${isMuted ? "opacity-70 grayscale-[0.3]" : ""}`}
        />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <p className={`truncate font-display text-lg ${isMuted ? "text-navy-500" : "text-navy-950"}`}>
              {experience.title}
            </p>
          </button>
          <Badge
            tone={status === "CONFIRMED" ? "sky" : status === "REQUESTED" ? "gold" : "navy"}
            className={status === "CONFIRMED" ? "font-semibold" : ""}
          >
            {STATUS_BADGE_LABEL[status]}
          </Badge>
        </div>
        <p className={`text-sm ${mutedText}`}>{experience.provider.display_name}</p>
        <p className={`text-sm ${mutedText}`}>
          {formatDayLabel(slot.date)} · {getPlannedMomentLabel(slot.moment)}
          {preferredTime ? ` · prefers ${preferredTime}` : ""}
        </p>
        {!isMuted ? (
          <p className="text-sm font-medium text-navy-700">
            {guestCount} guest{guestCount === 1 ? "" : "s"} · {formatCurrency(pricePerPerson * guestCount, currency)}
          </p>
        ) : null}
        {hostNote && !isMuted ? (
          <p className="line-clamp-2 break-words text-sm text-navy-500">Note: {hostNote}</p>
        ) : null}

        {conflict ? (
          <p className="w-fit rounded-md bg-gold-100 px-2 py-1 text-xs font-medium text-gold-700">
            ⚠ Same date &amp; moment as another experience
          </p>
        ) : null}

        {status === "DECLINED" ? (
          <div className="mt-1 flex flex-col gap-1">
            {reasonLabel ? <p className="text-sm text-navy-500">{reasonLabel}</p> : null}
            {onExplore ? (
              <button
                type="button"
                onClick={onExplore}
                className="w-fit text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                Explore alternatives →
              </button>
            ) : null}
          </div>
        ) : null}

        {status === "DRAFT" ? (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {onEdit ? (
              <button type="button" onClick={onEdit} className="text-sm font-medium text-sky-600 hover:text-sky-700">
                Edit
              </button>
            ) : null}
            {onRemove ? (
              <button type="button" onClick={onRemove} className="text-sm font-medium text-navy-500 hover:text-navy-900">
                Remove
              </button>
            ) : null}
          </div>
        ) : null}

        {status === "REQUESTED" && onWithdraw ? (
          <button
            type="button"
            onClick={onWithdraw}
            className="mt-1 w-fit text-sm font-medium text-navy-500 hover:text-navy-900"
          >
            Withdraw request
          </button>
        ) : null}

        {status === "CONFIRMED" ? (
          <p className="text-xs text-sky-700">Confirmed by {hostFirstName}</p>
        ) : null}

        {canMessage && windowState ? (
          <MessageLauncherButton
            label={`Message ${hostFirstName}`}
            unreadCount={unreadMessageCount}
            handle={{
              itemId: itemId!,
              otherParticipant: {
                label: experience.provider.display_name,
                imageUrl: experience.provider.profile_photo_url,
                providerId: experience.provider.id,
              },
              experienceTitle: experience.title,
              experienceImageUrl: experience.image_url,
              bookingHref: bookingHref!,
              canSend: windowState.canSend,
              closedLabel: getMessagingClosedLabel(status as BookingItemStatus, windowState),
              openCaption: getMessagingOpenCaption(windowState),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
