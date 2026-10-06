import { redirect } from "next/navigation";
import { GuestInbox } from "@/components/messaging/GuestInbox";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { getGuestConversations } from "@/lib/messaging/conversations";
import { getGuestSupportConversations } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The guest Messages inbox (task 1) — every conversation the signed-in
 * guest has with a host, across every stay, built entirely from the
 * existing messages/booking data (see getGuestConversations). Shown as a
 * two-pane inbox (GuestInbox). `?item=` (used by the floating chat's
 * "expand" control) opens that one conversation on load.
 *
 * The guest's Felyn Team (support) conversations are listed alongside;
 * `?support=` opens one (where Contact Felyn and Get help land).
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; support?: string }>;
}) {
  const { item, support } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [conversations, supportConversations] = await Promise.all([
    getGuestConversations(supabase),
    getGuestSupportConversations(supabase),
  ]);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      {/* Same width and gutters as PageContainer; the inbox fills the viewport height (see GuestInbox). */}
      <div className="mx-auto w-full max-w-6xl flex-1 md:px-6 md:py-8 lg:px-12">
        <GuestInbox
          conversations={conversations}
          initialItemId={item}
          supportConversations={supportConversations}
          initialSupportId={support}
        />
      </div>
    </div>
  );
}
