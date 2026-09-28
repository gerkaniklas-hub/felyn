import Link from "next/link";
import { redirect } from "next/navigation";
import { ExperienceStatusGroups } from "@/components/experiences/ExperienceStatusGroups";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { formatCurrency, formatDateRange } from "@/lib/format";
import { getActiveBookingRequest } from "@/lib/matching/booking-requests";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
} from "@/lib/matching/booking-status";
import { getGuestExperiences } from "@/lib/matching/guest-experiences";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Milestone 1: the dedicated stay overview — property details, every
 * experience requested for THIS stay (grouped by status, via the same
 * getGuestExperiences/ExperienceStatusGroups the /experiences page uses),
 * and the actions to discover more or continue an in-progress request. The
 * planner remains reachable from here, but this page — not the planner —
 * is now what a guest's stay card on /home links to.
 *
 * Authorization: getStay is RLS-scoped and returns null for a stay that
 * doesn't exist OR belongs to another guest — both cases redirect to
 * /home exactly like every onboarding page already does. A guest can't
 * distinguish "not yours" from "doesn't exist" from the outside, and no
 * stay data is ever read before this check.
 */
export default async function StayOverviewPage({
  params,
}: {
  params: Promise<{ stayId: string }>;
}) {
  const { stayId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const stay = await getStay(supabase, stayId);
  if (!stay || !stay.onboarding_completed_at) redirect("/home");

  const [activeRequest, experiences] = await Promise.all([
    getActiveBookingRequest(stay.id),
    getGuestExperiences(supabase, stay.id),
  ]);

  // Booking-lifecycle milestone: derived from each item's own status, not
  // activeRequest.status — see home/page.tsx's comment for why the raw
  // column can never actually read "CONFIRMED".
  const aggregateStage = activeRequest ? deriveAggregateItemStage(activeRequest.items.map((item) => item.status)) : null;
  const isFullyConfirmed = aggregateStage === "confirmed";

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <Card className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <FallbackImage src={null} alt={stay.property_name} className="h-20 w-20 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <Heading level={2}>{stay.property_name}</Heading>
              <p className="text-navy-600">{stay.location_text}</p>
              <p className="text-sm text-navy-600">
                {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guest
                {stay.guest_count === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          {activeRequest && aggregateStage ? (
            <div className="flex flex-col items-start gap-1">
              <Badge tone={getAggregateItemStageTone(aggregateStage)}>
                {getAggregateItemStageCaption(aggregateStage)}
              </Badge>
              <p className="text-sm text-navy-600">
                {activeRequest.items.length} experience{activeRequest.items.length === 1 ? "" : "s"} ·{" "}
                {formatCurrency(activeRequest.estimatedTotal, "EUR")} {isFullyConfirmed ? "total" : "estimated"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-navy-500">No experiences requested yet for this stay.</p>
          )}

          <div className="flex flex-wrap gap-3">
            <Link
              href="/explore"
              className="inline-flex h-9 items-center justify-center rounded-full bg-navy-900 px-4 text-sm font-medium text-ivory-50 hover:bg-navy-950"
            >
              Discover experiences
            </Link>
            <Link
              href={`/recommendations?stay=${stay.id}`}
              className="inline-flex h-9 items-center justify-center rounded-full border border-navy-300 px-4 text-sm font-medium text-navy-900 hover:bg-ivory-200"
            >
              {activeRequest ? "Continue in planner" : "Open planner"}
            </Link>
          </div>
        </Card>

        <div className="mt-8">
          {experiences.length === 0 ? (
            <p className="text-sm text-navy-500">
              Nothing requested for this stay yet — discover experiences or open the planner above to get started.
            </p>
          ) : (
            <ExperienceStatusGroups items={experiences} showStay={false} />
          )}
        </div>
      </div>
    </div>
  );
}
