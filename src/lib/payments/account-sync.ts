/**
 * Stripe Accounts v2: a host's connected account → Felyn's host payout record.
 * Pure (relative imports only), so it runs under `npm test` as well as in Next.js.
 *
 * Hosts' accounts are created with Accounts v2 (POST /v2/core/accounts, recipient
 * configuration). Stripe then sends Accounts v2 "thin" events, which carry only the
 * event type and the account id — never the account's state. Stripe's documented way
 * is to fetch the account (GET /v2/core/accounts/{id}); this module:
 *   1. reads a thin event notification (after the route has verified its signature);
 *   2. maps the FETCHED account onto the existing columns of 0036's payout account table, which
 *      0036's generated payouts_ready turns into readiness (unchanged):
 *        details_submitted and payouts_enabled and transfers_capability = 'active'
 *        and disabled_reason is null and no past-due requirement.
 * Fields used (Account object, Stripe-Version 2025-12-15.clover):
 *   object, id, livemode, closed, applied_configurations, configuration.recipient.applied
 *   configuration.recipient.capabilities.stripe_balance.stripe_transfers.status
 *   configuration.recipient.capabilities.stripe_balance.payouts.status
 *     (both: active | pending | restricted | unsupported; status_details[].code)
 *   requirements.entries[]: description, awaiting_action_from (user | stripe),
 *     minimum_deadline.status (currently_due | eventually_due | past_due)
 * Anything missing or unexpected maps to "not ready" (fail closed).
 */

/** The Accounts v2 events that can change whether a host can be paid. */
export const ACCOUNT_SYNC_EVENT_TYPES = [
  "v2.core.account[requirements].updated",
  "v2.core.account[configuration.recipient].capability_status_updated",
] as const;

export type AccountEventNotice =
  | { kind: "sync"; eventId: string; type: string; accountId: string }
  | { kind: "ignore"; eventId: string; type: string }
  | { kind: "live" }
  | { kind: "malformed" };

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,250}$/;
const EVENT_TYPE = /^[a-z0-9_.[\]]{1,120}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A verified thin event notification. Only the two types above, for a v2 Account, lead
 * to a sync; any other well-formed event (e.g. v2.core.event_destination.ping) is
 * acknowledged and ignored. Live-mode events are refused (this build is test mode only).
 */
export function parseAccountEventNotice(value: unknown): AccountEventNotice {
  if (!isRecord(value) || value.object !== "v2.core.event") return { kind: "malformed" };
  const { id, type, livemode } = value;
  if (typeof id !== "string" || !EVENT_ID.test(id) || typeof type !== "string" || !EVENT_TYPE.test(type)) return { kind: "malformed" };
  if (livemode !== false) return livemode === true ? { kind: "live" } : { kind: "malformed" };
  if (!(ACCOUNT_SYNC_EVENT_TYPES as readonly string[]).includes(type)) return { kind: "ignore", eventId: id, type };
  const related = value.related_object;
  if (!isRecord(related) || related.type !== "v2.core.account" || typeof related.id !== "string" || !ACCOUNT_ID.test(related.id)) {
    return { kind: "malformed" };
  }
  return { kind: "sync", eventId: id, type, accountId: related.id };
}

/** What public.stripe_sync_host_account (0038) records. */
export type HostPayoutSync = {
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  transfersCapability: "active" | "inactive" | "pending" | "unrequested";
  requirementsCurrentlyDue: string[];
  requirementsPastDue: string[];
  disabledReason: string | null;
};

/**
 * Mapping errors: nothing is recorded (the stored state stays as it was), and the sync
 * reports "invalid_account". Everything else that is incomplete or unexpected is recorded
 * as NOT ready rather than refused, so the host sees an honest status.
 */
export type AccountMappingError =
  | "not_an_account" // not a v2 Account object
  | "account_mismatch" // not the account Felyn asked for
  | "live_account" // livemode true: this build is test mode only
  | "livemode_missing" // livemode absent or not a boolean
  | "requirements_missing"; // no requirements field at all: the include wasn't applied

export type AccountMapping = { ok: true; sync: HostPayoutSync } | { ok: false; error: AccountMappingError };

/**
 * Felyn's own reasons (not Stripe status codes) for an account that can't be paid,
 * recorded in disabled_reason when Stripe's capability codes don't apply.
 */
