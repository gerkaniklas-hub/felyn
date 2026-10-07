import Link from "next/link";
import { ContactFelynForm } from "@/components/support/ContactFelynForm";
import { FelynTeamAvatar } from "@/components/support/FelynTeamAvatar";
import { buttonClasses } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Eyebrow } from "@/components/ui/page";
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
    <div className="w-full max-w-3xl">
      <Eyebrow>Help</Eyebrow>
      <Heading level={1} className="mt-3">
        Talk to Felyn
      </Heading>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-navy-600">
        Questions about a booking, payouts, your experiences or your account? Send us a message — the Felyn Team replies
        right here in your Messages.
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
                You already have a conversation with the Felyn Team. Continue it there — we&apos;ll see everything in one
                place.
              </p>
              <Link
                href={getSupportConversationHref(openThreadId, "host")}
                className={buttonClasses()}
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
