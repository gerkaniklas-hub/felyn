import { redirect } from "next/navigation";
import { ConversationList } from "@/components/messaging/ConversationList";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Heading } from "@/components/ui/heading";
import { getGuestConversations } from "@/lib/messaging/conversations";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The guest Messages inbox (task 1) — every conversation the signed-in
 * guest has with a host, across every stay, built entirely from the
 * existing messages/booking data (see getGuestConversations). `?item=`
 * (used by the floating chat's "expand" control) auto-opens that one
 * conversation in the floating window on load.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string }>;
}) {
  const { item } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const conversations = await getGuestConversations(supabase);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-xs font-medium tracking-wide text-navy-300">MESSAGES</p>
        <Heading level={1} className="mt-2">
          Your conversations
        </Heading>
        <p className="mt-2 max-w-xl text-navy-500">
          Every conversation with a host about one of your experiences, in one place.
        </p>
        <div className="mt-6">
          <ConversationList conversations={conversations} autoOpenItemId={item} />
        </div>
      </div>
    </div>
  );
}
