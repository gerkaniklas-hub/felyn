import Link from "next/link";
import { redirect } from "next/navigation";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ContactFelynForm } from "@/components/support/ContactFelynForm";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { buttonClasses } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Eyebrow, PageContainer } from "@/components/ui/page";
import { getOpenGuestSupportThreadId } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Help → Contact Felyn (guest). A short form that opens a conversation with the
 * Felyn Team in Messages. If the guest already has an open general conversation,
 * this offers to continue it instead of starting another (the database would
 * reuse it anyway). Booking questions start from the booking's own "Get help", so
 * the booking is attached automatically.
 */
export default async function HelpPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const openThreadId = await getOpenGuestSupportThreadId(supabase, null);

  return (
    <div className="flex flex-1 flex-col">
      <GuestNav notifications={<NotificationBell />} />
      <PageContainer measure="reading">
        <Eyebrow>Help</Eyebrow>
        <Heading level={1} className="mt-3">
          Talk to Felyn
        </Heading>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-navy-600">
          Questions about a booking, a payment or your account? Send us a message — the Felyn Team replies right here
          in your Messages.
        </p>

        <section className={`mt-10 ${cardSurface} p-6 sm:p-8`}>
          <div className="flex items-center gap-3">
            <FelynTeamAvatar className="h-11 w-11" />
            <div>
              <Heading level={3} as="h2">
                Contact Felyn
              </Heading>
              <p className="text-sm text-navy-500">Usually the quickest way to reach us.</p>
            </div>
          </div>

          <div className="mt-6">
            {openThreadId ? (
              <div className="flex flex-col items-start gap-3 rounded-xl bg-ivory-100 px-5 py-4">
                <p className="text-sm text-navy-700">
                  You already have a conversation with the Felyn Team. Continue it there — we&apos;ll see everything
                  in one place.
                </p>
                <Link
                  href={`/messages?support=${openThreadId}`}
                  className={buttonClasses()}
                >
                  Open conversation
                </Link>
              </div>
            ) : (
              <ContactFelynForm />
            )}
          </div>
        </section>

        <p className="mt-6 text-sm text-navy-500">
          Need help with a specific booking? Open it from{" "}
          <Link href="/experiences" className="font-medium text-sky-600 hover:text-sky-700">
            Experiences
          </Link>{" "}
          and choose <span className="font-medium text-navy-700">Get help</span>.
        </p>
      </PageContainer>
    </div>
  );
}
