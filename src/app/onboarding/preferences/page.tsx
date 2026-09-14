import { redirect } from "next/navigation";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay, getStayPreferences } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PreferencesForm } from "./preferences-form";

export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const stay = await getStay(supabase, stayId);
  if (!stay) redirect("/onboarding/add-stay");

  const preferences = await getStayPreferences(supabase, stayId);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={4} total={7} />
      <Heading level={2} className="text-center">
        What would make this stay special?
      </Heading>
      <PreferencesForm stayId={stay.id} rawText={preferences?.raw_text ?? null} />
    </div>
  );
}
