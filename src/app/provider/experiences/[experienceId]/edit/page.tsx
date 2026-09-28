import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { DeleteExperienceButton } from "@/components/provider/DeleteExperienceButton";
import { ExperienceAttributesEditor } from "@/components/provider/ExperienceAttributesEditor";
import { ExperienceAvailabilityManager } from "@/components/provider/ExperienceAvailabilityManager";
import { ExperienceForm } from "@/components/provider/ExperienceForm";
import { ExperienceGalleryManager } from "@/components/provider/ExperienceGalleryManager";
import { PublishToggleButton } from "@/components/provider/PublishToggleButton";
import { getProviderIdentity } from "@/lib/provider/dashboard";
import { getProviderExperienceDetail } from "@/lib/provider/experiences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Stage 3: edit one of the host's OWN experiences — core fields, photos,
 * tags, and availability all live here, since all four (beyond the core
 * fields) need a real experience_id to attach to. getProviderExperienceDetail
 * is scoped to the signed-in provider's own experiences (provider_id filter
 * + RLS), so an experienceId for someone else's experience simply renders
 * "not found" rather than leaking another provider's draft.
 */
export default async function EditProviderExperiencePage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { experienceId } = await params;
  const { created } = await searchParams;

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

  const experience = await getProviderExperienceDetail(supabase, identity.id, experienceId);

  if (!experience) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <Heading level={2}>Experience not found</Heading>
        <p className="mt-2 text-navy-500">This experience doesn&apos;t exist, or isn&apos;t yours to manage.</p>
      </Card>
    );
  }

  const canPublish = experience.gallery.length > 0 && experience.availability.length > 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-navy-300">EDIT EXPERIENCE</p>
          <Heading level={1} className="mt-2">
            {experience.title}
          </Heading>
        </div>
        <div className="flex flex-col items-end gap-2">
          <PublishToggleButton experienceId={experience.id} published={experience.published} />
          <DeleteExperienceButton experienceId={experience.id} title={experience.title} />
        </div>
      </div>

      {created ? (
        <p className="rounded-xl bg-sky-100 px-4 py-3 text-sm font-medium text-sky-700">
          Draft created. Add at least one photo and one availability window before publishing.
        </p>
      ) : null}

      {!experience.published && !canPublish ? (
        <p className="rounded-xl bg-gold-100 px-4 py-3 text-sm font-medium text-gold-700">
          Add at least one photo and one availability window before publishing this experience.
        </p>
      ) : null}

      <Card>
        <Heading level={3}>Details</Heading>
        <div className="mt-4">
          <ExperienceForm
            experience={{
              id: experience.id,
              title: experience.title,
              shortDescription: experience.shortDescription,
              description: experience.description,
              category: experience.category,
              cuisine: experience.cuisine,
              pricePerPerson: experience.pricePerPerson,
              minGuests: experience.minGuests,
              maxGuests: experience.maxGuests,
              durationMinutes: experience.durationMinutes,
            }}
          />
        </div>
      </Card>

      <Card>
        <Heading level={3}>Photos</Heading>
        <div className="mt-4">
          <ExperienceGalleryManager providerId={identity.id} experienceId={experience.id} images={experience.gallery} />
        </div>
      </Card>

      <Card>
        <Heading level={3}>Tags</Heading>
        <p className="mt-1 text-sm text-navy-500">
          Help Felyn&apos;s matching find the right guests for this experience.
        </p>
        <div className="mt-4">
          <ExperienceAttributesEditor experienceId={experience.id} attributes={experience.attributes} />
        </div>
      </Card>

      <Card>
        <Heading level={3}>Availability</Heading>
        <div className="mt-4">
          <ExperienceAvailabilityManager experienceId={experience.id} windows={experience.availability} />
        </div>
      </Card>
    </div>
  );
}
