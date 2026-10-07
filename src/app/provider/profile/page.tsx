import { redirect } from "next/navigation";
import { ContactPhoneForm } from "@/components/profile/ContactPhoneForm";
import { HostPhotoEditor } from "@/components/provider/HostPhotoEditor";
import { HostProfileForm } from "@/components/provider/HostProfileForm";
import { ViewPublicProfileButton } from "@/components/provider/ViewPublicProfileButton";
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
 * - Public profile: what guests see, editable by the host — photo (HostPhotoEditor,
 *   saved right away), name, location, "About you" and languages (HostProfileForm,
 *   "Save changes"). Both go through the host-only actions in
 *   lib/provider/profile-actions.ts, which the database enforces again (0030).
 *   Specialties are read-only here: they come from the specialty tags on the host's
 *   published experiences. Changes show on the public profile straight away; who can
 *   see that profile (hosts with a published experience) is unchanged.
 * - Contact details: the host's mobile number — the same account-wide contact record
 *   (user_contact_details) and form as the guest Profile, never a separate host
 *   phone. Only the host and the Felyn team can see it.
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="flex flex-col gap-6">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div>
              <Heading level={3} as="h2">
                Public profile
              </Heading>
              <p className="mt-1 text-sm text-navy-500">The information guests see when they discover you on Felyn.</p>
            </div>
            {identity && identity.publishedExperienceCount > 0 ? (
              <ViewPublicProfileButton providerId={identity.id} providerName={identity.displayName} />
            ) : null}
          </div>

          {identity ? (
            <>
              {identity.publishedExperienceCount === 0 ? (
                // provider_public_profiles only lists hosts with a published experience.
                <p className="rounded-xl bg-ivory-100 px-4 py-3 text-sm text-navy-600">
                  Your public profile becomes visible to guests once you publish your first experience.
                </p>
              ) : null}
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-navy-700">Profile photo</span>
                <HostPhotoEditor
                  providerId={identity.id}
                  photoUrl={identity.profilePhotoUrl}
                  displayName={identity.displayName}
                />
              </div>
              <div className="border-t border-ivory-300 pt-6">
                <HostProfileForm
                  displayName={identity.displayName}
                  baseLocation={identity.baseLocation}
                  bio={identity.bio}
                  languages={identity.languages}
                  specialties={identity.specialties}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-navy-500">This account isn&apos;t linked to a Felyn provider profile yet.</p>
          )}
        </Card>

        <Card className="flex flex-col gap-5 lg:sticky lg:top-6">
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
