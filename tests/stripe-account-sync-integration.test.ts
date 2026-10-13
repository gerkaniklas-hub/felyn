/**
 * The Accounts v2 sync's real orchestration code — syncHostPayoutAccount,
 * respondToAccountEvent and syncHostPayoutAccountOnPageView — with only the network
 * mocked: globalThis.fetch answers both Stripe (api.stripe.com) and Supabase's PostgREST
 * (the RPC is a POST to /rest/v1/rpc/<name>). This checks the actual request URLs and
 * headers, the RPC name and parameters, response parsing, error handling and the page's
 * cooldown. It proves nothing about Stripe's real responses or the restricted key's
 * permissions: those need the sandbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { respondToAccountEvent } from "../src/lib/payments/account-events-route";
import { syncHostPayoutAccount, syncHostPayoutAccountOnPageView } from "../src/lib/payments/account-sync-server";
import { STRIPE_V2_API_VERSION } from "../src/lib/payments/stripe-api";
import { signStripePayloadForTest } from "../src/lib/payments/webhook-signature";

// Fake values in the right shape; not real keys, secrets or accounts.
const KEY = "rk_test_FAKEKEY000000000000";
const EVENTS_SECRET = "whsec_FAKEACCOUNTS00000000000";
const SUPABASE_URL = "https://felyn-test.supabase.co";
const SUPABASE_KEY = "sb_secret_FAKE0000000000000000";
const ENV: Record<string, string> = {
  PAYMENTS_ENABLED: "true",
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: KEY,
  STRIPE_WEBHOOK_SECRET: "whsec_FAKEPLATFORM000000000",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_FAKECONNECT0000000000",
  STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET: EVENTS_SECRET,
  PAYMENTS_APP_URL: "https://app.felyn.eu",
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SECRET_KEY: SUPABASE_KEY,
};

type Call = { url: string; method: string; headers: Headers; body: string | null };
let calls: Call[] = [];
let logs: string[] = [];
let stripeReply: (url: string) => Response = () => json(200, verifiedAccount("acct_1Default"));
let rpcReply: (body: Record<string, unknown>) => Response = () => json(200, "synced");

function json(status: number, value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function verifiedAccount(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    object: "v2.core.account",
    livemode: false,
    closed: false,
    applied_configurations: ["recipient"],
    configuration: {
      recipient: {
        applied: true,
        capabilities: { stripe_balance: { stripe_transfers: { status: "active", status_details: [] }, payouts: { status: "active", status_details: [] } } },
      },
    },
    requirements: { entries: [], summary: null },
    ...over,
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  calls = [];
  logs = [];
  stripeReply = (url) => json(200, verifiedAccount(decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")));
  rpcReply = () => json(200, "synced");
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    if (url.startsWith("https://api.stripe.com/")) return stripeReply(url);
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) return rpcReply(JSON.parse(body ?? "{}"));
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
});

const stripeCalls = () => calls.filter((c) => c.url.startsWith("https://api.stripe.com/"));
const rpcCalls = () => calls.filter((c) => c.url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`));
const noSecretsLogged = () => {
  for (const line of logs) assert.doesNotMatch(line, /rk_test_|sb_secret_|whsec_|@/, line);
};

// ── syncHostPayoutAccount ──

test("sync: GET /v2/core/accounts/{id} with indexed includes, the pinned version and the key; then the 0038 RPC", async () => {
  const before = Date.now();
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Sync"), "synced");
  const [stripe] = stripeCalls();
  assert.equal(stripe.url, "https://api.stripe.com/v2/core/accounts/acct_1Sync?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements");
  assert.deepEqual([...new URL(stripe.url).searchParams.entries()], [["include[0]", "configuration.recipient"], ["include[1]", "requirements"]]);
  assert.equal(stripe.method, "GET");
  assert.equal(stripe.body, null);
  assert.equal(stripe.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(stripe.headers.get("stripe-version"), STRIPE_V2_API_VERSION);
  assert.equal(STRIPE_V2_API_VERSION, "2025-12-15.clover");

  const [rpc] = rpcCalls();
  assert.equal(rpc.url, `${SUPABASE_URL}/rest/v1/rpc/stripe_sync_host_account`);
  assert.equal(rpc.method, "POST");
  assert.equal(rpc.headers.get("apikey"), SUPABASE_KEY);
  const params = JSON.parse(rpc.body ?? "{}");
  const fetchedAt = Date.parse(params.p_fetched_at);
  assert.ok(fetchedAt >= before - 1 && fetchedAt <= Date.now(), "the read time is taken before the fetch");
  delete params.p_fetched_at;
  assert.deepEqual(params, {
    p_account_id: "acct_1Sync",
    p_details_submitted: true,
    p_payouts_enabled: true,
    p_transfers_capability: "active",
    p_requirements_currently_due: [],
    p_requirements_past_due: [],
    p_disabled_reason: null,
  });
  assert.ok(stripeCalls().length === 1 && calls.indexOf(stripe) < calls.indexOf(rpc), "Stripe first, then the database");
});

test("sync: the real sandbox response (sanitized fixture), fetched with an rk_test_ key, is recorded as Ready", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "stripe-v2-account-recipient-eventually-due.json"), "utf8"));
  stripeReply = () => json(200, fixture);
  assert.match(KEY, /^rk_test_/);
  assert.equal(await syncHostPayoutAccount(KEY, fixture.id), "synced");
  const [stripe] = stripeCalls();
  assert.equal(stripe.url, `https://api.stripe.com/v2/core/accounts/${fixture.id}?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements`);
  assert.equal(stripe.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(stripe.headers.get("stripe-version"), "2025-12-15.clover");
  const params = JSON.parse(rpcCalls()[0].body ?? "{}");
  delete params.p_fetched_at;
  assert.deepEqual(params, {
    p_account_id: fixture.id,
    p_details_submitted: true,
    p_payouts_enabled: true,
    p_transfers_capability: "active",
    p_requirements_currently_due: [],
    p_requirements_past_due: [],
    p_disabled_reason: null,
  });
  noSecretsLogged();
});

test("sync: outstanding requirements are sent as not submitted, with Stripe's descriptions", async () => {
  stripeReply = () => json(200, verifiedAccount("acct_1Due", {
    requirements: { entries: [{ description: "individual.first_name", awaiting_action_from: "user", minimum_deadline: { status: "currently_due" } }] },
  }));
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Due"), "synced");
  const params = JSON.parse(rpcCalls()[0].body ?? "{}");
  assert.equal(params.p_details_submitted, false);
  assert.deepEqual(params.p_requirements_currently_due, ["individual.first_name"]);
});

test("sync: Stripe errors are logged by status, type, code and request id, and nothing is recorded", async () => {
  stripeReply = () => json(403, { error: { type: "invalid_request_error", code: "secret_key_required", message: "The provided key 'rk_test_FAKE…' does not have the required permissions" } }, { "request-id": "req_abc123" });
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Forbidden"), "stripe_unavailable");
  assert.equal(rpcCalls().length, 0);
  assert.ok(logs.some((l) => l.includes("status 403, type invalid_request_error, code secret_key_required, request req_abc123")), logs.join("\n"));
  assert.ok(!logs.some((l) => l.includes("does not have")), "Stripe's message is never logged");
  noSecretsLogged();

  stripeReply = () => json(404, { error: { type: "invalid_request_error", code: "not_found" } });
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Missing"), "stripe_not_found");
  stripeReply = () => {
    throw new TypeError("network down");
  };
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Offline"), "stripe_unavailable");
  stripeReply = () => new Response("<html>bad gateway</html>", { status: 502 });
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Gateway"), "stripe_unavailable");
  assert.equal(rpcCalls().length, 0);
});

test("sync: an unexpected account (missing livemode or requirements, other id, live) is refused before the database", async () => {
  const bad = [
    verifiedAccount("acct_1Bad", { livemode: undefined }),
    verifiedAccount("acct_1Bad", { livemode: true }),
    verifiedAccount("acct_1Other"),
    { ...verifiedAccount("acct_1Bad"), requirements: undefined },
  ];
  for (const body of bad) {
    stripeReply = () => json(200, body);
    assert.equal(await syncHostPayoutAccount(KEY, "acct_1Bad"), "invalid_account", JSON.stringify(body).slice(0, 80));
  }
  assert.equal(rpcCalls().length, 0);
  noSecretsLogged();
});

test("sync: the database's answers and failures", async () => {
  for (const answer of ["stale", "unknown_account"] as const) {
    rpcReply = () => json(200, answer);
    assert.equal(await syncHostPayoutAccount(KEY, "acct_1Db"), answer);
  }
  rpcReply = () => json(404, { code: "PGRST202", message: "Could not find the function public.stripe_sync_host_account" });
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Db"), "database_unavailable", "0038 not applied");
  assert.ok(logs.some((l) => l.includes("database code PGRST202")));
  rpcReply = () => json(200, "something else");
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Db"), "database_unavailable");
  rpcReply = () => {
    throw new TypeError("supabase down");
  };
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Db"), "database_unavailable");
  delete process.env.SUPABASE_SECRET_KEY;
  calls = [];
  assert.equal(await syncHostPayoutAccount(KEY, "acct_1Db"), "database_unavailable");
  assert.equal(calls.length, 0, "no Stripe call without a database to record it");
  noSecretsLogged();
});

// ── respondToAccountEvent (the real route wiring) ──

function eventRequest(over: Record<string, unknown> = {}, secret = EVENTS_SECRET) {
  const event = {
    id: "evt_test_1",
    object: "v2.core.event",
    type: "v2.core.account[requirements].updated",
    livemode: false,
    created: "2026-10-13T12:00:00.000Z",
    context: null,
    related_object: { id: "acct_1Event", type: "v2.core.account", url: "/v2/core/accounts/acct_1Event" },
    ...over,
  };
  const raw = new TextEncoder().encode(JSON.stringify(event));
  const header = signStripePayloadForTest(raw, secret, Math.floor(Date.now() / 1000));
  return new Request("https://app.felyn.eu/api/stripe/account-events", { method: "POST", body: raw, headers: { "stripe-signature": header } });
}

test("route: a signed Accounts v2 event syncs the related account (200)", async () => {
  const response = await respondToAccountEvent(eventRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(stripeCalls()[0].url.split("?")[0], "https://api.stripe.com/v2/core/accounts/acct_1Event");
  assert.equal(JSON.parse(rpcCalls()[0].body ?? "{}").p_account_id, "acct_1Event");
});

test("route: 404 when payments are off or the destination's secret isn't set; nothing is fetched", async () => {
  process.env.PAYMENTS_ENABLED = "false";
  assert.equal((await respondToAccountEvent(eventRequest())).status, 404);
  process.env.PAYMENTS_ENABLED = "true";
  delete process.env.STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET;
  assert.equal((await respondToAccountEvent(eventRequest())).status, 404);
  assert.equal(calls.length, 0);
});

test("route: a wrong signature or a live event is refused before any fetch; Stripe down → 500", async () => {
  assert.equal((await respondToAccountEvent(eventRequest({}, "whsec_SOMEOTHERSECRET0000000"))).status, 400);
  assert.equal((await respondToAccountEvent(eventRequest({ livemode: true }))).status, 400);
  assert.equal(calls.length, 0);
  stripeReply = () => json(503, { error: { type: "api_error" } });
  const response = await respondToAccountEvent(eventRequest());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { received: false, error: "unavailable" });
  assert.equal(rpcCalls().length, 0);
  noSecretsLogged();
});

// ── syncHostPayoutAccountOnPageView ──

const row = (id: string, over: Record<string, unknown> = {}) => ({ stripe_account_id: id, payouts_ready: false, stripe_synced_at: null, ...over });

test("page: syncs a not-ready host's own account and asks the page to read it again", async () => {
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Page"), true), true);
  assert.equal(stripeCalls().length, 1);
  assert.equal(rpcCalls().length, 1);
});

test("page: no Stripe call when ready, without an account, recently synced, or with payments off", async () => {
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Ready", { payouts_ready: true }), true), false);
  assert.equal(await syncHostPayoutAccountOnPageView(null, true), false);
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Recent", { stripe_synced_at: new Date().toISOString() }), false), false);
  process.env.PAYMENTS_ENABLED = "false";
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Off"), true), false);
  assert.equal(calls.length, 0);
});

test("page: a READY host is re-checked every 15 minutes only while the Accounts v2 destination isn't configured", async () => {
  const t0 = Date.UTC(2026, 9, 13, 12, 0, 0);
  const syncedLongAgo = new Date(t0 - 16 * 60_000).toISOString();
  const syncedRecently = new Date(t0 - 14 * 60_000).toISOString();
  // Configured (secret set in ENV): events keep a ready host current; no Stripe call.
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1ReadyCfg", { payouts_ready: true, stripe_synced_at: syncedLongAgo }), false, t0), false);
  assert.equal(calls.length, 0);
  // Not configured: re-checked after 15 minutes, not before.
  delete process.env.STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET;
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1ReadyNoCfg", { payouts_ready: true, stripe_synced_at: syncedRecently }), false, t0), false);
  assert.equal(calls.length, 0);
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1ReadyNoCfg", { payouts_ready: true, stripe_synced_at: syncedLongAgo }), false, t0), true);
  assert.equal(stripeCalls().length, 1);
  assert.equal(rpcCalls().length, 1);
});

test("page (D5): after a failure, views within the cooldown make no Stripe call; a later one retries", async () => {
  stripeReply = () => json(403, { error: { type: "invalid_request_error", code: "secret_key_required" } });
  const t0 = Date.UTC(2026, 9, 13, 12, 0, 0);
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Cool"), true, t0), false, "the first attempt happens");
  assert.equal(stripeCalls().length, 1);
  for (const later of [1_000, 60_000, 299_999]) {
    assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Cool"), true, t0 + later), false);
  }
  assert.equal(stripeCalls().length, 1, "throttled: no further Stripe calls inside 5 minutes");
  assert.equal(rpcCalls().length, 0, "a failure never records a sync time");
  stripeReply = (url) => json(200, verifiedAccount(decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")));
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1Cool"), true, t0 + 300_000), true, "retried after the cooldown");
  assert.equal(stripeCalls().length, 2);
  // Database failures (e.g. 0038 not applied) are throttled the same way.
  rpcReply = () => json(404, { code: "PGRST202" });
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1CoolDb"), false, t0), false);
  assert.equal(await syncHostPayoutAccountOnPageView(row("acct_1CoolDb"), false, t0 + 1_000), false);
  assert.equal(stripeCalls().filter((c) => c.url.includes("acct_1CoolDb")).length, 1);
});

test("page: concurrent views of the same account share one Stripe call", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Stripe answers only after both page views have started.
  globalThis.fetch = ((original) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.stripe.com/")) await gate;
    return original(input, init);
  }) as typeof fetch)(globalThis.fetch);
  const views = [syncHostPayoutAccountOnPageView(row("acct_1Twice"), true), syncHostPayoutAccountOnPageView(row("acct_1Twice"), true)];
  release();
  assert.deepEqual(await Promise.all(views), [true, true]);
  assert.equal(stripeCalls().length, 1);
  assert.equal(rpcCalls().length, 1);
});
