import Link from "next/link";
import { ConversationList } from "@/components/messaging/ConversationList";
import { SupportConversationLinks } from "@/components/support/SupportConversationLinks";
import { SupportConversationPanel } from "@/components/support/SupportConversationPanel";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getProviderConversations } from "@/lib/messaging/conversations";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { getSupportConversations, getSupportThread } from "@/lib/support/queries";
import { isUuid } from "@/lib/support/thread-core";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The provider Messages inbox (task 1) — every conversation the signed-in
 * provider has with a guest, across every one of their experiences, built
 * entirely from the existing messages/booking data (reuses
 * getProviderRequestItems wholesale — see getProviderConversations). Lives
 * inside app/provider/layout.tsx, so it already has ProviderNav.
 *
 * Felyn Team (host support, 0029) conversations are listed above it — the
 * host's own HOST-side threads only (getSupportConversations(…, "host")), kept
 * entirely apart from guest conversations. `?support=` opens one as a panel on
 * this page (never in the floating chat window); `?item=` is unchanged.
 */
export default async function ProviderMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; support?: string }>;
}) {
  const { item, support } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const identity = user ? await getProviderIdentity(supabase, user.id) : null;

  if (!identity) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-navy-700">This account isn&apos;t linked to a Felyn provider profile yet.</p>
      </Card>
    );
  }

  const [supportConversations, openedThread] = await Promise.all([
    getSupportConversations(supabase, "host"),
    support && isUuid(support) ? getSupportThread(supabase, support, "host") : Promise.resolve(null),
  ]);
  const openedSummary = openedThread ? supportConversations.find((c) => c.threadId === openedThread.threadId) : undefined;

  if (openedThread && openedSummary) {
    return (
      <SupportConversationPanel
        thread={openedThread}
        category={openedSummary.category}
        experienceTitle={openedSummary.experienceTitle}
        requesterRole="host"
        backHref="/provider/messages"
        bookingHref={openedThread.bookingItemId ? `/provider/requests/${openedThread.bookingItemId}` : null}
      />
    );
  }

  const conversations = await getProviderConversations(supabase, identity.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-medium tracking-wide text-navy-300">MESSAGES</p>
        <Heading level={1} className="mt-2">
          Your conversations
        </Heading>
        <p className="mt-2 max-w-xl text-navy-500">Every conversation with a guest about one of your experiences.</p>
      </div>

      {support ? (
        <p className="rounded-lg bg-gold-100 px-3 py-2 text-sm font-medium text-gold-700">That conversation isn&apos;t available.</p>
      ) : null}

      {supportConversations.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-xl text-navy-950">Felyn Team</h2>
          <SupportConversationLinks conversations={supportConversations} requesterRole="host" />
        </section>
      ) : (
        <p className="text-sm text-navy-500">
          Need help from Felyn?{" "}
          <Link href="/provider/help" className="font-medium text-sky-600 hover:text-sky-700">
            Contact the Felyn Team
          </Link>
        </p>
      )}

      <ConversationList conversations={conversations} autoOpenItemId={item} />
    </div>
  );
}
