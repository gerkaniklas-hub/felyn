import { redirect } from "next/navigation";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay, getStayOccasions } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OccasionForm } from "./occasion-form";

export default async function OccasionPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const stay = await getStay(supabase, stayId);
  if (!stay) redirect("/onboarding/add-stay");

  const selected = await getStayOccasions(supabase, stayId);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={3} total={7} />
      <div className="flex flex-col gap-1 text-center">
        <Heading level={2}>What brings you together?</Heading>
        <p className="text-sm text-navy-500">Select all that apply.</p>
      </div>
      <OccasionForm stayId={stay.id} selected={selected} />
    </div>
  );
}
