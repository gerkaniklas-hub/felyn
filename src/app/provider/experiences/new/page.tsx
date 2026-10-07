import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { PageHeader, textLinkClass } from "@/components/ui/page";
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
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href="/provider/experiences" className={`self-start ${textLinkClass}`}>
        ← All experiences
      </Link>
      <PageHeader eyebrow="New experience" title="Tell us about it" />
      <Card>
        <ExperienceForm experience={null} />
      </Card>
    </div>
  );
}
