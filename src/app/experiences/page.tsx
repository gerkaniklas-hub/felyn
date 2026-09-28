import Link from "next/link";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ExperienceStatusGroups } from "@/components/experiences/ExperienceStatusGroups";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getGuestExperiences } from "@/lib/matching/guest-experiences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Milestone 1: every experience the guest has ever requested, across every
 * stay, grouped by its own status — distinct from /explore (discovering
 * NEW experiences) and from a single stay's planner (building a NEW plan).
 * Built entirely from getGuestExperiences (existing booking-request data;
 * no parallel system). "Completed" is intentionally not a bucket yet — see
 * that function's own comment.
 */
export default async function GuestExperiencesPage() {
  const supabase = await createSupabaseServerClient();
  const experiences = await getGuestExperiences(supabase);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-xs font-medium tracking-wide text-navy-300">EXPERIENCES</p>
        <Heading level={1} className="mt-2">
          Your experiences
        </Heading>
        <p className="mt-2 max-w-xl text-navy-500">
          Every experience you&apos;ve requested, across every stay, and where things stand.
        </p>

        {experiences.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-navy-600">You haven&apos;t requested any experiences yet.</p>
            <Link href="/explore" className="text-sm font-medium text-sky-600 hover:text-sky-700">
              Discover experiences →
            </Link>
          </Card>
        ) : (
          <div className="mt-8">
            <ExperienceStatusGroups items={experiences} />
          </div>
        )}
      </div>
    </div>
  );
}
