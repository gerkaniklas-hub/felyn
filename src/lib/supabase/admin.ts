import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client with the project's SECRET key (service_role): bypasses
 * RLS and can read auth.users through the Auth admin API.
 *
 * Used ONLY by:
 *   - the transactional email sender (src/lib/email/dispatcher.ts), to claim
 *     outbox rows and look up a recipient's address at send time;
 *   - the Stripe payment server code (src/lib/payments/server.ts), to call the
 *     service_role-only payment functions of 0037 (stripe_apply_event,
 *     stripe_record_checkout_session/_failure, stripe_register_host_account).
 *     It never reads or writes the payment tables directly (0036 grants
 *     service_role nothing on them).
 * Never import it anywhere else, never in a client component, and never
 * return what it reads to a user: other users' email addresses must not
 * leave the sender. `server-only` makes a client-side import a build error,
 * and SUPABASE_SECRET_KEY has no NEXT_PUBLIC_ prefix, so it is never inlined
 * into browser code.
 *
 * Returns null when the key isn't configured (the sender then does nothing).
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