export const FELYN_REASON_ACCOUNT_CLOSED = "felyn_account_closed";
export const FELYN_REASON_RECIPIENT_NOT_APPLIED = "felyn_recipient_not_applied";

const MAX_REQUIREMENTS = 200;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,100}$/;

function recipientConfiguration(account: Record<string, unknown>): Record<string, unknown> | null {
  const configuration = isRecord(account.configuration) ? account.configuration : null;
  return configuration && isRecord(configuration.recipient) ? configuration.recipient : null;
}

function capability(recipient: Record<string, unknown> | null, name: "stripe_transfers" | "payouts"): Record<string, unknown> | null {
  const capabilities = recipient && isRecord(recipient.capabilities) ? recipient.capabilities : null;
  const balance = capabilities && isRecord(capabilities.stripe_balance) ? capabilities.stripe_balance : null;
  const cap = balance ? balance[name] : null;
  return isRecord(cap) ? cap : null;
}

/** Stripe's machine-readable description, or null — never a made-up one. */
function requirementDescription(entry: Record<string, unknown>): string | null {
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  return description ? description.slice(0, 200) : null;
}

/**
 * Maps the account Felyn just fetched from Stripe; `expectedAccountId` is the one it asked
 * for. Fails closed throughout:
 *   - livemode must be exactly false; the requirements field must be present;
 *   - a closed account (closed === true), or one whose applied_configurations doesn't list
 *     "recipient" (or whose configuration.recipient.applied is false), is not ready;
 *   - requirements: null (or without an entries list) means "unknown", never "nothing due";
 *     entries whose minimum_deadline.status is missing or not one Felyn knows count as due;
 *     eventually_due entries (future thresholds) don't block, as in Stripe's onboarding;
 *     an entry with no description still blocks, it just isn't listed by name.
 */
export function mapAccountToHostPayoutSync(account: unknown, expectedAccountId: string): AccountMapping {
  if (!isRecord(account) || account.object !== "v2.core.account") return { ok: false, error: "not_an_account" };
  if (account.id !== expectedAccountId) return { ok: false, error: "account_mismatch" };
  if (account.livemode === true) return { ok: false, error: "live_account" };
  if (account.livemode !== false) return { ok: false, error: "livemode_missing" };
  if (!("requirements" in account)) return { ok: false, error: "requirements_missing" };

  const recipient = recipientConfiguration(account);
  const closed = account.closed === true;
  const recipientApplied =
    Array.isArray(account.applied_configurations) && account.applied_configurations.includes("recipient") && recipient?.applied !== false;

  const transfers = capability(recipient, "stripe_transfers");
  const transfersStatus = transfers?.status;
  let transfersCapability: HostPayoutSync["transfersCapability"] =
    transfers === null ? "unrequested" : transfersStatus === "active" ? "active" : transfersStatus === "pending" ? "pending" : "inactive";
  let payoutsEnabled = capability(recipient, "payouts")?.status === "active";

  let disabledReason: string | null = null;
  if (closed) {
    disabledReason = FELYN_REASON_ACCOUNT_CLOSED;
  } else if (!recipientApplied) {
    disabledReason = FELYN_REASON_RECIPIENT_NOT_APPLIED;
  } else if (transfers !== null && transfersStatus !== "active" && transfersStatus !== "pending") {
    const details = Array.isArray(transfers.status_details) ? transfers.status_details : [];
    const code = details.map((d) => (isRecord(d) ? d.code : null)).find((c): c is string => typeof c === "string" && SAFE_CODE.test(c));
    disabledReason = code ?? (typeof transfersStatus === "string" && SAFE_CODE.test(transfersStatus) ? transfersStatus : "transfers_unavailable");
  }
  if (closed || !recipientApplied) {
    // Whatever capability statuses remain, a closed account or an unapplied recipient
    // configuration can't receive anything.
    if (transfersCapability === "active" || transfersCapability === "pending") transfersCapability = "inactive";
    payoutsEnabled = false;
  }

  const requirements = account.requirements;
  const entries = isRecord(requirements) && Array.isArray(requirements.entries) ? requirements.entries : null;
  // null requirements, or no entries list: unknown, so not "submitted".
  let detailsSubmitted = entries !== null;
  const currentlyDue = new Set<string>();
  const pastDue = new Set<string>();
  for (const raw of entries ?? []) {
    if (!isRecord(raw)) {
      detailsSubmitted = false;
      continue;
    }
    const description = requirementDescription(raw);
    const deadline = isRecord(raw.minimum_deadline) ? raw.minimum_deadline.status : undefined;
    const onStripe = raw.awaiting_action_from === "stripe"; // anything else counts as the host's
    if (deadline === "eventually_due") continue;
    if (deadline === "past_due") {
      if (description) pastDue.add(description);
      if (!onStripe || !description) detailsSubmitted = false;
    } else if (deadline === "currently_due" && onStripe) {
      // Stripe reviewing what the host sent: not the host's action (the capability is pending).
      continue;
    } else {
      // currently_due on the host, or a missing/unknown deadline status: due now.
      if (description) currentlyDue.add(description);
      detailsSubmitted = false;
    }
  }

  return {
    ok: true,
    sync: {
      detailsSubmitted,
      payoutsEnabled,
      transfersCapability,
      requirementsCurrentlyDue: [...currentlyDue].slice(0, MAX_REQUIREMENTS),
      requirementsPastDue: [...pastDue].slice(0, MAX_REQUIREMENTS),
      disabledReason,
    },
  };
}

