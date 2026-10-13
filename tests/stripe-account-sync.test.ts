import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { handleAccountEvent, type AccountEventDeps, type AccountSyncOutcome } from "../src/lib/payments/account-events";
import {
  ACCOUNT_SYNC_EVENT_TYPES,
  createFailureCooldown,
  FELYN_REASON_ACCOUNT_CLOSED,
  FELYN_REASON_RECIPIENT_NOT_APPLIED,
  mapAccountToHostPayoutSync,
  parseAccountEventNotice,
  PAYOUTS_PAGE_SYNC_INTERVAL_MS,
  PAYOUTS_READY_RECHECK_INTERVAL_MS,
  PAYOUTS_RETURN_SYNC_INTERVAL_MS,
  shouldSyncOnPayoutsPage,
  type HostPayoutSync,
} from "../src/lib/payments/account-sync";
import { getHostPayoutSummary } from "../src/lib/payments/host-payouts";
import { handleStripeWebhook, type WebhookDeps } from "../src/lib/payments/webhook";
import { signStripePayloadForTest } from "../src/lib/payments/webhook-signature";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = read("supabase", "migrations", "0038_stripe_account_sync.sql");

// Fake values in the right shape; not real secrets or accounts.
const SECRET = "whsec_FAKEACCOUNTS00000000000";
const ACCOUNT = "acct_1TestHost000000";
const NOW = 1_800_000_000;

/** 0036's generated payouts_ready, as the database computes it from the synced columns. */
function payoutsReady(s: HostPayoutSync): boolean {
  return s.detailsSubmitted && s.payoutsEnabled && s.transfersCapability === "active" && s.disabledReason === null && s.requirementsPastDue.length === 0;
}

type Over = {
  transfers?: object | null;
  payouts?: object | null;
  requirements?: unknown; // the whole field; "absent" to leave it out
  entries?: unknown[];
  recipient?: object | null; // the whole recipient configuration
  extra?: Record<string, unknown>;
};
/** A v2 Account as GET /v2/core/accounts/{id}?include=configuration.recipient,requirements returns it (fixture). */
function account(over: Over = {}): Record<string, unknown> {
  const balance: Record<string, unknown> = {};
  if (over.transfers !== null) balance.stripe_transfers = over.transfers ?? { status: "active", status_details: [] };
  if (over.payouts !== null) balance.payouts = over.payouts ?? { status: "active", status_details: [] };
  const acct: Record<string, unknown> = {
    id: ACCOUNT,
    object: "v2.core.account",
    livemode: false,
    closed: false,
    applied_configurations: ["recipient"],
    configuration: { recipient: over.recipient === undefined ? { applied: true, capabilities: { stripe_balance: balance } } : over.recipient },
    requirements: over.requirements === undefined ? { entries: over.entries ?? [], summary: null } : over.requirements,
    ...over.extra,
  };
  if (over.requirements === "absent") delete acct.requirements;
  return acct;
}

function requirement(description: string | undefined, status: string | undefined, from = "user") {
  const entry: Record<string, unknown> = { awaiting_action_from: from, errors: [], requested_reasons: [] };
  if (description !== undefined) entry.description = description;
  if (status !== undefined) entry.minimum_deadline = { status };
  return entry;
}

function mapped(acct: unknown): HostPayoutSync {
  const result = mapAccountToHostPayoutSync(acct, ACCOUNT);
  assert.ok(result.ok, JSON.stringify(result));
  return result.sync;
}

// ── the fetched account → Felyn's payout record ──

test("verified account: both capabilities active, applied recipient, empty requirements → Ready", () => {
  const sync = mapped(account());
  assert.deepEqual(sync, {
    detailsSubmitted: true,
    payoutsEnabled: true,
    transfersCapability: "active",
    requirementsCurrentlyDue: [],
    requirementsPastDue: [],
    disabledReason: null,
  });
  assert.equal(payoutsReady(sync), true);
  // eventually_due items (future thresholds) don't block, as in Stripe's onboarding.
  assert.equal(payoutsReady(mapped(account({ entries: [requirement("individual.id_number", "eventually_due")] }))), true);
});

