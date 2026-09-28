import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NotificationBellClient } from "./NotificationBellClient";

/** Server wrapper: fetches the guest's own notifications, then hands off to the interactive popover. */
export async function NotificationBell() {
  const supabase = await createSupabaseServerClient();
  const [notifications, unreadCount] = await Promise.all([
    getRecentNotifications(supabase),
    getUnreadNotificationCount(supabase),
  ]);

  return <NotificationBellClient notifications={notifications} unreadCount={unreadCount} />;
}
