import { redirect } from "next/navigation";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BudgetForm } from "./budget-form";

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const stay = await getStay(supabase, stayId);
  if (!stay) redirect("/onboarding/add-stay");

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={6} total={7} />
      <Heading level={2} className="text-center">
        What&apos;s your budget for an experience?
      </Heading>
      <BudgetForm
        stayId={stay.id}
        budgetMin={stay.budget_min}
        budgetMax={stay.budget_max}
        budgetFlexible={stay.budget_flexible}
      />
    </div>
  );
}
