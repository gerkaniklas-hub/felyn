import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logout } from "./actions";

/**
 * Placeholder for the signed-in landing area. Explore (the real home
 * screen) lands in a later milestone — this just proves protected routes
 * and logout work, and gates on onboarding being complete.
 */
export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: completedStay } = await supabase
    .from("stays")
    .select("id")
    .eq("user_id", user?.id)
    .not("onboarding_completed_at", "is", null)
    .limit(1)
    .maybeSingle();

  if (!completedStay) {
    redirect("/onboarding/add-stay");
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <Heading level={2}>You&apos;re in.</Heading>
      <p className="text-navy-600">Signed in as {user?.email}</p>
      <p className="text-sm text-navy-400">
        This is a placeholder for Explore — the real home screen comes in a
        later milestone.
      </p>
      <form action={logout}>
        <Button type="submit" variant="secondary">
          Log out
        </Button>
      </form>
    </div>
  );
}
