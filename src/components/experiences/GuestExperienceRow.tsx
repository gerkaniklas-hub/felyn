import Link from "next/link";
import { CancelExperienceButton } from "@/components/booking/CancelExperienceButton";
import { CalendarIcon, MapPinIcon, UserIcon, UsersIcon } from "@/components/navigation/icons";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { cardSurface } from "@/components/ui/card";
import { textLinkClass } from "@/components/ui/page";
import { formatCurrency } from "@/lib/format";
import {
  getCancelReasonLabel,
  getDeclineReasonLabel,
  getItemStatusLabel,
  getItemStatusTone,
  NO_TRIP_LINKED_LABEL,
} from "@/lib/matching/booking-status";
import type { GuestExperienceItem } from "@/lib/matching/guest-experiences";
import { getBookingStartTime, getBookingTimeLabel } from "@/lib/matching/plan";
import { formatDayLabel } from "@/lib/matching/timeline";

/**
 * Stage 3 (Phase 4/5 of the consolidated improvements): one booking card,
 * shared by the per-stay overview (/stays/[stayId], via ExperienceStatusGroups)
 * and My trips (/trips). Reuses exactly the existing booking data
 * GuestExperienceItem already carries — no parallel summary model. The
 * image and title open the booking's own detail page (/experiences/[itemId]);
 * cancellation stays a separate, clearly distinct control beneath them,
 * never nested inside the link. The stay's property name stands in for the
 * location: it is the only place data the item carries.
 */
export function GuestExperienceRow({ item, showStay = true }: { item: GuestExperienceItem; showStay?: boolean }) {
  return (
    <div className={`${cardSurface} flex flex-col gap-4 p-3 sm:flex-row sm:gap-5 sm:p-4`}>
      <Link href={`/bookings/${item.id}`} className="shrink-0 overflow-hidden rounded-xl" tabIndex={-1} aria-hidden="true">
        <FallbackImage
          src={item.experienceImageUrl}
          alt={item.experienceTitle}
          className="aspect-[16/9] w-full sm:aspect-auto sm:h-full sm:min-h-36 sm:w-52"
        />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-2 pb-2 sm:px-0 sm:py-1 sm:pr-2">
        <div className="flex items-start justify-between gap-3">
          <Link
            href={`/bookings/${item.id}`}
            className="min-w-0 font-display text-xl leading-snug text-navy-950 transition-colors hover:text-sky-700"
          >
            {item.experienceTitle}
          </Link>
          <Badge tone={getItemStatusTone(item.status)} className="shrink-0">
            {getItemStatusLabel(item.status)}
          </Badge>
        </div>
        <div className="flex flex-col gap-1.5 text-sm text-navy-600">
          <span className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 shrink-0 text-navy-400" />
            {formatDayLabel(item.plannedDate)} · {getBookingTimeLabel(item.plannedMoment, getBookingStartTime(item))}
          </span>
          {showStay ? (
            <span className="flex items-center gap-2">
              <MapPinIcon className="h-4 w-4 shrink-0 text-navy-400" />
              <span className="truncate">{item.stayPropertyName ?? NO_TRIP_LINKED_LABEL}</span>
            </span>
          ) : null}
          <span className="flex items-center gap-2">
            <UsersIcon className="h-4 w-4 shrink-0 text-navy-400" />
            {item.guestCount} guest{item.guestCount === 1 ? "" : "s"} ·{" "}
            {formatCurrency(item.pricePerPerson * item.guestCount, item.currency)}
          </span>
          <span className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 shrink-0 text-navy-400" />
            Hosted by {item.providerDisplayName}
          </span>
        </div>
        {item.status === "DECLINED" && item.declineReason ? (
          <p className="text-sm text-navy-500">Reason: {getDeclineReasonLabel(item.declineReason)}</p>
        ) : null}
        {item.status === "CANCELLED" ? (
          <p className="text-sm text-navy-500">
            Cancelled by {item.cancelledBy === "provider" ? "the host" : "you"}
            {item.cancellationReason ? ` · Reason: ${getCancelReasonLabel(item.cancellationReason)}` : ""}
            {item.cancellationNote ? ` · "${item.cancellationNote}"` : ""}
          </p>
        ) : null}
        <div className="mt-auto flex items-center gap-5 border-t border-ivory-200 pt-3">
          <Link href={`/bookings/${item.id}`} className={textLinkClass}>
            View details →
          </Link>
          {item.status === "CONFIRMED" ? <CancelExperienceButton itemId={item.id} stayId={item.stayId ?? undefined} /> : null}
        </div>
      </div>
    </div>
  );
}
