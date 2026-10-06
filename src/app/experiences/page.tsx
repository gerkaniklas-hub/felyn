import Link from "next/link";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { GuestExperienceTabs } from "@/components/experiences/GuestExperienceTabs";
import { EmptyState, PageContainer, PageHeader, textLinkClass } from "@/components/ui/page";
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
      <PageContainer className="gap-8">
        <PageHeader
          title="Experiences"
          description={<>Every experience you&apos;ve requested, with or without a trip, and where things stand.</>}
        />

        {experiences.length === 0 ? (
          <EmptyState
            action={
              <Link href="/explore" className={textLinkClass}>
                Discover experiences →
              </Link>
            }
          >
            You haven&apos;t requested any experiences yet.
          </EmptyState>
        ) : (
          <GuestExperienceTabs items={experiences} />
        )}
      </PageContainer>
    </div>
  );
}
