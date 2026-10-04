import { redirect } from "next/navigation";
import { Heading } from "@/components/ui/heading";
import { Logo } from "@/components/ui/logo";
import { safeAccountDestination } from "@/lib/contact/constants";
import { getContactDetails, savePendingSignupPhone } from "@/lib/contact/queries";
import { formatPhoneNational, isPhoneCountry } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MobileStepForm } from "./mobile-step-form";

export const metadata = { title: "Your mobile number · Felyn" };

/**
 * Every account needs a mobile number in user_contact_details. Signup
 * collects it, but can't save it there before the email is confirmed (no
 * session yet), so the confirmation link and every login pass through here:
 *   - number already saved            -> straight on to `next`
 *   - number from signup still pending -> validated and saved, then on to `next`
 *   - otherwise (e.g. that number is already used by another account)
 *                                      -> this form, which must be completed
 * `next` is only ever one of the allow-listed landing pages.
 */
export default async function AccountMobilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const destination = safeAccountDestination((await searchParams).next);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (await getContactDetails(supabase, user.id)) redirect(destination);

  const pending = await savePendingSignupPhone(supabase, user);
  if (pending.status === "saved") redirect(destination);

  const defaults =
    pending.status === "failed" && isPhoneCountry(pending.country)
      ? { country: pending.country, number: pending.number.startsWith("+") ? formatPhoneNational(pending.number) : pending.number }
      : { country: "", number: "" };

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <Logo size="lg" className="self-center" />
      <div className="flex flex-col gap-2 text-center">
        <Heading level={1}>Add your mobile number</Heading>
        <p className="text-sm text-navy-500">
          Felyn needs a number to reach you on about your experiences. Only you and the Felyn team can see it.
        </p>
      </div>
      <MobileStepForm
        destination={destination}
        defaultCountry={defaults.country}
        defaultNumber={defaults.number}
        initialError={pending.status === "failed" ? pending.error : undefined}
      />
    </div>
  );
}
