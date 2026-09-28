import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { ExperienceForm } from "@/components/provider/ExperienceForm";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Stage 3: create a new draft experience. Photos/tags/availability are added afterwards, on the edit page, once a real experience_id exists. */
export default async function NewProviderExperiencePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const identity = user ? await getProviderIdentity(supabase, user.id) : null;

  if (!identity) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <Heading level={2}>Provider profile not found</Heading>
        <p className="mt-2 text-navy-500">This account isn&apos;t linked to a Felyn provider profile yet.</p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <p className="text-xs font-medium tracking-wide text-navy-300">NEW EXPERIENCE</p>
      <Heading level={1} className="mt-2 mb-6">
        Tell us about it
      </Heading>
      <Card>
        <ExperienceForm experience={null} />
      </Card>
    </div>
  );
}