test("D1: missing requirements data never means 'nothing due'", () => {
  assert.deepEqual(mapAccountToHostPayoutSync(account({ requirements: "absent" }), ACCOUNT), { ok: false, error: "requirements_missing" });
  for (const requirements of [null, {}, { entries: null }, { entries: "x" }]) {
    const sync = mapped(account({ requirements }));
    assert.equal(sync.detailsSubmitted, false, JSON.stringify(requirements));
    assert.equal(payoutsReady(sync), false, JSON.stringify(requirements));
  }
});

test("D2: missing or unknown deadline statuses count as due; nothing is invented for a missing description", () => {
  for (const status of [undefined, "something_new", ""]) {
    const sync = mapped(account({ entries: [requirement("individual.address.city", status)] }));
    assert.equal(sync.detailsSubmitted, false, String(status));
    assert.deepEqual(sync.requirementsCurrentlyDue, ["individual.address.city"], String(status));
    assert.equal(payoutsReady(sync), false, String(status));
  }
  // Even when Stripe is the one acting, an unknown status still blocks.
  assert.equal(payoutsReady(mapped(account({ entries: [requirement("x.y", "something_new", "stripe")] }))), false);
  // No description: still blocks, but no made-up name is recorded.
  const unnamed = mapped(account({ entries: [requirement(undefined, "currently_due")] }));
  assert.equal(unnamed.detailsSubmitted, false);
  assert.deepEqual(unnamed.requirementsCurrentlyDue, []);
  const unnamedPast = mapped(account({ entries: [requirement("  ", "past_due", "stripe")] }));
  assert.equal(unnamedPast.detailsSubmitted, false);
  assert.deepEqual(unnamedPast.requirementsPastDue, []);
  assert.equal(payoutsReady(unnamedPast), false);
  // A malformed entry blocks too.
  assert.equal(payoutsReady(mapped(account({ entries: ["not an object"] }))), false);
});

test("outstanding requirements: the host's items → Action needed; Stripe's review → In progress; past due always blocks", () => {
  const due = mapped(account({
    transfers: { status: "restricted", status_details: [{ code: "requirements_past_due", resolution: "provide_info" }] },
    entries: [requirement("individual.first_name", "currently_due"), requirement("individual.first_name", "currently_due")],
  }));
  assert.equal(due.detailsSubmitted, false);
  assert.deepEqual(due.requirementsCurrentlyDue, ["individual.first_name"], "deduplicated");
  assert.equal(payoutsReady(due), false);
  assert.equal(getHostPayoutSummary({ provider_id: "p", stripe_account_id: ACCOUNT, payouts_ready: false, details_submitted: false, requirements_due: 1, disabled_reason: null }).state, "action_needed");

  const reviewing = mapped(account({ transfers: { status: "pending", status_details: [] }, entries: [requirement("individual.verification.document", "currently_due", "stripe")] }));
  assert.equal(reviewing.detailsSubmitted, true);
  assert.deepEqual(reviewing.requirementsCurrentlyDue, []);
  assert.equal(reviewing.transfersCapability, "pending");
  assert.equal(reviewing.disabledReason, null);
  assert.equal(payoutsReady(reviewing), false);

  const pastDue = mapped(account({ entries: [requirement("individual.id_number", "past_due")] }));
  assert.deepEqual(pastDue.requirementsPastDue, ["individual.id_number"]);
  assert.equal(payoutsReady(pastDue), false);
  assert.equal(payoutsReady(mapped(account({ entries: [requirement("individual.verification", "past_due", "stripe")] }))), false);
});

