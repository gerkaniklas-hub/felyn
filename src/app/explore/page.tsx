import { ExploreView } from "@/components/explore/ExploreView";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Heading } from "@/components/ui/heading";
import { getCanonicalLocations, getProviderServiceLocationTexts, getPublishedExperiences } from "@/lib/matching/explore";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * General experience discovery — no stay required. Deliberately simple:
 * every published experience, no hard filter, no AI ranking (see
 * getPublishedExperiences). Search, location and category chips filter that
 * same list client-side (ExploreView). The location picker offers Felyn's
 * canonical locations (public.locations); a chosen place matches each host's stored
 * base location and service locations. Adding a discovered experience to a stay is
 * out of scope for this milestone; browsing/viewing is enough (M6's
 * planner remains the only place a plan is actually built).
 */
export default async function ExplorePage() {
  const supabase = await createSupabaseServerClient();
  const [experiences, locations] = await Promise.all([getPublishedExperiences(supabase), getCanonicalLocations(supabase)]);
  const serviceLocationsByProvider = await getProviderServiceLocationTexts(supabase, [
    ...new Set(experiences.map((experience) => experience.provider_id)),
  ]);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 md:py-12 lg:px-10">
        <Heading level={1}>Explore experiences</Heading>
        <p className="mt-2 max-w-xl text-navy-500">
          Browse experiences from Felyn&apos;s hosts. Add a stay when you&apos;re ready to bring one to your trip.
        </p>
        <div className="mt-8">
          <ExploreView
            experiences={experiences}
            serviceLocationsByProvider={serviceLocationsByProvider}
            locations={locations}
          />
        </div>
      </div>
    </div>
  );
}
