import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for use in Client Components (browser only).
 * Create a new one per component/hook rather than sharing a module-level
 * instance across the app, per Supabase's SSR guidance.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