test("capabilities: only 'active' counts; missing, pending, restricted, unsupported and unknown are not ready", () => {
  const cases: [object | null, HostPayoutSync["transfersCapability"], string | null][] = [
    [{ status: "active", status_details: [] }, "active", null],
    [{ status: "pending", status_details: [] }, "pending", null],
    [{ status: "restricted", status_details: [{ code: "requirements_pending_verification" }] }, "inactive", "requirements_pending_verification"],
    [{ status: "unsupported", status_details: [] }, "inactive", "unsupported"],
    [{ status: "something_new", status_details: [{ code: "has spaces <script>" }] }, "inactive", "something_new"],
    [{ status_details: [] }, "inactive", "transfers_unavailable"],
    [null, "unrequested", null],
  ];
  for (const [transfers, capability, reason] of cases) {
    const sync = mapped(account({ transfers }));
    assert.equal(sync.transfersCapability, capability, JSON.stringify(transfers));
    assert.equal(sync.disabledReason, reason, JSON.stringify(transfers));
    assert.equal(payoutsReady(sync), capability === "active", JSON.stringify(transfers));
  }
  for (const payouts of [null, { status: "pending" }, { status: "restricted" }, { status: "unsupported" }, {}]) {
    const sync = mapped(account({ payouts }));
    assert.equal(sync.payoutsEnabled, false, JSON.stringify(payouts));
    assert.equal(payoutsReady(sync), false, "readiness still needs payouts (0036, unchanged)");
  }
});

test("D3: a closed account or an unapplied recipient configuration is never ready", () => {
  const closed = mapped(account({ extra: { closed: true } }));
  assert.equal(closed.disabledReason, FELYN_REASON_ACCOUNT_CLOSED);
  assert.equal(closed.transfersCapability, "inactive");
  assert.equal(closed.payoutsEnabled, false);
  assert.equal(payoutsReady(closed), false);
  // closed absent or null (the field is nullable) is not "closed".
  assert.equal(payoutsReady(mapped(account({ extra: { closed: null } }))), true);
  for (const extra of [{ applied_configurations: [] }, { applied_configurations: ["merchant"] }, { applied_configurations: undefined }, { applied_configurations: "recipient" }]) {
    const sync = mapped(account({ extra }));
    assert.equal(sync.disabledReason, FELYN_REASON_RECIPIENT_NOT_APPLIED, JSON.stringify(extra));
    assert.equal(payoutsReady(sync), false, JSON.stringify(extra));
  }
  const switchedOff = mapped(account({ recipient: { applied: false, capabilities: { stripe_balance: { stripe_transfers: { status: "active" }, payouts: { status: "active" } } } } }));
  assert.equal(switchedOff.disabledReason, FELYN_REASON_RECIPIENT_NOT_APPLIED);
  assert.equal(payoutsReady(switchedOff), false);
  const noRecipient = mapped(account({ recipient: null }));
  assert.equal(noRecipient.transfersCapability, "unrequested");
  assert.equal(payoutsReady(noRecipient), false);
});

test("D4 and identity: only the account asked for, with livemode exactly false", () => {
  assert.deepEqual(mapAccountToHostPayoutSync(account({ extra: { id: "acct_someoneElse" } }), ACCOUNT), { ok: false, error: "account_mismatch" });
  assert.deepEqual(mapAccountToHostPayoutSync(account({ extra: { livemode: true } }), ACCOUNT), { ok: false, error: "live_account" });
  for (const livemode of [undefined, null, "false", 0]) {
    assert.deepEqual(mapAccountToHostPayoutSync(account({ extra: { livemode } }), ACCOUNT), { ok: false, error: "livemode_missing" }, String(livemode));
  }
  assert.deepEqual(mapAccountToHostPayoutSync(account({ extra: { object: "account" } }), ACCOUNT), { ok: false, error: "not_an_account" });
  assert.deepEqual(mapAccountToHostPayoutSync(null, ACCOUNT), { ok: false, error: "not_an_account" });
  const many = Array.from({ length: 250 }, (_, i) => requirement(`field_${i}`, "currently_due"));
  assert.equal(mapped(account({ entries: many })).requirementsCurrentlyDue.length, 200, "capped like the database (≤ 200)");
});

// ── regression: a real sandbox response (sanitized, tests/fixtures) ──

const realFixture = () =>
  JSON.parse(read("tests", "fixtures", "stripe-v2-account-recipient-eventually-due.json")) as Record<string, unknown> & {
    id: string;
    requirements: { entries: Record<string, unknown>[] };
  };

