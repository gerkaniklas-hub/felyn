import Link from "next/link";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
} from "@/lib/matching/booking-status";
import { getPlannedMomentLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";
import type { ProviderRequestItem } from "@/lib/provider/dashboard";

export type ProviderBookingCardItem = Pick<
  ProviderRequestItem,
  | "itemId"
  | "status"
  | "stayName"
  | "stayLocation"
  | "guestFirstName"
  | "occasionLabels"
  | "dietary"
  | "plannedDate"
  | "plannedMoment"
  | "preferredTime"
  | "guestCount"
  | "hostNote"
  | "experienceTitle"
  | "experienceImageUrl"
  | "pricePerPerson"
  | "currency"
  | "declineReason"
  | "cancelledBy"
  | "cancellationReason"
  | "cancellationNote"
>;

/**
 * The single premium "booking card" layout, reused everywhere a provider
 * sees a booking's summary: the dashboard's "Needs your attention" and
 * "Upcoming" lists, the Requests page's Pending/Confirmed/Declined groups,
 * and (in `linkable={false}` form) the request detail page itself — see
 * `[itemId]/page.tsx`. One implementation, never duplicated (task 1/4).
 *
 * `linkable` (default true) wraps the card in a Link to its own detail
 * page, with visible hover/focus-visible states for keyboard use. The
 * detail page passes `linkable={false}` — it already IS that page, and it
 * nests real interactive controls (Confirm/Decline) that must never sit
 * inside an anchor.
 */
export function ProviderBookingCard({
  item,
  linkable = true,
  /** The request detail page: it already IS the destination, so this drops the border/background/padding — it's laid out inside that page's own Card instead. */
  bare = false,
  badgeOverride,
}: {
  item: ProviderBookingCardItem;
  linkable?: boolean;
  bare?: boolean;
  /** Dashboard's "Needs your attention" uses this to show "NEW REQUEST" instead of the plain status badge. */
  badgeOverride?: { label: string; tone: "gold" | "sky" | "navy" };
}) {
  const estimatedTotal = item.pricePerPerson * item.guestCount;
  const isMuted = item.status === "DECLINED" || item.status === "CANCELLED";
  const declineReasonLabel = item.status === "DECLINED" ? getDeclineReasonLabel(item.declineReason) : null;
  const cancellationReasonLabel = item.status === "CANCELLED" ? getCancelReasonLabel(item.cancellationReason) : null;

  const body = (
    <div
      className={
        bare
          ? "flex gap-4"
          : `flex gap-4 rounded-2xl border p-4 transition-colors sm:p-5 ${
              item.status === "CONFIRMED"
                ? "border-sky-300 bg-sky-50"
                : item.status === "REQUESTED"
                  ? "border-gold-300 bg-ivory-50"
                  : "border-ivory-300 bg-ivory-100"
            } ${linkable ? "hover:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400" : ""}`
      }
    >
      <FallbackImage
        src={item.experienceImageUrl}
        alt={item.experienceTitle}
        className={`h-20 w-20 shrink-0 rounded-xl sm:h-24 sm:w-24 ${isMuted ? "opacity-70 grayscale-[0.3]" : ""}`}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className={`min-w-0 truncate font-display text-lg ${isMuted ? "text-navy-500" : "text-navy-950"}`}>
            {item.experienceTitle}
          </p>
          <Badge tone={badgeOverride?.tone ?? getItemStatusTone(item.status)} className="shrink-0">
            {badgeOverride?.label ?? getItemStatusLabel(item.status)}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-navy-700">
          <span>
            {formatDayLabel(item.plannedDate)} · {getPlannedMomentLabel(item.plannedMoment)}
          </span>
          <span>
            {item.guestCount} guest{item.guestCount === 1 ? "" : "s"} for this experience
          </span>
        </div>

        {item.preferredTime ? (
          <p className="text-sm text-navy-500">
            Guest prefers <span className="font-medium text-navy-700">{item.preferredTime}</span>
            {item.status !== "CONFIRMED" ? " — a preference, not yet confirmed" : ""}
          </p>
        ) : null}

        <p className="text-sm text-navy-600">
          {item.guestFirstName ? `${item.guestFirstName} · ` : ""}
          {item.stayName}
          {item.stayLocation ? ` · ${item.stayLocation}` : ""}
        </p>

        {item.occasionLabels.length > 0 || item.dietary.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.occasionLabels.map((label) => (
              <Badge key={`occasion-${label}`} tone="navy">
                {label}
              </Badge>
            ))}
            {item.dietary.map((requirement) => (
              <Badge key={`dietary-${requirement.label}`} tone="sky">
                {requirement.label}
                {requirement.guestCount ? ` · ${requirement.guestCount}` : ""}
              </Badge>
            ))}
          </div>
        ) : null}

        {item.hostNote ? (
          <p className="line-clamp-2 break-words text-sm text-navy-500">
            <span className="font-medium text-navy-700">Guest note:</span> {item.hostNote}
          </p>
        ) : null}

        {declineReasonLabel ? <p className="text-sm text-navy-500">Declined: {declineReasonLabel}</p> : null}
        {cancellationReasonLabel ? (
          <p className="text-sm text-navy-500">
            Cancelled by {item.cancelledBy === "provider" ? "you" : "the guest"}: {cancellationReasonLabel}
          </p>
        ) : null}
        {item.status === "CANCELLED" && item.cancellationNote ? (
          <p className="text-sm text-navy-500">&quot;{item.cancellationNote}&quot;</p>
        ) : null}

        <p className="mt-auto text-sm font-medium text-navy-800">
          {formatCurrency(estimatedTotal, item.currency)} estimated
        </p>
      </div>
    </div>
  );

  if (!linkable) return body;

  return (
    <Link href={`/provider/requests/${item.itemId}`} className="block rounded-2xl">
      {body}
    </Link>
  );
}
