"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertGuestJourney } from "@/lib/journey-server";

export type NotificationActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't update your notifications. Please try again.";

/** RLS ("Users manage their own notifications", 0009) scopes both of these to the caller's own rows. */
export async function markNotificationRead(notificationId: string): Promise<NotificationActionResult> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .is("read_at", null);

  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

export async function markAllNotificationsRead(): Promise<NotificationActionResult> {
  await assertGuestJourney();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You need to be signed in." };

  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);

  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}