test("real sandbox account: both capabilities active, one eventually-due identity requirement with an error → Ready", () => {
  const fixture = realFixture();
  assert.doesNotMatch(JSON.stringify(fixture), /@|contact_email|display_name|"identity"/, "the fixture carries no personal data");
  const result = mapAccountToHostPayoutSync(fixture, fixture.id);
  assert.deepEqual(result, {
    ok: true,
    sync: {
      detailsSubmitted: true, // nothing due NOW; it never means "identity verified"
      payoutsEnabled: true,
      transfersCapability: "active",
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
    },
  });
  assert.ok(result.ok && payoutsReady(result.sync));
  // Stripe itself keeps both capabilities active until the requirement's deadline: that
  // is what the entry's impact says (eventually_due for both recipient capabilities).
  const [entry] = fixture.requirements.entries;
  assert.deepEqual((entry.errors as { code: string }[]).map((e) => e.code), ["verification_failed_keyed_identity"]);
});

test("real sandbox account: when Stripe escalates the same identity requirement, Felyn stops being Ready", () => {
  const escalate = (status: string, capabilityStatus = "active") => {
    const fixture = realFixture();
    fixture.requirements.entries[0].minimum_deadline = { status };
    const balance = (fixture.configuration as { recipient: { capabilities: { stripe_balance: Record<string, { status: string }> } } }).recipient.capabilities.stripe_balance;
    balance.stripe_transfers.status = capabilityStatus;
    return mapped({ ...fixture, id: ACCOUNT });
  };
  const currentlyDue = escalate("currently_due");
  assert.equal(currentlyDue.detailsSubmitted, false);
  assert.deepEqual(currentlyDue.requirementsCurrentlyDue, ["identity.individual.documents.primary_verification"]);
  assert.equal(payoutsReady(currentlyDue), false);
  const pastDue = escalate("past_due", "restricted");
  assert.deepEqual(pastDue.requirementsPastDue, ["identity.individual.documents.primary_verification"]);
  assert.equal(pastDue.transfersCapability, "inactive");
  assert.equal(payoutsReady(pastDue), false);
});

// ── thin event notifications ──

const notice = (type: string, over: object = {}) => ({
  id: "evt_test_65UIRNU7G1XbhCfOim416TgmEI4ASQ3jHxXt8RFwXoeVwO",
  object: "v2.core.event",
  type,
  livemode: false,
  created: "2026-10-13T12:00:00.000Z",
  context: null,
  reason: null,
  related_object: { id: ACCOUNT, type: "v2.core.account", url: `/v2/core/accounts/${ACCOUNT}` },
  ...over,
});

test("the two Accounts v2 event types lead to a sync of the related account; others are ignored", () => {
  assert.deepEqual([...ACCOUNT_SYNC_EVENT_TYPES], [
    "v2.core.account[requirements].updated",
    "v2.core.account[configuration.recipient].capability_status_updated",
  ]);
  for (const type of ACCOUNT_SYNC_EVENT_TYPES) {
    assert.deepEqual(parseAccountEventNotice(notice(type)), { kind: "sync", eventId: notice(type).id, type, accountId: ACCOUNT });
  }
  for (const type of ["v2.core.account[identity].updated", "v2.core.account_link.returned", "v2.core.event_destination.ping"]) {
    assert.equal(parseAccountEventNotice(notice(type)).kind, "ignore", type);
  }
  assert.deepEqual(parseAccountEventNotice(notice(ACCOUNT_SYNC_EVENT_TYPES[0], { livemode: true })), { kind: "live" });
  for (const bad of [
    null, [], "x",
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { object: "event" }),
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { id: "not-an-event" }),
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { livemode: undefined }),
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { related_object: null }),
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { related_object: { id: ACCOUNT, type: "v2.core.account_person" } }),
    notice(ACCOUNT_SYNC_EVENT_TYPES[0], { related_object: { id: "acct_../evil", type: "v2.core.account" } }),
  ]) {
    assert.equal(parseAccountEventNotice(bad).kind, "malformed", JSON.stringify(bad));
  }
});

// ── the route's logic (dependencies injected) ──

