import Link from "next/link";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { formatPrice } from "@/lib/format";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { getProviderExperienceList } from "@/lib/provider/experiences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Stage 3: the host's own experience catalogue — published and draft,
 * reusing 0002's schema/RLS exactly as audited (no new tables). Scoped
 * strictly to the signed-in provider's own experiences via
 * getProviderExperienceList (provider_id filter + RLS, same pattern as
 * every other provider dashboard query).
 */
export default async function ProviderExperiencesPage() {
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

  const experiences = await getProviderExperienceList(supabase, identity.id);
  const published = experiences.filter((e) => e.published);
  const drafts = experiences.filter((e) => !e.published);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-navy-300">YOUR EXPERIENCES</p>
          <Heading level={1} className="mt-2">
            Manage your experiences
          </Heading>
        </div>
        <Link href="/provider/experiences/new">
          <Button type="button">New experience</Button>
        </Link>
      </div>

      {experiences.length === 0 ? (
        <Card className="text-center">
          <p className="text-navy-500">You haven&apos;t created any experiences yet.</p>
          <Link href="/provider/experiences/new" className="mt-3 inline-block">
            <Button type="button">Create your first experience</Button>
          </Link>
        </Card>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <Heading level={3}>Published ({published.length})</Heading>
            {published.length === 0 ? (
              <p className="text-sm text-navy-400">Nothing published yet — guests can&apos;t see any experiences until you publish one.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {published.map((experience) => (
                  <ExperienceListCard key={experience.id} experience={experience} />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <Heading level={3}>Drafts ({drafts.length})</Heading>
            {drafts.length === 0 ? (
              <p className="text-sm text-navy-400">No drafts.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {drafts.map((experience) => (
                  <ExperienceListCard key={experience.id} experience={experience} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ExperienceListCard({
  experience,
}: {
  experience: {
    id: string;
    title: string;
    published: boolean;
    pricePerPerson: number;
    currency: string;
    primaryImageUrl: string | null;
  };
}) {
  return (
    <Link href={`/provider/experiences/${experience.id}/edit`}>
      <Card className="flex h-full flex-col gap-3 transition-shadow hover:shadow-md">
        <FallbackImage src={experience.primaryImageUrl} alt={experience.title} className="aspect-video w-full rounded-xl" />
        <div className="flex items-start justify-between gap-2">
          <p className="font-display text-lg text-navy-950">{experience.title}</p>
          <Badge tone={experience.published ? "sky" : "navy"}>{experience.published ? "PUBLISHED" : "DRAFT"}</Badge>
        </div>
        <p className="text-sm text-navy-600">{formatPrice(experience.pricePerPerson, experience.currency)}</p>
      </Card>
    </Link>
  );
}
