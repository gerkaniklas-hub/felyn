import { redirect } from "next/navigation";
import { ComingSoonCard } from "@/components/provider/ComingSoonCard";
import { ContactPhoneForm } from "@/components/profile/ContactPhoneForm";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getContactDetails } from "@/lib/contact/queries";
import { formatPhoneNational } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The public profile editor is still to come. The host's mobile number is
 * editable here already: the same account-wide contact record
 * (user_contact_details) and form as the guest Profile, never a separate
 * host phone. Only the host and the Felyn team can see it.
 */
export default async function ProviderProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const contact = await getContactDetails(supabase, user.id);

  return (
    <div className="flex flex-col gap-6">
      <ComingSoonCard
        title="Editing your profile is coming soon"
        description="For now, your profile is shown on your Dashboard exactly as guests see it."
      />
      <Card className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div>
          <Heading level={3}>Mobile number</Heading>
          <p className="mt-1 text-sm text-navy-500">The number Felyn can reach you on. Guests can&apos;t see it.</p>
        </div>
        <ContactPhoneForm
          defaultCountry={contact?.phoneCountry ?? ""}
          defaultNumber={contact ? formatPhoneNational(contact.phoneNumber) : ""}
        />
      </Card>
    </div>
  );
}
