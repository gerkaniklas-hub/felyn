import Link from "next/link";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { GuestExperienceTabs } from "@/components/experiences/GuestExperienceTabs";
import { Heading } from "@/components/ui/heading";
import { getGuestExperiences } from "@/lib/matching/guest-experiences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Experiences: every experience the guest has requested or booked, with or
 * without a trip, as Upcoming / Past / Cancelled tabs (GuestExperienceTabs).
 * Each card shows its trip's name, or "No trip linked" for a request made
 * without one, and opens its booking detail (/bookings/<id>). Distinct from
 * Trips (the guest's stays, each with its planner) and from Explore
 * (discovering new experiences). Built entirely from getGuestExperiences.
 */
export default async function GuestExperiencesPage() {
  const supabase = await createSupabaseServerClient();
  const experiences = await getGuestExperiences(supabase);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 md:py-12 lg:px-10">
        <div>
          <Heading level={1}>Experiences</Heading>
          <p className="mt-2 max-w-xl text-navy-500">
            Every experience you&apos;ve requested, with or without a trip, and where things stand.
          </p>
        </div>

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
      </div>
    </div>
  );
}
