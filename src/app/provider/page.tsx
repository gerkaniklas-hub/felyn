import Link from "next/link";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { MonthCalendar, type CalendarEvent } from "@/components/provider/MonthCalendar";
import { ProviderBookingCard } from "@/components/provider/ProviderBookingCard";
import { UpcomingBookingRow } from "@/components/provider/UpcomingBookingRow";
import { ViewPublicProfileButton } from "@/components/provider/ViewPublicProfileButton";
import { getProviderIdentity, getProviderRequestItems } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function humanize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * P1: "Your Felyn space" — the provider's dashboard/home. Identity comes
 * strictly from the signed-in user's own `providers` row (see
 * getProviderIdentity); request data is scoped to their own experiences
 * (see getProviderRequestItems, backed by the 0007 provider SELECT
 * policies).
 */
export default async function ProviderDashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const identity = user ? await getProviderIdentity(supabase, user.id) : null;

  if (!identity) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <Heading level={2}>Provider profile not found</Heading>
        <p className="mt-2 text-navy-500">This account isn&apos;t linked to a Felyn provider profile yet.</p>
      </Card>
    );
  }

  const items = await getProviderRequestItems(supabase, identity.id);

  const requested = items
    .filter((item) => item.status === "REQUESTED")
    .sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1));

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = items
    .filter((item) => item.status === "CONFIRMED" && item.plannedDate >= today)
    .sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1));

  const now = new Date();
  const calendarEvents: CalendarEvent[] = items.map((item) => ({
    itemId: item.itemId,
    date: item.plannedDate,
    moment: item.plannedMoment,
    preferredTime: item.preferredTime,
    status: item.status,
    title: item.experienceTitle,
    imageUrl: item.experienceImageUrl,
    stayName: item.stayName,
    guestCount: item.guestCount,
    pricePerPerson: item.pricePerPerson,
    currency: item.currency,
  }));

  return (
    <div className="flex flex-col gap-10">
      <div>
        <p className="text-xs font-medium tracking-wide text-navy-300">YOUR FELYN SPACE</p>
        <Heading level={1} className="mt-2">
          Good to see you, {identity.displayName.split(" ")[0]}.
        </Heading>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="flex flex-col items-center gap-3 text-center">
          <p className="self-start text-xs font-medium tracking-wide text-navy-300">YOUR PROFILE</p>
          <FallbackImage
            src={identity.profilePhotoUrl}
            alt={identity.displayName}
            className="h-24 w-24 rounded-full"
          />
          <div>
            <p className="font-display text-lg text-navy-950">{identity.displayName}</p>
            {identity.baseLocation ? <p className="text-sm text-navy-500">{identity.baseLocation}</p> : null}
          </div>
          {identity.specialties.length > 0 ? (
            <p className="text-sm text-navy-700">
              {identity.specialties.slice(0, 3).map((value) => humanize(value)).join(" & ")}
            </p>
          ) : null}
          {identity.bio ? <p className="line-clamp-3 text-sm text-navy-600">{identity.bio}</p> : null}
          {identity.languages.length > 0 ? (
            <p className="text-sm text-navy-500">{identity.languages.join(" · ")}</p>
          ) : null}
          <p className="text-sm font-medium text-navy-700">
            {identity.publishedExperienceCount} published experience
            {identity.publishedExperienceCount === 1 ? "" : "s"}
          </p>
          <ViewPublicProfileButton providerId={identity.id} providerName={identity.displayName} />
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <Heading level={3}>Needs your attention</Heading>
            {requested.length === 0 ? (
              <p className="mt-3 text-navy-500">No new requests</p>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {requested.map((item) => (
                  <ProviderBookingCard
                    key={item.itemId}
                    item={item}
                    badgeOverride={{ label: "NEW REQUEST", tone: "gold" }}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card>
            <Heading level={3}>Upcoming</Heading>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-navy-500">No upcoming experiences</p>
            ) : (
              <div className="mt-4 flex flex-col divide-y divide-ivory-300">
                {upcoming.map((item) => (
                  <UpcomingBookingRow
                    key={item.itemId}
                    itemId={item.itemId}
                    plannedDate={item.plannedDate}
                    experienceTitle={item.experienceTitle}
                    guestCount={item.guestCount}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <Heading level={3}>Your calendar</Heading>
          <Link href="/provider/calendar" className="text-sm font-medium text-sky-600 hover:text-sky-700">
            Full calendar →
          </Link>
        </div>
        <Link href="/provider/calendar" className="mt-4 block">
          <MonthCalendar year={now.getUTCFullYear()} month={now.getUTCMonth()} events={calendarEvents} compact />
        </Link>
      </Card>
    </div>
  );
}
