import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, cardSurface } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Eyebrow, PageHeader, textLinkClass } from "@/components/ui/page";
import { MonthCalendar, type CalendarEvent } from "@/components/provider/MonthCalendar";
import { ProviderBookingCard } from "@/components/provider/ProviderBookingCard";
import { UpcomingBookingRow } from "@/components/provider/UpcomingBookingRow";
import { HostProfileSummary } from "@/components/provider/HostProfileSummary";
import { getProviderIdentity, getProviderRequestItems } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="Your Felyn space" title={`Good to see you, ${identity.displayName.split(" ")[0]}.`} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Primary: what needs a decision, then what's coming up */}
        <div className="flex min-w-0 flex-col gap-6">
          <section className={`${cardSurface} p-6`} aria-labelledby="needs-attention">
            <div className="flex items-center justify-between gap-3">
              <Heading level={3} as="h2" id="needs-attention">
                Needs your attention
              </Heading>
              {requested.length > 0 ? (
                <Badge tone="gold" className="shrink-0">
                  {requested.length} new
                </Badge>
              ) : null}
            </div>
            {requested.length === 0 ? (
              <p className="mt-3 text-[15px] text-navy-500">No new requests</p>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                {requested.map((item) => (
                  <ProviderBookingCard
                    key={item.itemId}
                    item={item}
                    badgeOverride={{ label: "New request", tone: "gold" }}
                  />
                ))}
              </div>
            )}
          </section>

          <section className={`${cardSurface} p-6`} aria-labelledby="upcoming">
            <Heading level={3} as="h2" id="upcoming">
              Upcoming
            </Heading>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-[15px] text-navy-500">No upcoming experiences</p>
            ) : (
              <div className="mt-3 flex flex-col divide-y divide-ivory-300">
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
          </section>
        </div>

        {/* Supporting: the host's public profile at a glance */}
        <aside className={`${cardSurface} p-6 lg:sticky lg:top-6`} aria-labelledby="your-profile">
          <Eyebrow as="h2" className="mb-4">
            <span id="your-profile">Your profile</span>
          </Eyebrow>
          <HostProfileSummary identity={identity} />
        </aside>
      </div>

      <section className={`${cardSurface} p-6`} aria-labelledby="your-calendar">
        <div className="flex items-center justify-between gap-4">
          <Heading level={3} as="h2" id="your-calendar">
            Your calendar
          </Heading>
          <Link href="/provider/calendar" className={textLinkClass}>
            Full calendar →
          </Link>
        </div>
        <Link href="/provider/calendar" className="mt-5 block">
          <MonthCalendar year={now.getUTCFullYear()} month={now.getUTCMonth()} events={calendarEvents} compact />
        </Link>
      </section>
    </div>
  );
}
