/**
 * How a host's payout account reads on /provider/payouts — pure, from the row
 * public.host_payout_account_status() (0037) returns. Readiness itself is 0036's
 * generated payouts_ready column, synced only from Stripe: the account fetched from
 * Stripe's API (0038, account-sync.ts) or a verified account.updated event (0037).
 */
export type HostPayoutRow = {
  provider_id: string | null;
  stripe_account_id: string | null;
  payouts_ready: boolean | null;
  details_submitted: boolean | null;
  requirements_due: number | null;
  disabled_reason: string | null;
  /** When Stripe's state was last recorded (null: never synced). */
  stripe_synced_at?: string | null;
};

export type HostPayoutSummary = {
  state: "not_host" | "not_started" | "in_progress" | "action_needed" | "ready";
  label: string;
  description: string;
};

export function getHostPayoutSummary(row: HostPayoutRow | null): HostPayoutSummary {
  if (!row?.provider_id) {
    return { state: "not_host", label: "Not available", description: "Only approved Felyn hosts can set up payouts." };
  }
  if (!row.stripe_account_id) {
    return {
      state: "not_started",
      label: "Not set up",
      description: "Set up payouts with Stripe so guests can pay for the bookings you accept.",
    };
  }
  if (row.payouts_ready) {
    // Capability readiness only: Stripe may still ask for details later (eventually-due
    // requirements), so this never claims every detail was verified.
    return {
      state: "ready",
      label: "Ready",
      description: "Stripe has enabled your account to receive payments. Guests can pay for the bookings you accept.",
    };
  }
  if (row.disabled_reason || (row.requirements_due ?? 0) > 0) {
    return {
      state: "action_needed",
      label: "Action needed",
      description: "Stripe needs a few more details before guests can pay for your bookings.",
    };
  }
  return {
    state: "in_progress",
    label: "In progress",
    description: row.details_submitted
      ? "Stripe is reviewing your details. This can take a few minutes."
      : "Finish your payout setup with Stripe so guests can pay for the bookings you accept.",
  };
}
