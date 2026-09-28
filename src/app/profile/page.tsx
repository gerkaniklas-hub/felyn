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

        <Card>
          <AvatarEditor userId={user.id} initialSignedUrl={signedAvatarUrl} />
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

        <Card className="flex flex-col gap-1">
          <Heading level={3}>Completed experiences</Heading>
          {completedCountError ? (
            <p className="text-navy-600">
              We couldn&apos;t load this right now. Please refresh the page to try again.
            </p>
          ) : (
            <p className="text-navy-600">
              {completedCount ?? 0} so far. This counts automatically once an experience&apos;s date has
              passed and Felyn confirms it took place — never something you need to mark yourself.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
