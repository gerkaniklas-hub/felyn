import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ManualStayForm } from "./manual-form";

export default async function ManualStayPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const stay = stayId ? await getStay(supabase, stayId) : null;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <StepIndicator step={1} total={7} />
      <Heading level={2} className="text-center">
        {stay ? "Edit your stay" : "Tell us about your stay"}
      </Heading>
      <ManualStayForm stay={stay} />
    </div>
  );
}
