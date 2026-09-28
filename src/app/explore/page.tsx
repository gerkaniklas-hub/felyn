import { ExploreBrowser } from "@/components/explore/ExploreBrowser";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Heading } from "@/components/ui/heading";
import { getPublishedExperiences } from "@/lib/matching/explore";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * General experience discovery — no stay required. Deliberately simple:
 * every published experience, no hard filter, no AI ranking (see
 * getPublishedExperiences). Adding a discovered experience to a stay is
 * out of scope for this milestone; browsing/viewing is enough (M6's
 * planner remains the only place a plan is actually built).
 */
export default async function ExplorePage() {
  const supabase = await createSupabaseServerClient();
  const experiences = await getPublishedExperiences(supabase);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <p className="text-xs font-medium tracking-wide text-navy-300">EXPLORE</p>
      <Heading level={1} className="mt-2">
        Discover Felyn experiences
      </Heading>
      <p className="mt-3 max-w-xl text-navy-500">
        Browse experiences from Felyn&apos;s hosts. Add a stay when you&apos;re ready to bring one
        to your trip.
      </p>
      <div className="mt-8">
        <ExploreBrowser experiences={experiences} />
      </div>
      </div>
    </div>
  );
}
