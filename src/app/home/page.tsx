import Link from "next/link";
import { redirect } from "next/navigation";
import { ExploreBrowser } from "@/components/explore/ExploreBrowser";
import { GuestNav } from "@/components/navigation/GuestNav";
import { PlusIcon, SearchIcon } from "@/components/navigation/icons";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { buttonClasses } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { PageContainer, textLinkClass } from "@/components/ui/page";
import { getGuestStayOptions, getPublishedExperiences } from "@/lib/matching/explore";
import { isFelynStaff } from "@/lib/support/staff";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** How many experiences the Home discovery strip shows before "See all". */
const DISCOVER_COUNT = 3;

/**
 * The guest's Home: the landing page after a guest login. A welcome and
 * the two things to do next (find an experience, add a stay), then a short
 * discovery strip. Trip and booking management lives on /trips (this page
 * used to be that dashboard).
 *
 * The discovery strip reuses Explore's own data (getPublishedExperiences,
 * newest first) and Explore's card grid, so opening a card shows the same
 * experience and host detail panels as /explore. No ranking or location
 * data exists yet, so it is labelled as discovery, not "popular near you".
 *
 * Felyn staff accounts don't belong in the guest home: they are sent to the
 * support inbox (this also covers every "signed in -> /home" redirect, e.g. a
 * signed-in visit to /login). The support area is a dedicated workspace and
 * deliberately has no link into the guest app.
 */
export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const firstName = (user?.user_metadata?.first_name as string | undefined)?.trim() || null;
  const [isStaff, experiences, stays] = await Promise.all([
    user ? isFelynStaff(supabase) : false,
    getPublishedExperiences(supabase),
    getGuestStayOptions(supabase),
  ]);
  if (isStaff) redirect("/admin/support");
  const featured = experiences.slice(0, DISCOVER_COUNT);
  const heroImages = experiences.map((experience) => experience.image_url).filter(Boolean).slice(0, 2) as string[];

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <PageContainer className="gap-12 md:gap-16">
        <section className="relative overflow-hidden rounded-panel border border-ivory-300 bg-gradient-to-br from-ivory-50 via-ivory-50 to-sky-50">
          <div className="grid items-center gap-10 p-6 sm:p-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:p-14">
            <div className="flex flex-col gap-6">
              <Heading level="display">
                {firstName ? `Good to see you again, ${firstName}` : "Good to see you again"}
              </Heading>
              <p className="max-w-md text-lg leading-relaxed text-navy-500">Make more of the time together.</p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <Link href="/explore" className={buttonClasses({ size: "lg" })}>
                  <SearchIcon className="h-5 w-5" />
                  Find an experience
                </Link>
                <Link href="/onboarding/add-stay" className={buttonClasses({ variant: "secondary", size: "lg" })}>
                  <PlusIcon className="h-5 w-5" />
                  Add a stay
                </Link>
              </div>
            </div>

            {heroImages.length > 0 ? (
              <div className="relative hidden aspect-[5/4] lg:block" aria-hidden="true">
                <FallbackImage
                  src={heroImages[0]}
                  alt=""
                  className="absolute top-0 right-0 h-[82%] w-[80%] rounded-card shadow-float"
                />
                {heroImages[1] ? (
                  <FallbackImage
                    src={heroImages[1]}
                    alt=""
                    className="absolute bottom-0 left-0 aspect-[4/3] w-[46%] rounded-card border-4 border-ivory-50 shadow-float"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-6" aria-labelledby="home-discover">
          <div className="flex items-end justify-between gap-4">
            <div>
              <Heading level={2} id="home-discover">
                Experiences to discover
              </Heading>
              <p className="mt-2 text-[15px] text-navy-500">Food and drink experiences from Felyn&apos;s hosts.</p>
            </div>
            <Link href="/explore" className={`shrink-0 ${textLinkClass}`}>
              See all →
            </Link>
          </div>
          <ExploreBrowser experiences={featured} stays={stays} />
        </section>
      </PageContainer>
    </div>
  );
}
