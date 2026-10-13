/**
 * The Accounts v2 event destination's secret (STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET) is
 * required to COMPLETE the rollout, but must not switch payments off on deploy before the
 * destination exists. Runs in its own process: getServerPayments warns once per process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readPaymentsConfig } from "../src/lib/payments/config";
import { getServerPayments } from "../src/lib/payments/server";

// Fake values in the right shape; not real keys.
const PRODUCTION_SHAPE = {
  // The variables production has today (names only; values are fakes): no account-events secret yet.
  PAYMENTS_ENABLED: "true",
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "rk_test_FAKE0000000000000000",
  STRIPE_WEBHOOK_SECRET: "whsec_FAKEPLATFORM000000000",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_FAKECONNECT0000000000",
  PAYMENTS_APP_URL: "https://app.felyn.eu",
  NEXT_PUBLIC_SUPABASE_URL: "https://felyn-test.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_FAKE0000000000000000",
};
const SECRETS = /rk_test_|sb_secret_|whsec_/;

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(PAYMENTS_|STRIPE_|SUPABASE_|NEXT_PUBLIC_SUPABASE_)/.test(key)) delete process.env[key];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

function capture(fn: () => void) {
  const lines: { level: string; text: string }[] = [];
  const { warn, error } = console;
  console.warn = (...a: unknown[]) => lines.push({ level: "warn", text: a.map(String).join(" ") });
  console.error = (...a: unknown[]) => lines.push({ level: "error", text: a.map(String).join(" ") });
  try {
    fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}

test("absent secret (production today): payments stay enabled, the endpoint is off, and the server warns once that the rollout is incomplete", () => {
  withEnv(PRODUCTION_SHAPE, () => {
    const lines = capture(() => {
      const first = getServerPayments();
      assert.ok(first.enabled, "deploying this must not switch payments off");
      assert.equal(first.enabled && first.config.accountEventsWebhookSecret, null);
      assert.ok(getServerPayments().enabled);
    });
    assert.equal(lines.length, 1, "warned once per server instance");
    assert.equal(lines[0].level, "warn");
    assert.match(lines[0].text, /rollout incomplete — STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET is not set/);
    assert.doesNotMatch(lines[0].text, SECRETS);
  });
});

test("malformed secret: the configuration is refused like any other malformed secret (named, never echoed)", () => {
  for (const bad of ["whsec_short", "not_a_secret_at_all", PRODUCTION_SHAPE.STRIPE_WEBHOOK_SECRET, PRODUCTION_SHAPE.STRIPE_CONNECT_WEBHOOK_SECRET]) {
    withEnv({ ...PRODUCTION_SHAPE, STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET: bad }, () => {
      const lines = capture(() => assert.deepEqual(getServerPayments(), { enabled: false, reason: "misconfigured" }));
      assert.equal(lines.length, 1);
      assert.match(lines[0].text, /payments: configuration error — STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET/);
      assert.ok(!lines[0].text.includes(bad), "the value is never logged");
    });
  }
});

test("valid secret: enabled, the endpoint's secret is available, and no warning", () => {
  withEnv({ ...PRODUCTION_SHAPE, STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET: "whsec_FAKEACCOUNTS00000000000" }, () => {
    const lines = capture(() => {
      const payments = getServerPayments();
      assert.ok(payments.enabled && payments.config.accountEventsWebhookSecret === "whsec_FAKEACCOUNTS00000000000");
    });
    assert.deepEqual(lines, []);
  });
});

test("test-mode protections are unchanged with the new secret set", () => {
  const withSecret = { ...PRODUCTION_SHAPE, STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET: "whsec_FAKEACCOUNTS00000000000" };
  for (const env of [
    { ...withSecret, STRIPE_MODE: "live" },
    { ...withSecret, STRIPE_SECRET_KEY: "rk_live_FAKE0000000000000000" },
    { ...withSecret, STRIPE_SECRET_KEY: "sk_live_FAKE0000000000000000" },
  ]) {
    const result = readPaymentsConfig(env);
    assert.equal(result.ok, false, JSON.stringify({ mode: env.STRIPE_MODE }));
  }
  assert.deepEqual(readPaymentsConfig({ ...withSecret, PAYMENTS_ENABLED: "false" }), { ok: true, config: null }, "the switch still turns everything off");
  withEnv({ ...withSecret, PAYMENTS_ENABLED: "false" }, () => assert.deepEqual(getServerPayments(), { enabled: false, reason: "disabled" }));
});

test("no production configuration is changed by this code: .env.example documents the variable without a value", () => {
  const example = readFileSync(path.resolve(import.meta.dirname, "..", ".env.example"), "utf8");
  assert.match(example, /^STRIPE_ACCOUNT_EVENTS_WEBHOOK_SECRET=$/m);
  assert.doesNotMatch(example, /whsec_[A-Za-z0-9]{10,}|rk_test_[A-Za-z0-9]{10,}|sk_test_[A-Za-z0-9]{10,}/);
});
