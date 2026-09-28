import { ConversationList } from "@/components/messaging/ConversationList";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getProviderConversations } from "@/lib/messaging/conversations";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The provider Messages inbox (task 1) — every conversation the signed-in
 * provider has with a guest, across every one of their experiences, built
 * entirely from the existing messages/booking data (reuses
 * getProviderRequestItems wholesale — see getProviderConversations). Lives
 * inside app/provider/layout.tsx, so it already has ProviderNav.
 */
export default async function ProviderMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string }>;
}) {
  const { item } = await searchParams;
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
      <ConversationList conversations={conversations} autoOpenItemId={item} />
    </div>
  );
}
