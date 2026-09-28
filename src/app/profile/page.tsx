import { redirect } from "next/navigation";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { AvatarEditor } from "@/components/profile/AvatarEditor";
import { EmailChangeForm } from "@/components/profile/EmailChangeForm";
import { PasswordChangeForm } from "@/components/profile/PasswordChangeForm";
import { ProfileDetailsForm } from "@/components/profile/ProfileDetailsForm";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { getSignedAvatarUrl } from "@/lib/storage/avatars";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Milestone 1: the guest's real profile — photo, name/phone, email change
 * (via Supabase Auth's own verification flow), password change, and a
 * completed-experiences count. Replaces the earlier "coming soon"
 * placeholder. Identity fields live only in auth.users.user_metadata (no
 * profiles table exists or is introduced here — see signup-form.tsx for the
 * same fields being written at signup).
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
  const phone = (user.user_metadata?.phone as string | undefined) ?? "";
  const avatarPath = (user.user_metadata?.avatar_path as string | undefined) ?? null;
  const signedAvatarUrl = avatarPath ? await getSignedAvatarUrl(supabase, avatarPath) : null;

  const { count: completedCount, error: completedCountError } = await supabase
    .from("booking_request_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "CONFIRMED")
    .not("completed_at", "is", null);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div>
          <p className="text-xs font-medium tracking-wide text-navy-300">PROFILE</p>
          <Heading level={1} className="mt-2">
            Your profile
          </Heading>
        </div>

        <Card className="flex flex-col gap-3">
          <AvatarEditor userId={user.id} initialSignedUrl={signedAvatarUrl} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ivory-300 pt-3">
            <p className="font-display text-lg text-navy-950">
              {[firstName, lastName].filter(Boolean).join(" ") || "Your profile"}
            </p>
            {completedCountError ? (
              <p className="text-sm text-navy-500">Completed experiences: unavailable right now.</p>
            ) : (
              <p className="flex items-center gap-1.5 text-sm font-medium text-navy-700">
                <span aria-hidden="true" className="text-sky-600">
                  ✓
                </span>
                {completedCount ?? 0} experience{completedCount === 1 ? "" : "s"} completed
              </p>
            )}
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <Heading level={3}>Your details</Heading>
          <ProfileDetailsForm firstName={firstName} lastName={lastName} phone={phone} />
        </Card>

        <Card className="flex flex-col gap-4">
          <Heading level={3}>Email</Heading>
          <EmailChangeForm currentEmail={user.email ?? ""} />
        </Card>

        <Card className="flex flex-col gap-4">
          <Heading level={3}>Password</Heading>
          <PasswordChangeForm />
        </Card>
      </div>
    </div>
  );
}
