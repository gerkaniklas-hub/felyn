"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/** RLS ("Users manage their own notifications", 0009) scopes both of these to the caller's own rows. */
export async function markNotificationRead(notificationId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .is("read_at", null);
}

export async function markAllNotificationsRead(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);
}
