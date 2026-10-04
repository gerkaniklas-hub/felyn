import Link from "next/link";
import { redirect } from "next/navigation";
import { HostNav } from "@/components/navigation/HostNav";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getContactDetails } from "@/lib/contact/queries";
import { getCategoryLabel } from "@/lib/host-application/constants";
import { getHostAccess, type HostApplication } from "@/lib/host-application/queries";
import { formatPhoneInternational } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DisplayNameForm } from "./display-name-form";

export const metadata = { title: "Your host application · Felyn" };

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** `phone`: the account's current number (user_contact_details) — the source of truth — in E.164. */
function Summary({ application, phone }: { application: HostApplication; phone: string }) {
  const rows: [string, string | null][] = [
    ["Name", `${application.firstName} ${application.lastName}`],
    ["Phone", formatPhoneInternational(phone)],
    ["Location", application.location],
    ["Experience", getCategoryLabel(application.experienceCategory)],
    ["What you'd offer", application.experienceDescription],
    ["Background", application.background],
    ["Website or Instagram", application.websiteUrl],
  ];
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={3}>Your application</Heading>
        <p className="text-sm text-navy-500">Submitted {formatDate(application.submittedAt)}</p>
      </div>
      <dl className="flex flex-col divide-y divide-ivory-300">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[160px_1fr] sm:gap-4">
              <dt className="text-sm font-medium text-navy-500">{label}</dt>
              <dd className="whitespace-pre-line break-words text-navy-900">{value}</dd>
            </div>
          ))}
      </dl>
      <p className="text-xs text-navy-500">Only the Felyn team can see these details. Guests only ever see your public name.</p>
    </Card>
  );
}

/**
 * The applicant's own status page. Status is read from the database on
 * every request (RLS-scoped to this user) — never from the URL, which only
 * carries a cosmetic "just submitted" flag.
 */
export default async function HostApplicationPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const [{ providerId, application }, contact] = await Promise.all([
    getHostAccess(supabase, user.id),
    // Display only: if this read fails, show the number submitted with the application.
    getContactDetails(supabase, user.id).catch(() => null),
  ]);
  if (!application) redirect(providerId ? "/provider" : "/host/apply");

  const justSubmitted = (await searchParams).submitted === "1" && application.status === "submitted";

  return (
    <div className="flex flex-1 flex-col">
      <HostNav />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
        <p className="text-xs font-medium tracking-wide text-gold-700">YOUR HOST APPLICATION</p>

        {application.status === "submitted" && (
          <>
            <div className="-mt-5 flex flex-col gap-3">
              <Badge tone="sky" className="self-start">
                Under review
              </Badge>
              <Heading level={1}>{justSubmitted ? "Thank you — your application is with us." : "We're reviewing your application."}</Heading>
              <p className="text-navy-600">
                A member of the Felyn team reads every application personally. We may get in touch by phone or email if
                we&apos;d like to know more. Once we&apos;ve reviewed it, you&apos;ll see the outcome here.
              </p>
              <p className="text-sm text-navy-500">
                Submitting an application doesn&apos;t guarantee approval, and host tools unlock only after approval.
              </p>
            </div>

            <Card className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Heading level={3}>Your public name</Heading>
                <p className="text-sm text-navy-500">
                  The name guests will see if you&apos;re approved. You can change it until your application has been
                  reviewed.
                </p>
              </div>
              <DisplayNameForm currentName={application.displayName} />
            </Card>

            <Summary application={application} phone={contact?.phoneNumber ?? application.phone} />
          </>
        )}

        {application.status === "approved" && (
          <div className="-mt-5 flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <Badge tone="gold" className="self-start">
                Approved
              </Badge>
              <Heading level={1}>Welcome to Felyn, {application.displayName}.</Heading>
              {providerId ? (
                <p className="text-navy-600">
                  Your application has been approved. Your host space is ready — set up your profile and create your
                  first experience whenever you&apos;re ready.
                </p>
              ) : (
                <p className="text-navy-600">
                  Your application has been approved, but your host space isn&apos;t ready yet. Please contact the Felyn
                  team and we&apos;ll sort it out.
                </p>
              )}
            </div>
            {providerId && (
              <Link
                href="/provider"
                className="inline-flex h-12 items-center justify-center self-start rounded-full bg-navy-900 px-7 font-medium text-ivory-50 transition-colors hover:bg-navy-950"
              >
                Go to your host space
              </Link>
            )}
            {application.decisionMessage && (
              <Card>
                <p className="text-sm font-medium text-navy-500">A note from the Felyn team</p>
                <p className="mt-2 whitespace-pre-line text-navy-900">{application.decisionMessage}</p>
              </Card>
            )}
          </div>
        )}

        {application.status === "rejected" && (
          <div className="-mt-5 flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <Badge tone="navy" className="self-start">
                Not approved
              </Badge>
              <Heading level={1}>Thank you for applying.</Heading>
              <p className="text-navy-600">
                After careful review, we aren&apos;t able to approve your application at this time. We know that&apos;s
                disappointing, and we&apos;re grateful you wanted to share something with our guests.
              </p>
              <p className="text-navy-600">
                If you&apos;d like us to reconsider — for example because something has changed — please contact the
                Felyn team. Applications can&apos;t be resubmitted from your account at the moment.
              </p>
            </div>
            {application.decisionMessage && (
              <Card>
                <p className="text-sm font-medium text-navy-500">A note from the Felyn team</p>
                <p className="mt-2 whitespace-pre-line text-navy-900">{application.decisionMessage}</p>
              </Card>
            )}
            <p className="text-sm text-navy-500">
              This doesn&apos;t affect any guest bookings — the guest login works exactly as before.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
