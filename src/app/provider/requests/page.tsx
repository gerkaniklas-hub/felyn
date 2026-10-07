import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { EmptyState, Eyebrow, PageHeader } from "@/components/ui/page";
import { ProviderBookingCard } from "@/components/provider/ProviderBookingCard";
import { getProviderIdentity, getProviderRequestItems, type ProviderRequestItem } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function groupByStay(items: ProviderRequestItem[]): { stayName: string; items: ProviderRequestItem[] }[] {
  const order: string[] = [];
  const byStay = new Map<string, ProviderRequestItem[]>();
  for (const item of items) {
    if (!byStay.has(item.requestId)) order.push(item.requestId);
    const list = byStay.get(item.requestId) ?? [];
    list.push(item);
    byStay.set(item.requestId, list);
  }
  return order.map((requestId) => {
    const groupItems = byStay.get(requestId)!;
    return { stayName: groupItems[0].stayName, items: groupItems };
  });
}

/**
 * P1.2: reorganised into PENDING/CONFIRMED/CANCELLED/DECLINED sections,
 * each grouped by the guest's stay so a provider with several items for
 * the same stay (see getProviderRequestItems) can see that relationship at
 * a glance. Every item keeps its OWN status and its own decision — no bulk
 * actions. Each booking is the SAME `ProviderBookingCard` used on the
 * dashboard, linking to the one shared detail page (task 1/4: no duplicate
 * detail UI) — cancellation actor/reason/note render there automatically
 * (see ProviderBookingCard's own cancellation branch), never re-implemented
 * here.
 *
 * Booking-lifecycle milestone: CANCELLED gets its own section — previously
 * getProviderRequestItems already fetched a cancelled item (it survives a
 * withdrawn parent request the same way CONFIRMED/DECLINED items do), but
 * this page's three-way REQUESTED/CONFIRMED/DECLINED split silently
 * dropped it: it matched none of the three filters and simply never
 * rendered anywhere on this page. Fixed by adding a fourth bucket.
 */
export default async function ProviderRequestsPage() {
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

  const items = (await getProviderRequestItems(supabase, identity.id)).sort((a, b) =>
    a.plannedDate < b.plannedDate ? -1 : 1,
  );

  const pending = items.filter((item) => item.status === "REQUESTED");
  const confirmed = items.filter((item) => item.status === "CONFIRMED");
  const cancelled = items.filter((item) => item.status === "CANCELLED");
  const declined = items.filter((item) => item.status === "DECLINED");

  function section(title: string, groupedItems: ProviderRequestItem[], emptyLabel: string) {
    return (
      <section className="flex flex-col gap-3">
        <Eyebrow as="h2">{title}</Eyebrow>
        {groupedItems.length === 0 ? (
          <p className="rounded-card border border-dashed border-ivory-400 bg-ivory-50/70 px-5 py-4 text-sm text-navy-500">
            {emptyLabel}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groupByStay(groupedItems).map(({ stayName, items: stayItems }) => (
              <div key={stayItems[0].requestId} className="flex flex-col gap-3">
                <p className="text-sm font-medium text-navy-600">{stayName}</p>
                <div className="flex flex-col gap-3">
                  {stayItems.map((item) => (
                    <ProviderBookingCard key={item.itemId} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="Your requests"
        title="Requests"
        description="Everything requested or decided for your experiences. Open a pending request to confirm or decline it."
      />

      {items.length === 0 ? (
        <EmptyState>No new requests</EmptyState>
      ) : (
        <>
          {section("Pending requests", pending, "No pending requests")}
          {section("Confirmed", confirmed, "No confirmed experiences yet")}
          {section("Cancelled", cancelled, "No cancelled experiences")}
          {section("Declined", declined, "No declined requests")}
        </>
      )}
    </div>
  );
}
