import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarIcon, MapPinIcon, UsersIcon } from "@/components/navigation/icons";
import { formatDateRange } from "@/lib/format";
import { getLocation, getLocationContext } from "@/lib/locations";
import { getCanonicalLocations } from "@/lib/matching/explore";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardingBackLink } from "../back-link";

/**
 * Add a stay, step 2 of 2: a summary of what the guest entered, then on to
 * this stay's trip planner (/recommendations?stay=<id>) to plan experiences
 * day by day. Explore is offered too, with its "Where?" preselected to the
 * stay's canonical location (/explore?location=<id>). Nothing is booked or
 * chosen for them.
 */
export default async function StayReadyPage({ searchParams }: { searchParams: Promise<{ stay?: string }> }) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const [stay, locations] = await Promise.all([getStay(supabase, stayId), getCanonicalLocations(supabase)]);
  if (!stay) redirect("/onboarding/add-stay");

  const location = stay.location_id ? getLocation(locations, stay.location_id) : undefined;
  // property_name falls back to the location's name when left empty; don't show the same name twice.
  const showPropertyName = !location || stay.property_name !== location.name;
  const exploreHref = location ? `/explore?location=${encodeURIComponent(location.id)}` : "/explore";

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-10 px-5 py-8 sm:py-12">
      <OnboardingBackLink fallbackHref="/trips" />
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="font-display text-3xl font-medium tracking-tight text-navy-950 sm:text-4xl">Your stay is ready</h1>
          <p className="text-navy-500">We&apos;ll use your stay details to show you experiences nearby.</p>
        </div>

        <div className="flex flex-col gap-4 rounded-3xl border border-ivory-300 bg-ivory-50 p-6 shadow-sm sm:p-8">
          {showPropertyName ? <p className="font-display text-2xl text-navy-950">{stay.property_name}</p> : null}
          <div className="flex items-start gap-3">
            <MapPinIcon className="mt-0.5 h-5 w-5 shrink-0 text-navy-300" />
            {location ? (
              <div>
                <p className={showPropertyName ? "font-medium text-navy-900" : "font-display text-2xl text-navy-950"}>
                  {location.name}
                </p>
                <p className="text-sm text-navy-500">{getLocationContext(locations, location)}</p>
              </div>
            ) : (
              <p className="text-navy-900">{stay.location_text}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-ivory-300 pt-4 text-navy-700">
            <span className="flex items-center gap-3">
              <CalendarIcon className="h-5 w-5 shrink-0 text-navy-300" />
              {formatDateRange(stay.check_in, stay.check_out)}
            </span>
            <span className="flex items-center gap-3">
              <UsersIcon className="h-5 w-5 shrink-0 text-navy-300" />
              {stay.guest_count} guest{stay.guest_count === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4">
          <Link
            href={`/recommendations?stay=${stay.id}`}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 transition-colors hover:bg-navy-950"
          >
            Open your trip planner
          </Link>
          <Link
            href={exploreHref}
            className="inline-flex h-12 w-full items-center justify-center rounded-full border border-navy-300 px-6 text-base font-medium text-navy-900 transition-colors hover:bg-ivory-200"
          >
            Explore experiences
          </Link>
          <Link
            href={`/onboarding/add-stay?stay=${stay.id}`}
            className="text-sm font-medium text-sky-600 hover:text-sky-700"
          >
            Edit stay
          </Link>
        </div>
      </div>
    </div>
  );
}
