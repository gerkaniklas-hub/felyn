import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Felyn staff authorization for server code (Server Components, Server Actions,
 * Route Handlers). The database decides: public.is_felyn_staff() (0029) checks the
 * signed-in user against public.staff_members, which no client can read or change.
 * Nothing here trusts an email address, a cookie or the journey.
 *
 * This is a convenience gate, not the security boundary: every support table and
 * staff function re-checks staff status itself, so a caller that skips this helper
 * still gets nothing. Call it in EVERY admin page and EVERY staff Server Action —
 * a layout check alone is not enough (layouts don't re-run on navigation, and
 * Server Actions are reachable directly).
 */
export type StaffContext = {
  /** The caller's own session client (RLS applies as the staff user — never the service-role key). */
  supabase: SupabaseClient;
  userId: string;
};

/** Whether the client's signed-in user is Felyn staff, asked of the database. Fails closed: a failed check counts as "not staff". */
export async function isFelynStaff(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_felyn_staff");
  if (error) {
    console.error(`support: staff check failed (code ${error.code ?? "unknown"})`);
    return false;
  }
  return data === true;
}

/** The staff context, or null for signed-out and non-staff callers. Fails closed: a failed check counts as "not staff". */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return (await isFelynStaff(supabase)) ? { supabase, userId: user.id } : null;
}

/** For admin pages and staff Server Actions: non-staff get a plain 404, so the admin area's existence isn't revealed. */
export async function requireStaff(): Promise<StaffContext> {
  const staff = await getStaffContext();
  if (!staff) notFound();
  return staff;
}
