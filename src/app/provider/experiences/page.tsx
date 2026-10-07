import Link from "next/link";
import { FallbackImage } from "@/components/planner/FallbackImage";
import { ServiceLocationCard } from "@/components/provider/ServiceLocationCard";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, cardSurface } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { formatPrice } from "@/lib/format";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { getProviderExperienceList } from "@/lib/provider/experiences";
import { getProviderServiceLocation } from "@/lib/provider/service-location";
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
  const serviceLocation = await getProviderServiceLocation(supabase, identity.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Your experiences"
        title="Manage your experiences"
        actions={
          <Link href="/provider/experiences/new" className={buttonClasses()}>
            New experience
          </Link>
        }
      />

      <ServiceLocationCard currentLocationText={serviceLocation?.locationText ?? null} />

      {experiences.length === 0 ? (
        <EmptyState
          action={
            <Link href="/provider/experiences/new" className={buttonClasses()}>
              Create your first experience
            </Link>
          }
        >
          You haven&apos;t created any experiences yet.
        </EmptyState>
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <Heading level={3} as="h2">
              Published <span className="text-navy-400">({published.length})</span>
            </Heading>
            {published.length === 0 ? (
              <EmptyState>Nothing published yet — guests can&apos;t see any experiences until you publish one.</EmptyState>
            ) : (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {published.map((experience) => (
                  <ExperienceListCard key={experience.id} experience={experience} />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <Heading level={3} as="h2">
              Drafts <span className="text-navy-400">({drafts.length})</span>
            </Heading>
            {drafts.length === 0 ? (
              <p className="text-sm text-navy-500">No drafts.</p>
            ) : (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
    <Link
      href={`/provider/experiences/${experience.id}/edit`}
      className={`group ${cardSurface} flex h-full flex-col overflow-hidden transition-[border-color,box-shadow] hover:border-ivory-400 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400`}
    >
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden">
        <FallbackImage
          src={experience.primaryImageUrl}
          alt={experience.title}
          className="absolute inset-0 h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
        <Badge tone={experience.published ? "sky" : "navy"} className="absolute top-3 left-3 shadow-card">
          {experience.published ? "Published" : "Draft"}
        </Badge>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <p className="font-display text-xl leading-snug text-navy-950">{experience.title}</p>
        <p className="mt-auto border-t border-ivory-200 pt-3 text-sm font-medium text-navy-900">
          {formatPrice(experience.pricePerPerson, experience.currency)}
        </p>
      </div>
    </Link>
  );
}
