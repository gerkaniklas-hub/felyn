import Link from "next/link";
import { ExploreBrowser } from "@/components/explore/ExploreBrowser";
import { GuestNav } from "@/components/navigation/GuestNav";
import { PlusIcon, SearchIcon } from "@/components/navigation/icons";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { getGuestStayOptions, getPublishedExperiences } from "@/lib/matching/explore";
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
 */
export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const firstName = (user?.user_metadata?.first_name as string | undefined)?.trim() || null;
  const [experiences, stays] = await Promise.all([getPublishedExperiences(supabase), getGuestStayOptions(supabase)]);
  const featured = experiences.slice(0, DISCOVER_COUNT);
  const heroImages = experiences.map((experience) => experience.image_url).filter(Boolean).slice(0, 2) as string[];

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-4 py-6 sm:px-6 md:py-10 lg:px-10">
        <section className="relative overflow-hidden rounded-[2rem] border border-ivory-300 bg-gradient-to-br from-ivory-50 via-ivory-50 to-sky-50">
          <div className="grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-[1.1fr_0.9fr] lg:p-12">
            <div className="flex flex-col gap-5">
              <h1 className="font-display text-4xl leading-tight font-medium tracking-tight text-navy-950 sm:text-5xl">
                {firstName ? `Good to see you again, ${firstName}` : "Good to see you again"}
              </h1>
              <p className="text-lg text-navy-500">Make more of the time together.</p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/explore"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 transition-colors hover:bg-navy-950"
                >
                  <SearchIcon className="h-5 w-5" />
                  Find an experience
                </Link>
                <Link
                  href="/onboarding/add-stay"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-navy-300 bg-ivory-50 px-6 text-base font-medium text-navy-900 transition-colors hover:bg-ivory-200"
                >
                  <PlusIcon className="h-5 w-5" />
                  Add a stay
                </Link>
              </div>
            </div>

            {heroImages.length > 0 ? (
              <div className="relative hidden h-72 lg:block" aria-hidden="true">
                <FallbackImage
                  src={heroImages[0]}
                  alt=""
                  className="absolute top-0 right-0 h-60 w-[78%] rounded-3xl shadow-lg"
                />
                {heroImages[1] ? (
                  <FallbackImage
                    src={heroImages[1]}
                    alt=""
                    className="absolute bottom-0 left-0 h-40 w-[48%] rounded-3xl border-4 border-ivory-50 shadow-lg"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-medium tracking-tight text-navy-950 sm:text-3xl">
                Experiences to discover
              </h2>
              <p className="mt-1 text-sm text-navy-500">Food and drink experiences from Felyn&apos;s hosts.</p>
            </div>
            <Link href="/explore" className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700">
              See all →
            </Link>
          </div>
          <ExploreBrowser experiences={featured} stays={stays} />
        </section>
      </div>
    </div>
  );
}
