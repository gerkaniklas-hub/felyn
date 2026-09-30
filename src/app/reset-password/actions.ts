"use server";

import { cookies } from "next/headers";
import { getHostAccess } from "@/lib/host-application/queries";
import { JOURNEY_COOKIE, JOURNEY_COOKIE_OPTIONS, journeyForLoginDestination } from "@/lib/journey";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Called after a successful password reset to pick where the user lands.
 * The DATABASE decides, exactly as for host access everywhere else: an
 * approved host (a providers row, via getHostAccess) goes to /provider in
 * the host journey; everyone else to /home in the guest journey. The journey
 * cookie is only written as the result of that check — it selects the
 * experience and grants nothing. getHostAccess throws on a failed read, so a
 * database error never silently routes a host into the guest experience.
 */
export async function getPostResetDestination(): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/login";

  const { providerId } = await getHostAccess(supabase, user.id);
  const destination = providerId ? "/provider" : "/home";
  (await cookies()).set(JOURNEY_COOKIE, journeyForLoginDestination(destination), JOURNEY_COOKIE_OPTIONS);
  return destination;
}
