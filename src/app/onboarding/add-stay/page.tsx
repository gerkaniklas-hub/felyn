import { findConfidentLocationMatch } from "@/lib/locations";
import { getCanonicalLocations } from "@/lib/matching/explore";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardingBackLink } from "../back-link";
import { AddStayForm } from "./add-stay-form";

/**
 * Add a stay, step 1 of 2: one form with everything Felyn needs as context
 * (where, when, how many; name optional). `?stay=<id>` edits an existing
 * stay. A stay saved before canonical locations has only free text: if that
 * text confidently names one location it's preselected, otherwise the guest
 * chooses. Opening the form never changes the stay; only saving does.
 * Step 2 is /onboarding/stay-ready.
 */
export default async function AddStayPage({ searchParams }: { searchParams: Promise<{ stay?: string }> }) {
  const { stay: stayId } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const [stay, locations] = await Promise.all([
    stayId ? getStay(supabase, stayId) : Promise.resolve(null),
    getCanonicalLocations(supabase),
  ]);

  const knownLocationId =
    stay?.location_id && locations.some((location) => location.id === stay.location_id) ? stay.location_id : null;
  const legacyMatch = stay && !knownLocationId ? findConfidentLocationMatch(locations, stay.location_text) : null;
  const initialLocationId = knownLocationId ?? legacyMatch?.id ?? null;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-10 px-5 py-8 sm:py-12">
      <OnboardingBackLink fallbackHref={stay ? `/onboarding/stay-ready?stay=${stay.id}` : "/home"} />
      <div className="flex flex-col gap-8 sm:rounded-3xl sm:border sm:border-ivory-300 sm:bg-ivory-50 sm:p-10 sm:shadow-sm">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="font-display text-3xl font-medium tracking-tight text-navy-950 sm:text-4xl">
            {stay ? "Edit your stay" : "Add your stay"}
          </h1>
          <p className="text-navy-500">Tell us where you&apos;re staying so we can show you experiences nearby.</p>
        </div>
        <AddStayForm
          stay={stay}
          locations={locations}
          initialLocationId={initialLocationId}
          unmatchedLocationText={stay && !initialLocationId ? stay.location_text : null}
        />
      </div>
    </div>
  );
}
