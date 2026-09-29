// Server-only by construction: next/headers cannot be imported into client components.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { JOURNEY_COOKIE, parseJourney, type Journey } from "./journey";

export async function getJourney(): Promise<Journey> {
  const cookieStore = await cookies();
  return parseJourney(cookieStore.get(JOURNEY_COOKIE)?.value);
}

/**
 * Guard for GUEST-ONLY Server Actions. Server Actions are POSTs to whatever
 * route uses them, and their IDs are opaque, so proxy.ts cannot tell which
 * action a request invokes — each guest action must check for itself.
 * In the host journey the guest experience is off, so the action is refused
 * and the user is sent to the host experience (/host/apply routes on to
 * /provider or /host/application from the database).
 *
 * This enforces the journey separation only. Data access is still
 * authorized by each action's own session check and RLS, unchanged.
 */
export async function assertGuestJourney(): Promise<void> {
  if ((await getJourney()) === "host") redirect("/host/apply");
}

/**
 * Guard for Server Actions SHARED by the guest and host experiences
 * (messaging, public provider profiles). In the guest journey nothing
 * changes. In the host journey only an approved host (a providers row, read
 * via RLS) may use them — a pending or rejected applicant has no host
 * conversations or host profile, so any use there would be guest-side and
 * is refused.
 */
export async function assertSharedActionAllowedForJourney(): Promise<void> {
  if ((await getJourney()) !== "host") return;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return; // the action's own auth check handles signed-out callers
  const { data } = await supabase.from("providers").select("id").eq("user_id", user.id).maybeSingle();
  if (!data) redirect("/host/apply");
}
