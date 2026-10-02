import Link from "next/link";
import { redirect } from "next/navigation";
import { GuestExperienceTabs } from "@/components/experiences/GuestExperienceTabs";
import { RemoveStayButton } from "@/components/home/RemoveStayButton";
import { CalendarIcon, MapPinIcon, PlusIcon, UsersIcon } from "@/components/navigation/icons";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { formatCurrency, formatDateRange } from "@/lib/format";
import {
  deriveAggregateItemStage,
  getAggregateItemStageCaption,
  getAggregateItemStageTone,
  type ActiveBookingRequestStatus,
  type BookingItemStatus,
} from "@/lib/matching/booking-status";
import { getGuestExperiences } from "@/lib/matching/guest-experiences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * My trips: everything the guest has planned, in one place. Two parts, both
 * moved here unchanged in data and behaviour:
 *
 * - The Upcoming / Past / Cancelled experience tabs (GuestExperienceTabs,
 *   fed by getGuestExperiences), previously the /experiences page, which
 *   now redirects here.
 * - The guest's stays with their request status, "Add a stay" and "Remove
 *   stay", previously the /home dashboard. /home is now the guest's
 *   welcome screen instead.
 *
 * The stays queries are exactly the ones /home used. Each stay's badge is
 * derived from its items' OWN statuses (deriveAggregateItemStage), never
 * booking_requests.status: that column is only ever 'REQUESTED' at insert
 * or 'WITHDRAWN' when the guest withdraws the whole request, so reading it
 * directly would leave a fully host-confirmed stay stuck on "Pending".
 * A guest can have several completed stays (each "Add a stay" run inserts a
 * new row), so all of them are listed; one active (REQUESTED/CONFIRMED)
 * request per stay is guaranteed by the DB's partial unique index.
 */
export default async function TripsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: stays }, experiences] = await Promise.all([
    supabase
      .from("stays")
      .select("id, property_name, location_text, check_in, check_out, guest_count")
      .eq("user_id", user.id)
      .not("onboarding_completed_at", "is", null)
      .order("check_in", { ascending: true }),
    getGuestExperiences(supabase),
  ]);

  const stayList = stays ?? [];

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
        <div>
          <Heading level={1}>My trips</Heading>
          <p className="mt-2 max-w-xl text-navy-500">
            Your upcoming and past experiences, and the stays you&apos;ve added, all in one place.
          </p>
        </div>

        <section aria-label="Your experiences">
          {experiences.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-ivory-400 bg-ivory-50 px-6 py-12 text-center">
              <p className="text-navy-600">You haven&apos;t requested any experiences yet.</p>
              <Link href="/explore" className="text-sm font-medium text-sky-600 hover:text-sky-700">
                Discover experiences →
              </Link>
            </div>
          ) : (
            <GuestExperienceTabs items={experiences} />
          )}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="your-stays">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="your-stays" className="font-display text-2xl font-medium tracking-tight text-navy-950">
                Your stays
              </h2>
              <p className="mt-1 text-sm text-navy-500">Plan experiences around the places you&apos;re staying.</p>
            </div>
            <Link
              href="/onboarding/add-stay"
              className="inline-flex h-10 items-center gap-2 rounded-full border border-navy-300 px-4 text-sm font-medium text-navy-900 transition-colors hover:bg-ivory-200"
            >
              <PlusIcon className="h-4 w-4" />
              Add a stay
            </Link>
          </div>

          {stayList.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {stayList.map((stay) => {
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
                      <p className="truncate font-display text-xl text-navy-950">{stay.property_name}</p>
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
                      <Link href={`/stays/${stay.id}`} className="text-sm font-medium text-sky-600 hover:text-sky-700">
                        {activeRequest ? "View your request →" : "Discover experiences →"}
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
              <p className="text-navy-600">You haven&apos;t added a stay yet.</p>
              <Link href="/onboarding/add-stay" className="text-sm font-medium text-sky-600 hover:text-sky-700">
                Add your first stay →
              </Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
