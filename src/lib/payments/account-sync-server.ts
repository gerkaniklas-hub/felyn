import "server-only";
import type { AccountSyncOutcome } from "./account-events";
import { createFailureCooldown, mapAccountToHostPayoutSync, PAYOUTS_PAGE_FAILURE_COOLDOWN_MS, shouldSyncOnPayoutsPage } from "./account-sync";
import { describeStripeFailure } from "./checkout";
import { createPaymentsAdminClient, getServerPayments } from "./server";
import { createStripeApi } from "./stripe-api";

/**
 * Fetches a host's connected account from Stripe (Accounts v2) and records it with
 * public.stripe_sync_host_account (0038, service_role only). Used by the Accounts v2
 * event route, by the legacy Connect route after an account.updated (so the fresher v2
 * reading wins), and by /provider/payouts. Idempotent: it records Stripe's current state,
 * and a slower, older reading never overwrites a newer one (the database answers
 * "stale"). Never throws. Logs carry only status, type, code and request id.
 */
export async function syncHostPayoutAccount(secretKey: string, accountId: string): Promise<AccountSyncOutcome> {
  const admin = createPaymentsAdminClient();
  if (!admin) return "database_unavailable";

  try {
    // Taken BEFORE the fetch: the recorded state is at least this recent.
    const fetchedAt = new Date().toISOString();
    const fetched = await createStripeApi(secretKey).retrieveAccount(accountId);
    if (!fetched.ok) {
      if (fetched.status === 404) return "stripe_not_found";
      console.error(`payments: Stripe did not return a connected account (${describeStripeFailure(fetched)})`);
      return "stripe_unavailable";
    }
    const mapped = mapAccountToHostPayoutSync(fetched.data, accountId);
    if (!mapped.ok) {
      console.error(`payments: unexpected connected account from Stripe (${mapped.error})`);
      return "invalid_account";
    }

    const { sync } = mapped;
    const { data, error } = await admin.rpc("stripe_sync_host_account", {
      p_account_id: accountId,
      p_fetched_at: fetchedAt,
      p_details_submitted: sync.detailsSubmitted,
      p_payouts_enabled: sync.payoutsEnabled,
      p_transfers_capability: sync.transfersCapability,
      p_requirements_currently_due: sync.requirementsCurrentlyDue,
      p_requirements_past_due: sync.requirementsPastDue,
      p_disabled_reason: sync.disabledReason,
    });
    if (error) {
      console.error(`payments: could not record the connected account's state (database code ${error.code ?? "none"})`);
      return "database_unavailable";
    }
    if (data === "synced" || data === "stale" || data === "unknown_account") return data;
    console.error("payments: unexpected answer from stripe_sync_host_account");
    return "database_unavailable";
  } catch {
    // e.g. the database client failing to reach Supabase.
    console.error("payments: connected account sync failed unexpectedly");
    return "database_unavailable";
  }
}

// Page syncs: one in flight per account (concurrent page views share it), and a
// cooldown after a failure (account-sync.ts, D5). Per server instance, in memory.
const pageSyncCooldown = createFailureCooldown(PAYOUTS_PAGE_FAILURE_COOLDOWN_MS);
const pageSyncInFlight = new Map<string, Promise<AccountSyncOutcome>>();

/**
 * /provider/payouts: refreshes the signed-in host's own account from Stripe while it
 * isn't ready (and, until the Accounts v2 event destination is configured, re-checks a
 * ready one every 15 minutes), bounded by the last recorded sync (account-sync.ts) and,
 * after a failed attempt, by a cooldown. The account id comes from public.host_payout_account_status()
 * — the calling host's own row — never from the request. Returns whether a sync was
 * recorded, or a newer one already was (the page then reads its status again).
 */
export async function syncHostPayoutAccountOnPageView(
  row: { stripe_account_id: string | null; payouts_ready: boolean | null; stripe_synced_at?: string | null } | null,
  returnedFromStripe: boolean,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const payments = getServerPayments();
  if (!payments.enabled || !row?.stripe_account_id) return false;
  const accountId = row.stripe_account_id;
  const due = shouldSyncOnPayoutsPage({
    hasAccount: true,
    payoutsReady: row.payouts_ready === true,
    syncedAt: row.stripe_synced_at ?? null,
    returnedFromStripe,
    accountEventsConfigured: payments.config.accountEventsWebhookSecret !== null,
    nowMs,
  });
  if (!due || pageSyncCooldown.blocked(accountId, nowMs)) return false;

  let pending = pageSyncInFlight.get(accountId);
  if (!pending) {
    pending = syncHostPayoutAccount(payments.config.secretKey, accountId).finally(() => pageSyncInFlight.delete(accountId));
    pageSyncInFlight.set(accountId, pending);
  }
  const outcome = await pending;
  // "stale" means a newer reading is already recorded: not a failure.
  if (outcome === "synced" || outcome === "stale") pageSyncCooldown.clear(accountId);
  else pageSyncCooldown.fail(accountId, nowMs);
  // Either way the stored state changed since the page read it: read it again.
  return outcome === "synced" || outcome === "stale";
}
