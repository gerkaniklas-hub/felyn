import Link from "next/link";
import { redirect } from "next/navigation";
import { RemoveStayButton } from "@/components/home/RemoveStayButton";
import { CalendarIcon, MapPinIcon, PlusIcon, UsersIcon } from "@/components/navigation/icons";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateRange } from "@/lib/format";
import { todayISODate } from "@/lib/onboarding/stay-dates";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
} from "@/lib/matching/booking-status";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * My trips: the guest's stays (their trips), as Upcoming / Past tabs
 * (?tab=past). Each opens that stay's trip planner
 * (/recommendations?stay=<id>); "Trip details" opens the stay overview
 * (/stays/<id>) and "Remove stay" works as before. Requested experiences,
 * with or without a trip, are their own section: Experiences (/experiences).
 *
 * The stays queries are exactly the ones the old /home dashboard used. Each stay's badge is
 * derived from its items' OWN statuses (deriveAggregateItemStage), never
 * booking_requests.status: that column is only ever 'REQUESTED' at insert
 * or 'WITHDRAWN' when the guest withdraws the whole request, so reading it
 * directly would leave a fully host-confirmed stay stuck on "Pending".
 * A guest can have several completed stays (each "Add a stay" run inserts a
 * new row), so all of them are listed; one active (REQUESTED/CONFIRMED)
 * request per stay is guaranteed by the DB's partial unique index.
 */
type TripTab = "upcoming" | "past";

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab: TripTab = tabParam === "past" ? "past" : "upcoming";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: stays } = await supabase
    .from("stays")
    .select("id, property_name, location_text, check_in, check_out, guest_count")
    .eq("user_id", user.id)
    .not("onboarding_completed_at", "is", null)
    .order("check_in", { ascending: true });

  const stayList = stays ?? [];
  // Upcoming includes a trip that's under way (check-out today or later). Stays
  // have no cancelled state in the database (a removed stay is deleted), so
  // there is no Cancelled tab.
  const today = todayISODate();
  const upcomingStays = stayList.filter((stay) => stay.check_out >= today);
  const pastStays = stayList.filter((stay) => stay.check_out < today).reverse();
  const shownStays = tab === "past" ? pastStays : upcomingStays;
  const tabs: { key: TripTab; label: string; count: number }[] = [
    { key: "upcoming", label: "Upcoming", count: upcomingStays.length },
    { key: "past", label: "Past", count: pastStays.length },
  ];

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
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-8 sm:px-6 md:py-12 lg:px-10">
        <section className="flex flex-col gap-6" aria-labelledby="my-trips">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 id="my-trips" className="font-display text-4xl leading-tight font-medium tracking-tight text-navy-950 sm:text-5xl">
                My trips
              </h1>
              <p className="mt-2 max-w-xl text-navy-500">Your stays and travel plans. Each trip opens its own planner.</p>
            </div>
            <Link
              href="/onboarding/add-stay"
              className="inline-flex h-10 items-center gap-2 rounded-full border border-navy-300 px-4 text-sm font-medium text-navy-900 transition-colors hover:bg-ivory-200"
            >
              <PlusIcon className="h-4 w-4" />
              Add a stay
            </Link>
          </div>

          <nav
            aria-label="Trips"
            className="inline-flex flex-wrap gap-1 self-start rounded-full border border-ivory-300 bg-ivory-50 p-1"
          >
            {tabs.map((item) => (
              <Link
                key={item.key}
                href={item.key === "upcoming" ? "/trips" : "/trips?tab=past"}
                aria-current={tab === item.key ? "page" : undefined}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  tab === item.key ? "bg-navy-900 text-ivory-50" : "text-navy-500 hover:text-navy-900"
                }`}
              >
                {item.label}
                <span className={`ml-1.5 text-xs ${tab === item.key ? "text-ivory-200" : "text-navy-300"}`}>{item.count}</span>
              </Link>
            ))}
          </nav>

          {shownStays.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {shownStays.map((stay) => {
                const activeRequest = activeRequestByStay.get(stay.id);
                const itemStatuses = activeRequest ? (itemStatusesByRequest.get(activeRequest.id) ?? []) : [];
                const itemCount = itemStatuses.length;
                const aggregateStage = deriveAggregateItemStage(itemStatuses);
                const isFullyConfirmed = aggregateStage === "confirmed";
                const experienceWord =
                  aggregateStage === "confirmed" ? "confirmed" : aggregateStage === "declined" ? "declined" : "requested";

                return (
                  <div
                    key={stay.id}
                    className="flex flex-col gap-4 rounded-3xl border border-ivory-300 bg-ivory-50 p-5 shadow-sm"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/recommendations?stay=${stay.id}`}
                        className="block truncate font-display text-xl text-navy-950 hover:text-sky-700"
                      >
                        {stay.property_name}
                      </Link>
                      <div className="mt-2 flex flex-col gap-1.5 text-sm text-navy-600">
                        <span className="flex items-center gap-2">
                          <MapPinIcon className="h-4 w-4 shrink-0 text-navy-300" />
                          <span className="truncate">{stay.location_text}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <CalendarIcon className="h-4 w-4 shrink-0 text-navy-300" />
                          {formatDateRange(stay.check_in, stay.check_out)}
                        </span>
                        <span className="flex items-center gap-2">
                          <UsersIcon className="h-4 w-4 shrink-0 text-navy-300" />
                          {stay.guest_count} guest{stay.guest_count === 1 ? "" : "s"}
                        </span>
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

                    <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ivory-300 pt-3">
                      <Link
                        href={`/recommendations?stay=${stay.id}`}
                        className="inline-flex h-9 items-center justify-center rounded-full bg-navy-900 px-4 text-sm font-medium text-ivory-50 transition-colors hover:bg-navy-950"
                      >
                        Open planner
                      </Link>
                      <Link href={`/stays/${stay.id}`} className="text-sm font-medium text-sky-600 hover:text-sky-700">
                        Trip details
                      </Link>
                      <div className="ml-auto">
                        <RemoveStayButton stay={stay} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-ivory-400 bg-ivory-50 px-6 py-10 text-center">
              {tab === "past" ? (
                <p className="text-navy-600">No past trips yet.</p>
              ) : (
                <>
                  <p className="text-navy-600">
                    {stayList.length === 0 ? "You haven’t added a stay yet." : "No upcoming trips."}
                  </p>
                  <Link href="/onboarding/add-stay" className="text-sm font-medium text-sky-600 hover:text-sky-700">
                    {stayList.length === 0 ? "Add your first stay →" : "Add a stay →"}
                  </Link>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
