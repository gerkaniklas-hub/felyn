"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createExperience, updateExperience, type ExperienceFormState } from "@/lib/provider/experience-actions";

const initialState: ExperienceFormState = {};

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "food", label: "Food" },
  { value: "drink", label: "Drink" },
  { value: "food_drink", label: "Food & Drink" },
];

export type ExperienceFormValues = {
  id: string;
  title: string;
  shortDescription: string | null;
  description: string | null;
  category: string;
  cuisine: string | null;
  pricePerPerson: number;
  minGuests: number;
  maxGuests: number;
  durationMinutes: number;
};

/**
 * Stage 3: core experience fields only — category/cuisine/price/guest
 * range/duration/descriptions. Photos, tags, and availability windows each
 * need a real experience_id to attach to, so they live in their own
 * sections on the edit page (see ExperienceGalleryManager /
 * ExperienceAttributesEditor / ExperienceAvailabilityManager), not here.
 * `published` is never set by this form — see PublishToggleButton.
 */
export function ExperienceForm({ experience }: { experience: ExperienceFormValues | null }) {
  const router = useRouter();
  const action = experience ? updateExperience : createExperience;
  const [state, formAction, isPending] = useActionState(action, initialState);

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col gap-8">
      {experience ? <input type="hidden" name="experienceId" value={experience.id} /> : null}

      {/* Visual groups only — one form, one save. */}
      <fieldset className="flex flex-col gap-4">
        <legend className="sr-only">About the experience</legend>
        <Input label="Title" name="title" defaultValue={experience?.title} placeholder="Sunset seafood dinner" required />
  
        <Input
          label="Short description"
          name="shortDescription"
          defaultValue={experience?.shortDescription ?? undefined}
          placeholder="One line guests see in search results"
        />
  
        <Textarea
          label="Full description"
          name="description"
          defaultValue={experience?.description ?? undefined}
          placeholder="What happens during this experience, what's included, what to expect…"
        />
  
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-navy-700">Category</span>
            <select
              name="category"
              defaultValue={experience?.category ?? ""}
              required
              className="h-11 rounded-full border border-ivory-400 bg-ivory-50 px-4 text-base text-navy-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            >
              <option value="" disabled>
                Choose one
              </option>
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Input label="Cuisine (optional)" name="cuisine" defaultValue={experience?.cuisine ?? undefined} placeholder="Canarian" />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-ivory-300 pt-6">
        {/* float-left keeps the legend in the flow, so it doesn't cut the fieldset's top border. */}
        <legend className="float-left w-full font-display text-lg text-navy-950">Experience details</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Price per person (€)"
            name="pricePerPerson"
            type="number"
            min={0}
            step="0.01"
            defaultValue={experience?.pricePerPerson}
            required
          />
          <Input
            label="Duration (minutes)"
            name="durationMinutes"
            type="number"
            min={1}
            defaultValue={experience?.durationMinutes}
            required
          />
          <Input label="Min guests" name="minGuests" type="number" min={1} defaultValue={experience?.minGuests ?? 1} required />
          <Input label="Max guests" name="maxGuests" type="number" min={1} defaultValue={experience?.maxGuests ?? 1} required />
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-ivory-300 pt-6">
        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        <Button type="submit" disabled={isPending} className="self-start">
          {isPending ? "Saving…" : experience ? "Save changes" : "Create draft"}
        </Button>
      </div>
    </form>
  );
}
