import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { GuestNav } from "@/components/navigation/GuestNav";
import { SuitcaseIcon } from "@/components/navigation/icons";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { AvatarEditor } from "@/components/profile/AvatarEditor";
import { ContactPhoneForm } from "@/components/profile/ContactPhoneForm";
import { EmailChangeForm } from "@/components/profile/EmailChangeForm";
import { PasswordChangeForm } from "@/components/profile/PasswordChangeForm";
import { ProfileDetailsForm } from "@/components/profile/ProfileDetailsForm";
import { Heading } from "@/components/ui/heading";
import { getContactDetails } from "@/lib/contact/queries";
import { formatPhoneNational } from "@/lib/phone";
import { isFelynStaff } from "@/lib/support/staff";
import { getSignedAvatarUrl } from "@/lib/storage/avatars";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Milestone 1: the guest's real profile — photo, name, mobile number, email change
 * (via Supabase Auth's own verification flow), password change, and a
 * completed-experiences count. Replaces the earlier "coming soon"
 * placeholder. Name and photo live in auth.users.user_metadata (see
 * signup-form.tsx for the same fields being written at signup); the mobile
 * number lives in user_contact_details (0027), shared with the host side.
 *
 * The completed-experiences count reads booking_request_items.completed_at
 * (0016) directly — no join needed: the existing "Users manage their own
 * booking request items" RLS policy (0005) already scopes every row this
 * query can see to the signed-in guest's own items, the same way
 * getGuestExperiences and getActiveBookingRequest already rely on RLS
 * rather than an explicit user_id filter. On a query error, the real count
 * is unknown, so the UI says so explicitly rather than falling back to "0"
 * — a load failure must never be presented as "zero completed".
 *
 * Phase 9 of the consolidated improvements: this count now lives in the
 * profile header, right beside the avatar/name, rather than in its own
 * card near the bottom of the page — same query, same source of truth,
 * just moved. A simple checkmark + count, deliberately not a badge/level/
 * streak system.
 */
export default async function GuestProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const firstName = (user.user_metadata?.first_name as string | undefined) ?? "";
  const lastName = (user.user_metadata?.last_name as string | undefined) ?? "";
  const avatarPath = (user.user_metadata?.avatar_path as string | undefined) ?? null;
  const [signedAvatarUrl, contact, isStaff] = await Promise.all([
    avatarPath ? getSignedAvatarUrl(supabase, avatarPath) : null,
    getContactDetails(supabase, user.id),
    isFelynStaff(supabase),
  ]);

  const { count: completedCount, error: completedCountError } = await supabase
    .from("booking_request_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "CONFIRMED")
    .not("completed_at", "is", null);

  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 md:py-12 lg:px-10">
        <Heading level={1}>Profile</Heading>

        <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
          <aside className="flex flex-col gap-4 lg:sticky lg:top-8">
            <div className="flex flex-col gap-5 rounded-3xl border border-ivory-300 bg-ivory-50 p-6 shadow-sm">
              <AvatarEditor userId={user.id} initialSignedUrl={signedAvatarUrl} />
              <div className="border-t border-ivory-300 pt-4">
                <p className="font-display text-2xl text-navy-950">{fullName || "Your profile"}</p>
                {user.email ? <p className="mt-0.5 truncate text-sm text-navy-500">{user.email}</p> : null}
                {completedCountError ? (
                  <p className="mt-3 text-sm text-navy-500">Completed experiences: unavailable right now.</p>
                ) : (
                  <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-navy-700">
                    <span aria-hidden="true" className="text-sky-600">
                      ✓
                    </span>
                    {completedCount ?? 0} experience{completedCount === 1 ? "" : "s"} completed
                  </p>
                )}
              </div>
            </div>

            <Link
              href="/trips"
              className="flex items-center gap-3 rounded-3xl border border-ivory-300 bg-ivory-50 p-4 shadow-sm transition-colors hover:border-sky-300"
            >
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600">
                <SuitcaseIcon className="h-5 w-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium text-navy-900">Upcoming experiences</span>
                <span className="text-xs text-navy-500">See your trips and bookings</span>
              </span>
              <span aria-hidden="true" className="text-navy-300">
                →
              </span>
            </Link>

            {/* Felyn staff only (staff_members, checked by the database); the link grants nothing — /admin re-checks. */}
            {isStaff ? (
              <Link
                href="/admin/support"
                className="flex items-center gap-3 rounded-3xl border border-ivory-300 bg-ivory-50 p-4 shadow-sm transition-colors hover:border-sky-300"
              >
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-navy-900 font-display text-base text-ivory-50">
                  F<span className="text-gold-500">.</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium text-navy-900">Felyn Support</span>
                  <span className="text-xs text-navy-500">Open the support inbox</span>
                </span>
                <span aria-hidden="true" className="text-navy-300">
                  →
                </span>
              </Link>
            ) : null}
          </aside>

          <div className="flex flex-col gap-6">
            <ProfileSection title="Personal details" description="Your name.">
              <ProfileDetailsForm firstName={firstName} lastName={lastName} />
            </ProfileSection>

            <ProfileSection title="Mobile number" description="The number Felyn can reach you on.">
              <ContactPhoneForm
                defaultCountry={contact?.phoneCountry ?? ""}
                defaultNumber={contact ? formatPhoneNational(contact.phoneNumber) : ""}
              />
            </ProfileSection>

            <ProfileSection title="Settings" description="The email address and password you sign in with.">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-navy-900">Email</h3>
                  <EmailChangeForm currentEmail={user.email ?? ""} />
                </div>
                <div className="flex flex-col gap-3 border-t border-ivory-300 pt-6">
                  <h3 className="text-sm font-semibold text-navy-900">Password</h3>
                  <PasswordChangeForm />
                </div>
              </div>
            </ProfileSection>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-3xl border border-ivory-300 bg-ivory-50 p-6 shadow-sm sm:p-8">
      <div>
        <h2 className="font-display text-xl font-medium tracking-tight text-navy-950">{title}</h2>
        <p className="mt-1 text-sm text-navy-500">{description}</p>
      </div>
      {children}
    </section>
  );
}
