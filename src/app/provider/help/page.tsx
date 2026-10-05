import Link from "next/link";
import { ContactFelynForm } from "@/components/support/ContactFelynForm";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { Heading } from "@/components/ui/heading";
import { getSupportConversationHref } from "@/lib/support/inbox";
import { getOpenSupportThreadId } from "@/lib/support/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Help → Contact Felyn for hosts. Lives inside app/provider/layout.tsx, so only
 * approved hosts (a providers row) reach it; the host support actions and the 0029
 * database functions check that again. Opens a HOST-side conversation with the
 * Felyn Team in host Messages — or, if the host already has an open general one,
 * offers to continue it (the database would reuse it anyway). Questions about a
 * booking start from that request's own "Get help", so the booking is attached.
 */
export default async function ProviderHelpPage() {
  const supabase = await createSupabaseServerClient();
  const openThreadId = await getOpenSupportThreadId(supabase, "host", null);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <p className="text-xs font-medium tracking-wide text-navy-300">HELP</p>
      <Heading level={1} className="mt-2">
        Talk to Felyn
      </Heading>
      <p className="mt-3 max-w-xl text-navy-600">
        Questions about a booking, payouts, your experiences or your account? Send us a message — the Felyn Team replies
        right here in your Messages.
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
                You already have a conversation with the Felyn Team. Continue it there — we&apos;ll see everything in one
                place.
              </p>
              <Link
                href={getSupportConversationHref(openThreadId, "host")}
                className="inline-flex h-11 items-center justify-center rounded-full bg-navy-900 px-6 text-base font-medium text-ivory-50 transition-colors hover:bg-navy-950"
              >
                Open conversation
              </Link>
            </div>
          ) : (
            <ContactFelynForm requesterRole="host" />
          )}
        </div>
      </section>

      <p className="mt-6 text-sm text-navy-500">
        Need help with a specific booking? Open it from{" "}
        <Link href="/provider/requests" className="font-medium text-sky-600 hover:text-sky-700">
          Requests
        </Link>{" "}
        and choose <span className="font-medium text-navy-700">Get help</span>.
      </p>
    </div>
  );
}