function harness(outcome: AccountSyncOutcome = "synced") {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: AccountEventDeps = {
    secrets: [SECRET],
    nowSeconds: NOW,
    syncAccount: async (accountId) => {
      calls.push(accountId);
      return outcome;
    },
    log: (message) => logs.push(message),
  };
  return { deps, calls, logs };
}
const bodyOf = (event: unknown) => new TextEncoder().encode(JSON.stringify(event));
const signed = (raw: Uint8Array, t = NOW, secret = SECRET) => signStripePayloadForTest(raw, secret, t);

test("a verified event fetches and records the related account (200); duplicates just record again", async () => {
  const { deps, calls } = harness();
  const raw = bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[1]));
  assert.deepEqual(await handleAccountEvent(raw, signed(raw), deps), { status: 200, body: { received: true } });
  assert.deepEqual(await handleAccountEvent(raw, signed(raw), deps), { status: 200, body: { received: true } });
  assert.deepEqual(calls, [ACCOUNT, ACCOUNT]);
  const stale = harness("stale");
  assert.equal((await handleAccountEvent(raw, signed(raw), stale.deps)).status, 200);
});

test("webhook failures: nothing is fetched for an unverified, stale, live, malformed or oversized request", async () => {
  const raw = bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[0]));
  const cases: [string, Uint8Array, string | null, number][] = [
    ["no signature", raw, null, 400],
    ["wrong secret", raw, signed(raw, NOW, "whsec_SOMEOTHERSECRET0000000"), 400],
    ["stale timestamp", raw, signed(raw, NOW - 301), 400],
    ["body changed after signing", bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[0], { related_object: { id: "acct_attacker1", type: "v2.core.account" } })), signed(raw), 400],
    ["empty body", new Uint8Array(0), signed(new Uint8Array(0)), 413],
    ["oversized body", new Uint8Array(512 * 1024 + 1), "t=1,v1=00", 413],
  ];
  for (const [name, body, header, status] of cases) {
    const { deps, calls } = harness();
    assert.equal((await handleAccountEvent(body, header, deps)).status, status, name);
    assert.deepEqual(calls, [], name);
  }
  const live = bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[0], { livemode: true }));
  const notJson = new TextEncoder().encode("not json");
  const badRef = bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[0], { related_object: { id: "cus_123", type: "v2.core.account" } }));
  for (const [name, body, status, error] of [["live", live, 400, "mode"], ["not JSON", notJson, 400, "body"], ["bad account reference", badRef, 400, "body"]] as const) {
    const { deps, calls } = harness();
    assert.deepEqual(await handleAccountEvent(body, signed(body), deps), { status, body: { received: false, error } }, name);
    assert.deepEqual(calls, [], name);
  }
  const ignored = bodyOf(notice("v2.core.account[identity].updated"));
  const ig = harness();
  assert.deepEqual(await handleAccountEvent(ignored, signed(ignored), ig.deps), { status: 200, body: { received: true } });
  assert.deepEqual(ig.calls, []);
});

test("webhook failures: Stripe or the database unavailable → 500 (Stripe retries); unknown accounts → 200", async () => {
  const raw = bodyOf(notice(ACCOUNT_SYNC_EVENT_TYPES[0]));
  for (const outcome of ["stripe_unavailable", "database_unavailable"] as const) {
    const { deps, logs } = harness(outcome);
    assert.deepEqual(await handleAccountEvent(raw, signed(raw), deps), { status: 500, body: { received: false, error: "unavailable" } }, outcome);
    assert.ok(logs.some((l) => l.includes(outcome)));
    for (const line of logs) assert.doesNotMatch(line, /whsec_|acct_|v1=/, "logs carry no secret, signature or account id");
  }
  for (const outcome of ["unknown_account", "stripe_not_found", "invalid_account"] as const) {
    const { deps } = harness(outcome);
    assert.equal((await handleAccountEvent(raw, signed(raw), deps)).status, 200, outcome);
  }
});

// ── the legacy Connect route: a processed account.updated is re-read through Accounts v2 ──

