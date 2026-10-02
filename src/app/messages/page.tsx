import { redirect } from "next/navigation";
import { GuestInbox } from "@/components/messaging/GuestInbox";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { getGuestConversations } from "@/lib/messaging/conversations";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The guest Messages inbox (task 1) — every conversation the signed-in
 * guest has with a host, across every stay, built entirely from the
 * existing messages/booking data (see getGuestConversations). Shown as a
 * two-pane inbox (GuestInbox). `?item=` (used by the floating chat's
 * "expand" control) opens that one conversation on load.
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
      <div className="mx-auto w-full max-w-7xl flex-1 md:px-6 md:py-6 lg:px-8">
        <GuestInbox conversations={conversations} initialItemId={item} />
      </div>
    </div>
  );
}
