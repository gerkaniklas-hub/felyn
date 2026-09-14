import { redirect } from "next/navigation";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay, getStayDietaryRequirements } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DietaryForm } from "./dietary-form";

export default async function DietaryPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const stay = await getStay(supabase, stayId);
  if (!stay) redirect("/onboarding/add-stay");

  const existing = await getStayDietaryRequirements(supabase, stayId);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={5} total={7} />
      <Heading level={2} className="text-center">
        Dietary requirements
      </Heading>
      <DietaryForm stayId={stay.id} existing={existing} />
    </div>
  );
}
