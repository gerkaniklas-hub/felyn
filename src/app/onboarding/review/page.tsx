import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { BUDGET_OPTIONS, DIETARY_TYPES, OCCASIONS } from "@/lib/onboarding/constants";
import {
  getStay,
  getStayDietaryRequirements,
  getStayOccasions,
  getStayPreferences,
} from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { completeOnboarding } from "./actions";

function formatDateRange(checkIn: string, checkOut: string) {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  return `${inDate.toLocaleDateString("en-GB", opts)} – ${outDate.toLocaleDateString("en-GB", opts)} ${outDate.getFullYear()}`;
}

function budgetLabel(min: number | null, max: number | null, flexible: boolean) {
  if (flexible) return "Flexible";
  const match = BUDGET_OPTIONS.find((o) => o.min === min && o.max === max);
  return match?.label ?? "Not set";
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ stay?: string }>;
}) {
  const { stay: stayId } = await searchParams;
  if (!stayId) redirect("/onboarding/add-stay");

  const supabase = await createSupabaseServerClient();
  const stay = await getStay(supabase, stayId);
  if (!stay) redirect("/onboarding/add-stay");

  const [occasions, preferences, dietary] = await Promise.all([
    getStayOccasions(supabase, stayId),
    getStayPreferences(supabase, stayId),
    getStayDietaryRequirements(supabase, stayId),
  ]);

  const occasionLabels = occasions.map(
    (value) => OCCASIONS.find((o) => o.value === value)?.label ?? value,
  );

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <StepIndicator step={7} total={7} />
      <Heading level={2} className="text-center">
        Here&apos;s what Felyn knows about your stay
      </Heading>

      <Card className="flex items-start justify-between gap-2">
        <div>
          <p className="font-display text-lg text-navy-950">{stay.property_name}</p>
          <p className="text-sm text-navy-600">{stay.location_text}</p>
          <p className="text-sm text-navy-600">
            {formatDateRange(stay.check_in, stay.check_out)} · {stay.guest_count} guests
          </p>
        </div>
        <Link
          href={`/onboarding/add-stay/manual?stay=${stay.id}`}
          className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </Link>
      </Card>

      <Card className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-navy-700">Occasion</p>
          <p className="text-sm text-navy-600">
            {occasionLabels.length > 0 ? occasionLabels.join(", ") : "Not set"}
          </p>
        </div>
        <Link
          href={`/onboarding/occasion?stay=${stay.id}`}
          className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </Link>
      </Card>

      <Card className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-navy-700">What would make it special</p>
          <p className="text-sm text-navy-600">{preferences?.raw_text || "Not set"}</p>
        </div>
        <Link
          href={`/onboarding/preferences?stay=${stay.id}`}
          className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </Link>
      </Card>

      <Card className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-navy-700">Dietary requirements</p>
          {dietary.length > 0 ? (
            <ul className="text-sm text-navy-600">
              {dietary.map((row) => {
                const label =
                  DIETARY_TYPES.find((d) => d.value === row.type)?.label ?? row.type;
                return (
                  <li key={row.id}>
                    {label}
                    {row.guest_count
                      ? ` · ${row.guest_count} guest${row.guest_count === 1 ? "" : "s"}`
                      : ""}
                    {row.notes ? ` — ${row.notes}` : ""}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-navy-600">None</p>
          )}
        </div>
        <Link
          href={`/onboarding/dietary?stay=${stay.id}`}
          className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </Link>
      </Card>

      <Card className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-navy-700">Budget</p>
          <p className="text-sm text-navy-600">
            {budgetLabel(stay.budget_min, stay.budget_max, stay.budget_flexible)}
          </p>
        </div>
        <Link
          href={`/onboarding/budget?stay=${stay.id}`}
          className="shrink-0 text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit
        </Link>
      </Card>

      <form action={completeOnboarding}>
        <input type="hidden" name="stayId" value={stay.id} />
        <Button type="submit" className="w-full">
          Find my experiences
        </Button>
      </form>
    </div>
  );
}
