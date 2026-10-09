import assert from "node:assert/strict";
import { test } from "node:test";
import { readPaymentsConfig } from "../src/lib/payments/config";

// Fake values in the right shape; not real keys.
const TEST_ENV = {
  PAYMENTS_ENABLED: "true",
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "rk_test_FAKE0000000000000000",
  STRIPE_WEBHOOK_SECRET: "whsec_FAKEPLATFORM000000000",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_FAKECONNECT0000000000",
  PAYMENTS_APP_URL: "http://localhost:3000",
};

function expectError(env: Record<string, string | undefined>, fragment: string) {
  const result = readPaymentsConfig(env);
  assert.equal(result.ok, false, JSON.stringify(env));
  if (!result.ok) {
    assert.ok(result.error.includes(fragment), result.error);
    // never echo a secret back
    for (const value of [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET]) {
      if (value) assert.ok(!result.error.includes(value), "error leaks a secret");
    }
  }
}

test("payments are off unless explicitly enabled", () => {
  assert.deepEqual(readPaymentsConfig({}), { ok: true, config: null });
  assert.deepEqual(readPaymentsConfig({ PAYMENTS_ENABLED: "false", STRIPE_SECRET_KEY: "garbage" }), { ok: true, config: null });
  expectError({ PAYMENTS_ENABLED: "yes" }, "PAYMENTS_ENABLED");
});

test("a complete test-mode configuration", () => {
  assert.deepEqual(readPaymentsConfig({ ...TEST_ENV, PAYMENTS_APP_URL: "http://localhost:3000/" }), {
    ok: true,
    config: {
      mode: "test",
      secretKey: TEST_ENV.STRIPE_SECRET_KEY,
      webhookSecret: TEST_ENV.STRIPE_WEBHOOK_SECRET,
      connectWebhookSecret: TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET,
      appUrl: "http://localhost:3000",
    },
  });
});

test("missing required values are reported by name", () => {
  for (const name of ["STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET", "PAYMENTS_APP_URL"]) {
    expectError({ ...TEST_ENV, [name]: undefined }, name);
    expectError({ ...TEST_ENV, [name]: "   " }, name);
  }
});

test("the key must match the mode: no live key in test mode and vice versa", () => {
  expectError({ ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_FAKE0000000000000000" }, "test-mode");
  expectError(
    { ...TEST_ENV, STRIPE_MODE: "live", PAYMENTS_APP_URL: "https://app.felyn.eu" },
    "live-mode",
  );
  expectError({ ...TEST_ENV, STRIPE_MODE: "production" }, "STRIPE_MODE");
});

test("malformed keys and secrets are rejected", () => {
  expectError({ ...TEST_ENV, STRIPE_SECRET_KEY: "pk_test_FAKE0000000000000000" }, "STRIPE_SECRET_KEY"); // a publishable key
  expectError({ ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test_" }, "STRIPE_SECRET_KEY");
  expectError({ ...TEST_ENV, STRIPE_WEBHOOK_SECRET: "secret_FAKE000000000000" }, "STRIPE_WEBHOOK_SECRET");
  expectError({ ...TEST_ENV, STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_short" }, "STRIPE_CONNECT_WEBHOOK_SECRET");
  expectError({ ...TEST_ENV, STRIPE_CONNECT_WEBHOOK_SECRET: TEST_ENV.STRIPE_WEBHOOK_SECRET }, "must differ");
});

test("live mode requires an https app origin", () => {
  const live = { ...TEST_ENV, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_live_FAKE0000000000000000" };
  expectError({ ...live, PAYMENTS_APP_URL: "http://app.felyn.eu" }, "https");
  const ok = readPaymentsConfig({ ...live, PAYMENTS_APP_URL: "https://app.felyn.eu" });
  assert.ok(ok.ok && ok.config?.mode === "live" && ok.config.appUrl === "https://app.felyn.eu");
  for (const bad of ["https://app.felyn.eu/pay", "https://user:pw@app.felyn.eu", "https://app.felyn.eu?x=1", "not a url", "ftp://app.felyn.eu"]) {
    expectError({ ...live, PAYMENTS_APP_URL: bad }, "PAYMENTS_APP_URL");
  }
});

test("reading the config never changes the environment object", () => {
  const env = { ...TEST_ENV };
  readPaymentsConfig(env);
  assert.deepEqual(env, TEST_ENV);
});
