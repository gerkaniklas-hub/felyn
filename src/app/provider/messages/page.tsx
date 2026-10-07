import { HostInbox } from "@/components/messaging/HostInbox";
import { Card } from "@/components/ui/card";
import { getProviderConversations } from "@/lib/messaging/conversations";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { getSupportConversations } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The provider Messages inbox — every conversation the signed-in provider has
 * with a guest, across every one of their experiences, built entirely from the
 * existing messages/booking data (reuses getProviderRequestItems wholesale — see
 * getProviderConversations). Lives inside app/provider/layout.tsx, so it already
 * has ProviderNav.
 *
 * Shown as a two-pane inbox (HostInbox) with the same look as the guest inbox.
 * Felyn Team (host support, 0029) conversations are listed alongside — the host's
 * own HOST-side threads only (getSupportConversations(…, "host")), kept entirely
 * apart from guest conversations. `?item=` opens that guest conversation in the
 * pane and `?support=` that Felyn Team conversation; HostInbox only opens ids that
 * are in these two lists.
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

  const [conversations, supportConversations] = await Promise.all([
    getProviderConversations(supabase, identity.id),
    getSupportConversations(supabase, "host"),
  ]);

  return (
    <HostInbox
      conversations={conversations}
      initialItemId={item}
      supportConversations={supportConversations}
      initialSupportId={support}
    />
  );
}