/**
 * D5: a cooldown for FAILED page syncs (Stripe 403/timeout/outage, the database or 0038
 * unavailable), so a failing sync isn't retried on every page view. Successful syncs are
 * bounded by stripe_synced_at (shouldSyncOnPayoutsPage); a failure never touches that
 * timestamp. Kept in memory per server instance — no new database state — so the bound is
 * one attempt per account per cooldown per running instance; a cold start may try again.
 */
export const PAYOUTS_PAGE_FAILURE_COOLDOWN_MS = 5 * 60_000;

export function createFailureCooldown(cooldownMs: number, maxEntries = 1000) {
  const failedAt = new Map<string, number>();
  return {
    /** True while `key` failed less than `cooldownMs` ago. */
    blocked(key: string, nowMs: number): boolean {
      const at = failedAt.get(key);
      return at !== undefined && nowMs - at < cooldownMs;
    },
    fail(key: string, nowMs: number): void {
      if (failedAt.size >= maxEntries && !failedAt.has(key)) {
        const oldest = failedAt.keys().next().value;
        if (oldest !== undefined) failedAt.delete(oldest);
      }
      failedAt.delete(key);
      failedAt.set(key, nowMs);
    },
    clear(key: string): void {
      failedAt.delete(key);
    },
  };
}

/**
 * When the payouts page fetches the host's account: only while it isn't ready, and
 * bounded by the last recorded sync — once a minute on a plain refresh, every 10 seconds
 * right after coming back from Stripe (the ?onboarding=return URL stays on reloads).
 */
export const PAYOUTS_PAGE_SYNC_INTERVAL_MS = 60_000;
export const PAYOUTS_RETURN_SYNC_INTERVAL_MS = 10_000;
/**
 * A READY host is re-checked only while the Accounts v2 event destination isn't set up
 * (STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET absent): without its events nothing would tell
 * Felyn that Stripe later restricted the account. Once the destination is configured,
 * its events keep a ready host current and the page no longer calls Stripe for them.
 */
export const PAYOUTS_READY_RECHECK_INTERVAL_MS = 15 * 60_000;

export function shouldSyncOnPayoutsPage(input: {
  hasAccount: boolean;
  payoutsReady: boolean;
  syncedAt: string | null;
  returnedFromStripe: boolean;
  /** Whether the Accounts v2 event destination is configured (its secret is set). */
  accountEventsConfigured: boolean;
  nowMs: number;
}): boolean {
  if (!input.hasAccount) return false;
  if (input.payoutsReady && input.accountEventsConfigured) return false;
  if (!input.syncedAt) return true;
  const synced = Date.parse(input.syncedAt);
  if (!Number.isFinite(synced)) return true;
  const interval = input.payoutsReady
    ? PAYOUTS_READY_RECHECK_INTERVAL_MS
    : input.returnedFromStripe ? PAYOUTS_RETURN_SYNC_INTERVAL_MS : PAYOUTS_PAGE_SYNC_INTERVAL_MS;
  return input.nowMs - synced >= interval;
}
