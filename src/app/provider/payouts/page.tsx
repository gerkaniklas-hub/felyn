import Link from "next/link";
import { redirect } from "next/navigation";
import { HostPayoutSetupButton } from "@/components/provider/HostPayoutSetupButton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { PageHeader, textLinkClass } from "@/components/ui/page";
import { syncHostPayoutAccountOnPageView } from "@/lib/payments/account-sync-server";
import { getHostPayoutSummary, type HostPayoutRow } from "@/lib/payments/host-payouts";
import { getServerPayments } from "@/lib/payments/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The host's payout setup (Stripe Connect, TEST MODE). Guests can pay for a host's
 * accepted bookings only once Stripe reports the host's account ready (0036 FB006).
 * The state shown is the database's, synced from Stripe: the host's account as fetched
 * from Stripe's API (here while it isn't ready, at most every 10–60 seconds — and, until
 * the Accounts v2 event destination is configured, every 15 minutes while ready — and on
 * verified Accounts v2 events), or a verified legacy account.updated event. Felyn never
 * pays a host out in this phase: no transfer or payout is created anywhere in this build.
 */
export default async function ProviderPayoutsPage({ searchParams }: { searchParams: Promise<{ onboarding?: string }> }) {
  const { onboarding } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login/host");

  const payments = getServerPayments();
  const readRow = async () => {
    const { data } = await supabase.rpc("host_payout_account_status");
    return (Array.isArray(data) ? data[0] : null) as HostPayoutRow | null;
  };
  let row = await readRow();
  // The host's own account only (from the row above); bounded, idempotent, never throws.
  if (await syncHostPayoutAccountOnPageView(row, onboarding === "return")) row = await readRow();
  const summary = getHostPayoutSummary(row);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Payouts" />
      <Card className="flex max-w-2xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Heading level={3} as="h2">
            Receiving payments
          </Heading>
          <Badge tone={summary.state === "ready" ? "sky" : "navy"}>{summary.label}</Badge>
        </div>
        <p className="text-sm text-navy-600">{summary.description}</p>
        {onboarding === "return" && summary.state !== "ready" ? (
          <p className="text-sm text-navy-600">
            Thanks — Stripe is checking your details. This page updates once Stripe confirms them.
          </p>
        ) : null}
        {!payments.enabled ? (
          <p className="text-sm text-navy-500">Payout setup isn&apos;t available yet.</p>
        ) : summary.state === "not_host" ? null : summary.state === "ready" ? null : (
          <HostPayoutSetupButton label={summary.state === "not_started" ? "Set up payouts with Stripe" : "Continue payout setup"} />
        )}
        <p className="text-xs text-navy-500">
          Stripe test mode: use Stripe&apos;s test details during setup. No real money moves, and Felyn doesn&apos;t send
          payouts in this phase.
        </p>
        <Link href="/provider/profile" className={`self-start text-sm ${textLinkClass}`}>
          ← Back to your profile
        </Link>
      </Card>
    </div>
  );
}
