import Link from "next/link";
import { RemoveStayButton } from "@/components/home/RemoveStayButton";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { formatCurrency, formatDateRange } from "@/lib/format";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
} from "@/lib/matching/booking-status";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logout } from "./actions";

/**
 * The authenticated entry point: Login -> Home -> "Add a stay" or "Find an
 * experience". Deliberately does NOT force a stay to exist (M3's own
 * decision to never auto-resume a draft stands — see stay-dates.ts /
 * onboarding).
 *
 * M6.5: a guest can have multiple completed stays (each "Add a stay" run
 * inserts a new row rather than overwriting one — see manual/actions.ts),
 * so Home lists all of them rather than assuming just one.
 *
 * Milestone 1: each stay card now links to its own dedicated overview
 * (/stays/[stayId]) rather than straight into the planner — the overview
 * shows the stay's details and requested experiences, with the planner
 * (/recommendations) reachable from there, not as Home's direct target.
 */
export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: stays } = await supabase
    .from("stays")
    .select("id, property_name, location_text, check_in, check_out, guest_count")
    .eq("user_id", user?.id)
    .not("onboarding_completed_at", "is", null)
    .order("check_in", { ascending: true });

  const stayList = stays ?? [];
  const firstName = (user?.user_metadata?.first_name as string | undefined)?.trim() || null;

  // M7.2: so a returning guest can see at a glance whether they've already
  // submitted a request for a stay — one request per stay is guaranteed
  // active (REQUESTED/CONFIRMED) by the DB's partial unique index.
  //
  // Booking-lifecycle milestone: the badge itself is derived from each
  // item's OWN status (deriveAggregateItemStage), not from
  // booking_requests.status — that column is only ever 'REQUESTED' at
  // insert or 'WITHDRAWN' if the guest withdraws the whole request; no
  // code path ever sets it to 'CONFIRMED', so reading it directly (the
  // previous behavior here) meant a fully host-confirmed stay could never
  // show anything but "Pending confirmation". Item statuses are needed to
  // fix that, so this now selects `status` per item instead of just
  // counting rows.
  const stayIds = stayList.map((stay) => stay.id);
  type ActiveRequestRow = { id: string; stay_id: string; status: ActiveBookingRequestStatus; estimated_total: number };
  const activeRequestByStay = new Map<string, ActiveRequestRow>();
  const itemStatusesByRequest = new Map<string, BookingItemStatus[]>();
  if (stayIds.length > 0) {
    const { data: activeRequests } = await supabase
      .from("booking_requests")
      .select("id, stay_id, status, estimated_total")
      .in("stay_id", stayIds)
      .in("status", ["REQUESTED", "CONFIRMED"]);
    for (const row of (activeRequests as ActiveRequestRow[] | null) ?? []) {
      activeRequestByStay.set(row.stay_id, row);
    }

    const requestIds = [...activeRequestByStay.values()].map((row) => row.id);
    if (requestIds.length > 0) {
      const { data: itemRows } = await supabase
        .from("booking_request_items")
        .select("booking_request_id, status")
        .in("booking_request_id", requestIds);
      for (const row of (itemRows as { booking_request_id: string; status: BookingItemStatus }[] | null) ?? []) {
        const list = itemStatusesByRequest.get(row.booking_request_id) ?? [];
        list.push(row.status);
        itemStatusesByRequest.set(row.booking_request_id, list);
      }
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <Heading level={1}>{firstName ? `Welcome back, ${firstName}` : "Welcome back"}</Heading>
        <p className="max-w-md text-navy-600">
          Make more of the time together — add a stay, or find an experience for one you&apos;ve
          already planned.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <Link
          href="/onboarding/add-stay"
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 hover:bg-navy-950 sm:w-auto"
        >
          + Add a stay
        </Link>
        <Link
          href="/explore"
          className="inline-flex h-11 w-full items-center justify-center rounded-full border border-navy-300 px-6 text-base font-medium text-navy-900 hover:bg-ivory-200 sm:w-auto"
        >
          Explore experiences
        </Link>
      </div>

      <Link
        href="/experiences"
        className="mx-auto text-sm font-medium text-sky-600 hover:text-sky-700"
      >
        View all your experiences and bookings →
      </Link>

      <div className="flex flex-col gap-3">
        <p className="text-center text-xs font-medium tracking-wide text-navy-300 uppercase">
          Your stays
        </p>
        {stayList.length > 0 ? (
          stayList.map((stay) => {
            const activeRequest = activeRequestByStay.get(stay.id);
            const itemStatuses = activeRequest ? (itemStatusesByRequest.get(activeRequest.id) ?? []) : [];
            const itemCount = itemStatuses.length;
            const aggregateStage = deriveAggregateItemStage(itemStatuses);
            const isFullyConfirmed = aggregateStage === "confirmed";
            const experienceWord =
              aggregateStage === "confirmed" ? "confirmed" : aggregateStage === "declined" ? "declined" : "requested";

            return (
              <div key={stay.id} className="mx-auto w-full max-w-md">
                <Card className="flex flex-col gap-3">
                  <div className="flex items-center gap-4">
                    <FallbackImage
                      src={null}
                      alt={stay.property_name}
                      className="h-16 w-16 shrink-0 rounded-xl"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-lg text-navy-950">{stay.property_name}</p>
                      <p className="truncate text-sm text-navy-600">{stay.location_text}</p>
                      <p className="text-sm text-navy-600">
                        {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guest
                        {stay.guest_count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>

                  {activeRequest ? (
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={getAggregateItemStageTone(aggregateStage)}>
                        {getAggregateItemStageCaption(aggregateStage)}
                      </Badge>
                      <p className="text-sm text-navy-600">
                        {itemCount} experience{itemCount === 1 ? "" : "s"} {experienceWord} ·{" "}
                        {formatCurrency(activeRequest.estimated_total, "EUR")}{" "}
                        {isFullyConfirmed ? "total" : "estimated"}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-navy-500">No experiences requested yet.</p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Link
                      href={`/stays/${stay.id}`}
                      className="text-sm font-medium text-sky-600 hover:text-sky-700"
                    >
                      {activeRequest ? "View your request →" : "Discover experiences →"}
                    </Link>
                    <div className="ml-auto">
                      <RemoveStayButton stay={stay} />
                    </div>
                  </div>
                </Card>
              </div>
            );
          })
        ) : (
          <div className="mx-auto w-full max-w-md">
            <Card className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-navy-600">You haven&apos;t added a stay yet.</p>
              <Link
                href="/onboarding/add-stay"
                className="text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                Add your first stay →
              </Link>
            </Card>
          </div>
        )}
      </div>

      <form action={logout} className="mx-auto">
        <Button type="submit" variant="ghost" size="sm">
          Log out
        </Button>
      </form>
      </div>
    </div>
  );
}
