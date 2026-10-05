import Link from "next/link";
import { redirect } from "next/navigation";
import { GuestNav } from "@/components/navigation/GuestNav";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ContactFelynForm } from "@/components/support/ContactFelynForm";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { Heading } from "@/components/ui/heading";
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
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-xs font-medium tracking-wide text-navy-300">HELP</p>
        <Heading level={1} className="mt-2">
          Talk to Felyn
        </Heading>
        <p className="mt-3 max-w-xl text-navy-600">
          Questions about a booking, a payment or your account? Send us a message — the Felyn Team replies right here
          in your Messages.
        </p>

        <section className="mt-8 rounded-3xl border border-ivory-300 bg-ivory-50 p-6 shadow-sm sm:p-8">
          <div className="flex items-center gap-3">
            <FelynTeamAvatar className="h-11 w-11" />
            <div>
              <h2 className="font-display text-xl text-navy-950">Contact Felyn</h2>
              <p className="text-sm text-navy-500">Usually the quickest way to reach us.</p>
            </div>
          </div>

          <div className="mt-6">
            {openThreadId ? (
              <div className="flex flex-col items-start gap-3 rounded-2xl bg-ivory-100 px-5 py-4">
                <p className="text-sm text-navy-700">
                  You already have a conversation with the Felyn Team. Continue it there — we&apos;ll see everything
                  in one place.
                </p>
                <Link
                  href={`/messages?support=${openThreadId}`}
                  className="inline-flex h-11 items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 transition-colors hover:bg-navy-950"
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
      </div>
    </div>
  );
}
