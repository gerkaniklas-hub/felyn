import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { StepIndicator } from "@/components/ui/step-indicator";
import { getStay } from "@/lib/onboarding/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function formatDateRange(checkIn: string, checkOut: string) {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  return `${inDate.toLocaleDateString("en-GB", opts)} – ${outDate.toLocaleDateString("en-GB", opts)} ${outDate.getFullYear()}`;
}

export default async function ConfirmStayPage({
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
      <StepIndicator step={2} total={7} />
      <Heading level={2} className="text-center">
        We found your stay
      </Heading>
      <Card className="flex flex-col gap-1 text-center">
        <p className="font-display text-xl text-navy-950">{stay.property_name}</p>
        <p className="text-navy-600">{stay.location_text}</p>
        <p className="text-navy-600">{formatDateRange(stay.check_in, stay.check_out)}</p>
        <p className="text-navy-600">{stay.guest_count} guests</p>
      </Card>
      <div className="flex flex-col gap-3">
        <Link
          href={`/onboarding/occasion?stay=${stay.id}`}
          className="flex h-11 items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 hover:bg-navy-950"
        >
          Looks good
        </Link>
        <Link
          href={`/onboarding/add-stay/manual?stay=${stay.id}`}
          className="text-center text-sm font-medium text-sky-600 hover:text-sky-700"
        >
          Edit details
        </Link>
      </div>
    </div>
  );
}
