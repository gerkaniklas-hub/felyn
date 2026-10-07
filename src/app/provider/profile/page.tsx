import { redirect } from "next/navigation";
import { ContactPhoneForm } from "@/components/profile/ContactPhoneForm";
import { HostProfileSummary } from "@/components/provider/HostProfileSummary";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { PageHeader } from "@/components/ui/page";
import { getContactDetails } from "@/lib/contact/queries";
import { formatPhoneNational } from "@/lib/phone";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The host's profile, in two clearly separate parts:
 *
 * - Public profile: a read-only summary of what guests see (the same
 *   getProviderIdentity read the Dashboard uses) and the existing public-profile
 *   preview. Hosts can't edit their photo, bio or languages yet — the page says
 *   so rather than implying otherwise.
 * - Contact details: the host's mobile number, editable here — the same
 *   account-wide contact record (user_contact_details) and form as the guest
 *   Profile, never a separate host phone. Only the host and the Felyn team can
 *   see it.
 */
export default async function ProviderProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const [identity, contact] = await Promise.all([
    getProviderIdentity(supabase, user.id),
    getContactDetails(supabase, user.id),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Your profile" />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-5">
          <div>
            <Heading level={3} as="h2">
              Public profile
            </Heading>
            <p className="mt-1 text-sm text-navy-500">Shown to guests on Felyn.</p>
          </div>
          {identity ? (
            <HostProfileSummary identity={identity} />
          ) : (
            <p className="text-sm text-navy-500">This account isn&apos;t linked to a Felyn provider profile yet.</p>
          )}
          <p className="rounded-xl bg-ivory-100 px-4 py-3 text-sm text-navy-600">
            Editing your public profile&apos;s photo, bio and languages is coming soon.
          </p>
        </Card>

        <Card className="flex flex-col gap-5">
          <div>
            <Heading level={3} as="h2">
              Contact details
            </Heading>
            <p className="mt-1 text-sm text-navy-500">Only you and the Felyn Team can see these.</p>
          </div>
          <div className="flex flex-col gap-4 border-t border-ivory-300 pt-5">
            <div>
              <h3 className="text-sm font-semibold text-navy-900">Mobile number</h3>
              <p className="mt-1 text-sm text-navy-500">The number Felyn can reach you on. Guests can&apos;t see it.</p>
            </div>
            <ContactPhoneForm
              defaultCountry={contact?.phoneCountry ?? ""}
              defaultNumber={contact ? formatPhoneNational(contact.phoneNumber) : ""}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
