import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ProviderNav } from "@/components/provider/ProviderNav";
import { getHostAccess } from "@/lib/host-application/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Host area shell. Accounts without a provider profile (applicants whose
 * application is pending/rejected, or guests who never applied) are sent to
 * their application status or /become-a-host instead of an empty dashboard.
 * This redirect is UX only — the actual protection is RLS: every provider
 * table/policy requires a providers row with user_id = auth.uid(), which
 * only felyn_admin.approve_host_application can create (0023). Each page
 * also keeps its own "profile not found" fallback.
 */
export default async function ProviderLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const access = await getHostAccess(supabase, user.id);
  if (!access.providerId) redirect(access.application ? "/host/application" : "/become-a-host");

  // The host workspace shell: navy page (globals.css, [data-shell="host"]) and the
  // darker navy sidebar (ProviderNav, tone="host") frame one ivory canvas that
  // holds every host page, so pages keep navy text on ivory cards. On phones the
  // canvas runs edge to edge under the navy top bar.
  return (
    <div data-shell="host" className="flex flex-1 flex-col">
      <ProviderNav />
      <div className="flex flex-1 flex-col md:p-3 lg:p-4">
        <main className="flex flex-1 flex-col bg-ivory-100 md:rounded-panel">
          <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 md:py-10 lg:px-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
