import { redirect } from "next/navigation";
import { HostNav } from "@/components/navigation/HostNav";
import { Heading } from "@/components/ui/heading";
import { getHostAccess } from "@/lib/host-application/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { HostApplicationForm } from "./host-application-form";

export const metadata = { title: "Apply to host · Felyn" };

/**
 * The host application form. Signed-in only (proxy.ts protects /host and
 * returns the user here after login). Anyone who already has a provider
 * profile or an application is routed away server-side, so there is only
 * ever one application per account (also enforced by 0023's unique user_id).
 */
export default async function HostApplyPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const access = await getHostAccess(supabase, user.id);
  if (access.providerId) redirect("/provider");
  if (access.application) redirect("/host/application");

  // Pre-fill only — the submitted form values are what gets stored.
  const meta = user.user_metadata ?? {};
  const defaults = {
    firstName: typeof meta.first_name === "string" ? meta.first_name : "",
    lastName: typeof meta.last_name === "string" ? meta.last_name : "",
    phone: typeof meta.phone === "string" ? meta.phone : "",
  };

  return (
    <div className="flex flex-1 flex-col">
      <HostNav />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium tracking-wide text-gold-700">BECOME A FELYN HOST</p>
          <Heading level={1}>Tell us what you would love to share.</Heading>
          <p className="text-navy-600">
            Every application is read by a member of the Felyn team. We&apos;ll use it to get to know you and the
            experience you have in mind. Submitting doesn&apos;t guarantee approval, and your host tools unlock only
            once your application has been reviewed.
          </p>
        </div>
        <HostApplicationForm defaults={defaults} />
      </div>
    </div>
  );
}