test("legacy account.updated: after the database applies it, the account is re-read through Accounts v2", async () => {
  const CONNECT_SECRET = "whsec_FAKECONNECT0000000000";
  const event = { id: "evt_1Legacy", object: "event", type: "account.updated", livemode: false, created: NOW, account: ACCOUNT, data: { object: { id: ACCOUNT, object: "account" } } };
  const raw = bodyOf(event);
  const run = async (endpoint: "connect" | "platform", result: string, resync: (id: string) => Promise<unknown>) => {
    const resynced: string[] = [];
    const deps: WebhookDeps = {
      secrets: [CONNECT_SECRET],
      nowSeconds: NOW,
      applyEvent: async () => ({ result }),
      capture: async () => true,
      cancel: async () => true,
      log: () => {},
      resyncAccount: async (id) => {
        resynced.push(id);
        return resync(id);
      },
    };
    const response = await handleStripeWebhook(endpoint, raw, signStripePayloadForTest(raw, CONNECT_SECRET, NOW), deps);
    return { response, resynced };
  };
  const ok = await run("connect", "processed", async () => "synced");
  assert.equal(ok.response.status, 200);
  assert.deepEqual(ok.resynced, [ACCOUNT]);
  // Not re-read for a duplicate, an ignored event, or on the platform endpoint.
  assert.deepEqual((await run("connect", "duplicate", async () => "synced")).resynced, []);
  assert.deepEqual((await run("connect", "ignored", async () => "synced")).resynced, []);
  assert.deepEqual((await run("platform", "processed", async () => "synced")).resynced, []);
  // A failing re-read never fails the delivery: the event's own (signed) state stays.
  const failing = await run("connect", "processed", async () => {
    throw new Error("down");
  });
  assert.equal(failing.response.status, 200);
});

// ── the payouts page's bounds ──

test("the payouts page syncs only while not ready, at most every 10 s after returning and every 60 s otherwise", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const base = { hasAccount: true, payoutsReady: false, syncedAt: null as string | null, returnedFromStripe: false, accountEventsConfigured: true, nowMs: now };
  assert.equal(shouldSyncOnPayoutsPage(base), true, "never synced");
  assert.equal(shouldSyncOnPayoutsPage({ ...base, payoutsReady: true }), false, "ready with the event destination: no Stripe call");
  assert.equal(shouldSyncOnPayoutsPage({ ...base, payoutsReady: true, syncedAt: at(24 * 3_600_000) }), false);
  assert.equal(shouldSyncOnPayoutsPage({ ...base, hasAccount: false }), false, "no account yet");
  assert.equal(shouldSyncOnPayoutsPage({ ...base, syncedAt: at(PAYOUTS_PAGE_SYNC_INTERVAL_MS - 1) }), false);
  assert.equal(shouldSyncOnPayoutsPage({ ...base, syncedAt: at(PAYOUTS_PAGE_SYNC_INTERVAL_MS) }), true);
  assert.equal(shouldSyncOnPayoutsPage({ ...base, returnedFromStripe: true, syncedAt: at(PAYOUTS_RETURN_SYNC_INTERVAL_MS - 1) }), false);
  assert.equal(shouldSyncOnPayoutsPage({ ...base, returnedFromStripe: true, syncedAt: at(PAYOUTS_RETURN_SYNC_INTERVAL_MS) }), true);
  assert.equal(shouldSyncOnPayoutsPage({ ...base, syncedAt: "garbage" }), true);
});

test("rollout incomplete (no Accounts v2 event destination): a READY host is re-checked every 15 minutes", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const ready = { hasAccount: true, payoutsReady: true, syncedAt: at(0) as string | null, returnedFromStripe: false, accountEventsConfigured: false, nowMs: now };
  assert.equal(PAYOUTS_READY_RECHECK_INTERVAL_MS, 15 * 60_000);
  assert.equal(shouldSyncOnPayoutsPage({ ...ready, syncedAt: at(PAYOUTS_READY_RECHECK_INTERVAL_MS - 1) }), false);
  assert.equal(shouldSyncOnPayoutsPage({ ...ready, syncedAt: at(PAYOUTS_READY_RECHECK_INTERVAL_MS) }), true);
  assert.equal(shouldSyncOnPayoutsPage({ ...ready, returnedFromStripe: true, syncedAt: at(PAYOUTS_RETURN_SYNC_INTERVAL_MS) }), false, "ready: the slow interval applies");
  assert.equal(shouldSyncOnPayoutsPage({ ...ready, syncedAt: null }), true);
  // A not-ready host keeps the faster intervals either way.
  assert.equal(shouldSyncOnPayoutsPage({ ...ready, payoutsReady: false, syncedAt: at(PAYOUTS_PAGE_SYNC_INTERVAL_MS) }), true);
});

