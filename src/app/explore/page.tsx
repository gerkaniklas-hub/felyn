import { ExploreView } from "@/components/explore/ExploreView";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { PageContainer, PageHeader } from "@/components/ui/page";
import {
  getCanonicalLocations,
  getGuestStayOptions,
  getProviderServiceLocationTexts,
  getPublishedExperiences,
} from "@/lib/matching/explore";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * General experience discovery — no stay required. Deliberately simple:
 * every published experience, no hard filter, no AI ranking (see
 * getPublishedExperiences). Search, location and category chips filter that
 * same list client-side (ExploreView). The location picker offers Felyn's
 * canonical locations (public.locations); a chosen place matches each host's stored
 * base location and service locations. `?location=<id>` (the "Explore
 * experiences" link after adding a stay) preselects that canonical location
 * when it exists; anything else is ignored. Adding a discovered experience to a stay is
 * out of scope for this milestone; browsing/viewing is enough (M6's
 * planner remains the only place a plan is actually built).
 */
export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const { location: requestedLocationId } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [experiences, locations, stays] = await Promise.all([
    getPublishedExperiences(supabase),
    getCanonicalLocations(supabase),
    getGuestStayOptions(supabase),
  ]);
  const serviceLocationsByProvider = await getProviderServiceLocationTexts(supabase, [
    ...new Set(experiences.map((experience) => experience.provider_id)),
  ]);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <PageContainer>
        <PageHeader
          title="Explore experiences"
          description={<>Browse experiences from Felyn&apos;s hosts. Add a stay when you&apos;re ready to bring one to your trip.</>}
        />
        <div className="mt-8 md:mt-10">
          <ExploreView
            experiences={experiences}
            serviceLocationsByProvider={serviceLocationsByProvider}
            locations={locations}
            stays={stays}
            initialLocationId={locations.some((location) => location.id === requestedLocationId) ? requestedLocationId : undefined}
          />
        </div>
      </PageContainer>
    </div>
  );
}