test("the Ready message describes capability readiness, never that every detail was verified", () => {
  const ready = getHostPayoutSummary({ provider_id: "p", stripe_account_id: ACCOUNT, payouts_ready: true, details_submitted: true, requirements_due: 0, disabled_reason: null });
  assert.deepEqual(ready, {
    state: "ready",
    label: "Ready",
    description: "Stripe has enabled your account to receive payments. Guests can pay for the bookings you accept.",
  });
  assert.doesNotMatch(ready.description, /confirmed|verified/i);
  assert.doesNotMatch(read("src", "lib", "payments", "host-payouts.ts"), /confirmed your details/);
  // The other states are unchanged.
  const base = { provider_id: "p", stripe_account_id: ACCOUNT, payouts_ready: false, details_submitted: true, requirements_due: 0, disabled_reason: null };
  assert.equal(getHostPayoutSummary(base).state, "in_progress");
  assert.equal(getHostPayoutSummary({ ...base, requirements_due: 1 }).state, "action_needed");
  assert.equal(getHostPayoutSummary({ ...base, disabled_reason: "felyn_account_closed" }).state, "action_needed");
  assert.equal(getHostPayoutSummary({ ...base, stripe_account_id: null }).state, "not_started");
  assert.equal(getHostPayoutSummary(null).state, "not_host");
});

test("D5: the failure cooldown blocks retries for its period, then allows one; it stays bounded in size", () => {
  const cooldown = createFailureCooldown(1000, 2);
  assert.equal(cooldown.blocked("a", 0), false, "the first attempt is allowed");
  cooldown.fail("a", 0);
  assert.equal(cooldown.blocked("a", 999), true);
  assert.equal(cooldown.blocked("a", 1000), false, "a later retry is possible");
  cooldown.fail("a", 1000);
  cooldown.clear("a");
  assert.equal(cooldown.blocked("a", 1001), false, "a success clears it");
  cooldown.fail("b", 0);
  cooldown.fail("c", 0);
  cooldown.fail("d", 0);
  assert.equal(cooldown.blocked("b", 1), false, "the oldest entry is dropped beyond the size limit");
  assert.equal(cooldown.blocked("d", 1), true);
});

// ── 0038, statically (it also runs on real PostgreSQL outside the repo) ──

test("0038: one service_role-only function, test mode, never backwards, no money movement", () => {
  assert.ok(migration.includes("create function public.stripe_sync_host_account("));
  assert.ok(migration.includes("returns text language plpgsql security definer set search_path = '' as $fn$"));
  assert.ok(migration.includes("from public, anon, authenticated, service_role;"));
  assert.match(migration, /grant execute on function public\.stripe_sync_host_account\([^)]*\)\s+to service_role;/);
  assert.ok(migration.includes("if v_acct.stripe_synced_at is not null and v_acct.stripe_synced_at > p_fetched_at then\n      return 'stale';"));
  assert.ok(migration.includes("for update;"));
  assert.ok(migration.includes("return 'unknown_account';"));
  assert.ok(migration.includes("raise exception '0038 ABORTED: the database is not pinned to Stripe test mode';"));
  assert.doesNotMatch(migration, /payouts_ready\s*=|insert into|delete from|transfer_released|stripe_transfer_id|booking_payments/);
  // 0036's readiness formula is unchanged.
  assert.ok(read("supabase", "migrations", "0036_stripe_payments.sql").includes(
    "details_submitted and payouts_enabled and transfers_capability = 'active'\n      and disabled_reason is null and cardinality(requirements_past_due) = 0",
  ));
});
