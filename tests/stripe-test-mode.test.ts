import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildAccountLinkParams,
  buildCheckoutSessionParams,
  buildExpressAccountParams,
  checkAttemptAmounts,
  encodeStripeForm,
  isStripeCheckoutUrl,
  isStripeConnectUrl,
  isTestCheckoutSessionId,
  parsePaymentStart,
  type PaymentStartCreated,
} from "../src/lib/payments/checkout";
import { getHostPayoutSummary } from "../src/lib/payments/host-payouts";
import { getGuestPaymentPanel } from "../src/lib/payments/lifecycle";
import { getPaymentStartErrorMessage, getPaymentStartMessage } from "../src/lib/payments/messages";
import { cancelAuthorization, captureAuthorizedPayment, type IntentApi } from "../src/lib/payments/stripe-intents";
import { getCheckoutWindow, MIN_TIME_TO_START_CHECKOUT_MS, CHECKOUT_EXPIRY_BEFORE_DUE_MS } from "../src/lib/payments/timing";
import { handleStripeWebhook, MAX_WEBHOOK_BODY_BYTES, type ApplyEventResult, type WebhookDeps } from "../src/lib/payments/webhook";
import { signStripePayloadForTest, verifyStripeSignature } from "../src/lib/payments/webhook-signature";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = read("supabase", "migrations", "0037_stripe_test_mode.sql");

// Fake values in the right shape; not real secrets.
const SECRET = "whsec_FAKEPLATFORM000000000";
const NOW = 1_800_000_000;
const MINUTE = 60_000;
const body = (event: object) => new TextEncoder().encode(JSON.stringify(event));
const testEvent = { id: "evt_test1", type: "checkout.session.completed", livemode: false, created: NOW, data: { object: {} } };

// ── webhook signatures (the route's check) ──

test("signature: Stripe's v1 scheme over the exact raw bytes", () => {
  const raw = body(testEvent);
  const header = signStripePayloadForTest(raw, SECRET, NOW);
  assert.deepEqual(verifyStripeSignature(raw, header, [SECRET], NOW), { ok: true, timestamp: NOW });
  // One byte more (even whitespace) is a different body.
  const tampered = new Uint8Array([...raw, 0x20]);
  assert.deepEqual(verifyStripeSignature(tampered, header, [SECRET], NOW), { ok: false, error: "invalid_signature" });
  assert.deepEqual(verifyStripeSignature(raw, header, ["whsec_OTHER0000000000000"], NOW), { ok: false, error: "invalid_signature" });
});

test("signature: 300 seconds of tolerance either way, not 301", () => {
  const raw = body(testEvent);
  const header = signStripePayloadForTest(raw, SECRET, NOW);
  assert.equal(verifyStripeSignature(raw, header, [SECRET], NOW + 300).ok, true);
  assert.equal(verifyStripeSignature(raw, header, [SECRET], NOW - 300).ok, true);
  assert.deepEqual(verifyStripeSignature(raw, header, [SECRET], NOW + 301), { ok: false, error: "stale_timestamp" });
  assert.deepEqual(verifyStripeSignature(raw, header, [SECRET], NOW - 301), { ok: false, error: "stale_timestamp" });
});

test("signature: rotation (any secret, any v1), v0 never counts, malformed headers refused", () => {
  const raw = body(testEvent);
  const good = signStripePayloadForTest(raw, SECRET, NOW).split("v1=")[1];
  const other = signStripePayloadForTest(raw, "whsec_OTHER0000000000000", NOW).split("v1=")[1];
  assert.equal(verifyStripeSignature(raw, `t=${NOW},v1=${other},v1=${good}`, [SECRET], NOW).ok, true);
  assert.equal(verifyStripeSignature(raw, `t=${NOW},v1=${other}`, ["whsec_OTHER0000000000000", SECRET], NOW).ok, true);
  for (const header of [
    null,
    "",
    `t=${NOW},v0=${good}`,
    `v1=${good}`,
    `t=${NOW}`,
    `t=abc,v1=${good}`,
    `t=${NOW},t=${NOW},v1=${good}`,
    `t=${NOW},v1=${good.toUpperCase()}`,
    `t=${NOW},v1=${good.slice(1)}`,
    `t=${NOW}` + `,v1=${good}`.repeat(5),
    `t=${NOW},v1=${good},` + "x".repeat(2100),
  ]) {
    assert.deepEqual(verifyStripeSignature(raw, header, [SECRET], NOW), { ok: false, error: "malformed" }, String(header));
  }
});

// ── the webhook route's logic ──

function deps(answer: ApplyEventResult | Error, overrides: Partial<WebhookDeps> = {}) {
  const calls = { apply: [] as Array<[string, string, string]>, capture: [] as string[], cancel: [] as string[], logs: [] as string[] };
  const d: WebhookDeps = {
    secrets: [SECRET],
    nowSeconds: NOW,
    applyEvent: async (endpoint, b64, sig) => {
      calls.apply.push([endpoint, b64, sig]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    capture: async (pi) => (calls.capture.push(pi), true),
    cancel: async (pi) => (calls.cancel.push(pi), true),
    log: (m) => void calls.logs.push(m),
    ...overrides,
  };
  return { d, calls };
}

test("webhook: an unverified request never reaches the database", async () => {
  const raw = body(testEvent);
  for (const header of [null, "t=1,v1=" + "0".repeat(64), signStripePayloadForTest(raw, "whsec_WRONG0000000000000", NOW)]) {
    const { d, calls } = deps({ result: "processed" });
    const res = await handleStripeWebhook("platform", raw, header, d);
    assert.equal(res.status, 400);
    assert.equal(calls.apply.length, 0);
  }
  const stale = deps({ result: "processed" });
  assert.equal((await handleStripeWebhook("platform", raw, signStripePayloadForTest(raw, SECRET, NOW - 400), stale.d)).status, 400);
  assert.equal(stale.calls.apply.length, 0);
});

test("webhook: test mode only — a live (or unmarked) event is refused before the database", async () => {
  for (const event of [{ ...testEvent, livemode: true }, { ...testEvent, livemode: undefined }]) {
    const raw = body(event);
    const { d, calls } = deps({ result: "processed" });
    const res = await handleStripeWebhook("platform", raw, signStripePayloadForTest(raw, SECRET, NOW), d);
    assert.equal(res.status, 400);
    assert.equal(calls.apply.length, 0);
  }
});

test("webhook: the database gets the exact raw bytes (base64) and the header", async () => {
  const raw = new TextEncoder().encode(`{"id":"evt_test1",  "livemode":false, "note":"café"}`);
  const header = signStripePayloadForTest(raw, SECRET, NOW);
  const { d, calls } = deps({ result: "processed" });
  assert.equal((await handleStripeWebhook("platform", raw, header, d)).status, 200);
  assert.deepEqual(calls.apply, [["platform", Buffer.from(raw).toString("base64"), header]]);
  assert.deepEqual(Buffer.from(calls.apply[0][1], "base64"), Buffer.from(raw));
});

test("webhook: capture / cancel only when the database says so, 500 if the Stripe call fails", async () => {
  const raw = body(testEvent);
  const header = signStripePayloadForTest(raw, SECRET, NOW);
  const cap = deps({ result: "processed", action: "capture", payment_intent_id: "pi_test123" });
  assert.equal((await handleStripeWebhook("platform", raw, header, cap.d)).status, 200);
  assert.deepEqual(cap.calls.capture, ["pi_test123"]);
  assert.deepEqual(cap.calls.cancel, []);

  const dup = deps({ result: "duplicate", action: "cancel_authorization", payment_intent_id: "pi_test123" });
  assert.equal((await handleStripeWebhook("platform", raw, header, dup.d)).status, 200);
  assert.deepEqual(dup.calls.cancel, ["pi_test123"]);

  const plain = deps({ result: "duplicate" });
  assert.equal((await handleStripeWebhook("platform", raw, header, plain.d)).status, 200);
  assert.deepEqual([plain.calls.capture, plain.calls.cancel], [[], []]);

  const failing = deps({ result: "processed", action: "capture", payment_intent_id: "pi_test123" }, { capture: async () => false });
  assert.equal((await handleStripeWebhook("platform", raw, header, failing.d)).status, 500, "Stripe must redeliver");

  const badPi = deps({ result: "processed", action: "capture", payment_intent_id: "not_a_pi" });
  assert.equal((await handleStripeWebhook("platform", raw, header, badPi.d)).status, 500);
  assert.deepEqual(badPi.calls.capture, []);
});

test("webhook: database answers map to the right HTTP status; nothing secret is returned", async () => {
  const raw = body(testEvent);
  const header = signStripePayloadForTest(raw, SECRET, NOW);
  const expected: Record<string, number> = {
    processed: 200, ignored: 200, duplicate: 200,
    invalid_signature: 500, not_configured: 500, something_new: 500,
    stale_timestamp: 400, wrong_mode: 400, wrong_endpoint: 400, malformed: 400, payload_mismatch: 400,
  };
  for (const [result, status] of Object.entries(expected)) {
    const { d } = deps({ result });
    const res = await handleStripeWebhook("platform", raw, header, d);
    assert.equal(res.status, status, result);
    assert.ok(!JSON.stringify(res.body).includes(SECRET) && !JSON.stringify(res.body).includes(header));
  }
  const down = deps(new Error("connection refused"));
  assert.equal((await handleStripeWebhook("platform", raw, header, down.d)).status, 500);
  const big = deps({ result: "processed" });
  assert.equal((await handleStripeWebhook("platform", new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1), header, big.d)).status, 413);
});

// ── Checkout: amounts, parameters, timing ──

const attempt: PaymentStartCreated = {
  result: "created",
  paymentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  livemode: false,
  currency: "EUR",
  pricePerPersonCents: 4005,
  guestCount: 2,
  grossCents: 8010,
  platformFeeCents: 801,
  paymentDueAtMs: Date.UTC(2027, 5, 1, 17, 0),
  experienceTitle: "Sunset dinner",
  transferGroup: "felyn_payment_0f8fad5b-d9cb-469f-a165-70867728950e",
};

test("amounts: the database's attempt must match the app's money rules (10% half up, €5, EUR, test mode)", () => {
  assert.deepEqual(checkAttemptAmounts(attempt), { ok: true });
  assert.deepEqual(checkAttemptAmounts({ ...attempt, platformFeeCents: 800 }), { ok: false, error: "fee_mismatch" });
  assert.deepEqual(checkAttemptAmounts({ ...attempt, grossCents: 8000 }), { ok: false, error: "amount_mismatch" });
  assert.deepEqual(checkAttemptAmounts({ ...attempt, livemode: true }), { ok: false, error: "live_mode" });
  assert.deepEqual(checkAttemptAmounts({ ...attempt, currency: "USD" }), { ok: false, error: "currency" });
  assert.deepEqual(
    checkAttemptAmounts({ ...attempt, pricePerPersonCents: 499, grossCents: 998, platformFeeCents: 100 }),
    { ok: false, error: "below_minimum" },
  );
  assert.deepEqual(checkAttemptAmounts({ ...attempt, transferGroup: "felyn_payment_other" }), { ok: false, error: "transfer_group" });
  // €5.00 x 1 = 500 cents: fee 50 (exact); €10.05 x 1 = 1005: fee 100.5 -> 101 (half up).
  assert.deepEqual(checkAttemptAmounts({ ...attempt, pricePerPersonCents: 500, guestCount: 1, grossCents: 500, platformFeeCents: 50 }), { ok: true });
  assert.deepEqual(checkAttemptAmounts({ ...attempt, pricePerPersonCents: 1005, guestCount: 1, grossCents: 1005, platformFeeCents: 101 }), { ok: true });
});

test("Checkout session: manual capture, card only, EUR, amounts from the attempt, NO transfer or fee to a host", () => {
  const params = buildCheckoutSessionParams({
    attempt,
    bookingItemId: "6a2f41a3-c54c-fce8-32d2-0324e1c32e22",
    expiresAtUnixSeconds: 1_811_000_000,
    appUrl: "https://app.felyn.eu",
    customerEmail: "guest@example.test",
  });
  assert.equal(params.mode, "payment");
  assert.equal(params["payment_intent_data[capture_method]"], "manual");
  assert.equal(params["payment_method_types[0]"], "card");
  assert.equal(params["line_items[0][price_data][currency]"], "eur");
  assert.equal(params["line_items[0][price_data][unit_amount]"], "4005");
  assert.equal(params["line_items[0][quantity]"], "2");
  assert.equal(params["metadata[felyn_payment_id]"], attempt.paymentId);
  assert.equal(params["payment_intent_data[metadata][felyn_payment_id]"], attempt.paymentId);
  assert.equal(params.client_reference_id, attempt.paymentId);
  assert.equal(params["payment_intent_data[transfer_group]"], attempt.transferGroup);
  assert.equal(params.expires_at, "1811000000");
  assert.equal(params.success_url, "https://app.felyn.eu/bookings/6a2f41a3-c54c-fce8-32d2-0324e1c32e22?checkout=success");
  assert.equal(params.cancel_url, "https://app.felyn.eu/bookings/6a2f41a3-c54c-fce8-32d2-0324e1c32e22?checkout=cancelled");
  for (const key of Object.keys(params)) {
    assert.doesNotMatch(key, /transfer_data|application_fee|on_behalf_of|destination|setup_future_usage/, key);
  }
  const noEmail = buildCheckoutSessionParams({ attempt, bookingItemId: "x", expiresAtUnixSeconds: 1, appUrl: "http://localhost:3000", customerEmail: null });
  assert.equal("customer_email" in noEmail, false);
  assert.match(encodeStripeForm({ "a[b]": "x y" }), /^a%5Bb%5D=x\+y$/);
});

test("timing boundaries: Checkout needs 41 minutes; it expires 10 minutes before the deadline", () => {
  const due = Date.UTC(2027, 5, 1, 17, 0);
  assert.equal(MIN_TIME_TO_START_CHECKOUT_MS, 41 * MINUTE);
  const atCutoff = getCheckoutWindow(due - 41 * MINUTE, due);
  assert.ok(atCutoff.ok);
  if (atCutoff.ok) assert.equal(atCutoff.expiresAtMs, due - CHECKOUT_EXPIRY_BEFORE_DUE_MS);
  assert.deepEqual(getCheckoutWindow(due - 41 * MINUTE + 1, due), { ok: false, error: "too_late_to_start_checkout" });
  assert.deepEqual(getCheckoutWindow(due, due), { ok: false, error: "payment_deadline_passed" });
  // The database enforces the same numbers (0036 FB005: 41 minutes; 0037: 10 minutes before the deadline).
  assert.ok(read("supabase", "migrations", "0036_stripe_payments.sql").includes("v_item.payment_due_at - now() < interval '41 minutes'"));
  assert.ok(migration.includes("p_expires_at > v_due - interval '10 minutes'"));
});

test("parsing the database's start answer: only well-formed answers are used", () => {
  const ok = parsePaymentStart({
    result: "created", payment_id: attempt.paymentId, livemode: false, currency: "EUR", price_per_person_cents: 4005,
    guest_count: 2, gross_cents: 8010, platform_fee_cents: 801, payment_due_at: "2027-06-01T17:00:00+00:00",
    experience_title: "Sunset dinner", transfer_group: attempt.transferGroup,
  });
  assert.equal(ok.result, "created");
  assert.deepEqual(parsePaymentStart({ result: "created", payment_id: "x" }), { result: "invalid" });
  assert.deepEqual(parsePaymentStart({ result: "created", payment_id: attempt.paymentId, gross_cents: 1.5 }), { result: "invalid" });
  assert.deepEqual(parsePaymentStart(null), { result: "invalid" });
  assert.deepEqual(parsePaymentStart({ result: "hacked" }), { result: "invalid" });
  assert.deepEqual(parsePaymentStart({ result: "processing" }), { result: "processing" });
  assert.deepEqual(parsePaymentStart({ result: "existing", payment_id: attempt.paymentId, checkout_session_id: "cs_test_1" }), {
    result: "existing", paymentId: attempt.paymentId, checkoutSessionId: "cs_test_1",
  });
});

test("only Stripe's own test-mode ids and https URLs are followed", () => {
  assert.equal(isTestCheckoutSessionId("cs_test_a1B2"), true);
  assert.equal(isTestCheckoutSessionId("cs_live_a1B2"), false);
  assert.equal(isStripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_a1"), true);
  for (const bad of ["http://checkout.stripe.com/x", "https://checkout.stripe.com.evil.test/x", "https://evil.test/checkout.stripe.com", null]) {
    assert.equal(isStripeCheckoutUrl(bad), false, String(bad));
  }
  assert.equal(isStripeConnectUrl("https://connect.stripe.com/setup/e/acct_1/abc"), true);
  assert.equal(isStripeConnectUrl("https://connect.stripe.com.evil.test/"), false);
});

test("host onboarding: an Express account that can receive transfers later; links return to /provider/payouts", () => {
  const account = buildExpressAccountParams({ providerId: "p1", email: "host@example.test" });
  assert.equal(account.type, "express");
  assert.equal(account["capabilities[transfers][requested]"], "true");
  assert.equal(account["metadata[felyn_provider_id]"], "p1");
  const link = buildAccountLinkParams({ accountId: "acct_1", appUrl: "https://app.felyn.eu" });
  assert.equal(link.type, "account_onboarding");
  assert.equal(link.return_url, "https://app.felyn.eu/provider/payouts?onboarding=return");
  assert.equal(link.refresh_url, "https://app.felyn.eu/provider/payouts?onboarding=refresh");
});

// ── what the guest and host see ──

test("guest payment panel: the database decides; a success return never confirms", () => {
  const base = {
    status: "AWAITING_PAYMENT" as const,
    attemptStatus: null,
    checkoutReturn: null,
    paymentsEnabled: true,
    canStartCheckout: true,
    deadlinePassed: false,
  };
  assert.equal(getGuestPaymentPanel(base), "pay");
  assert.equal(getGuestPaymentPanel({ ...base, status: "CONFIRMED" }), "none");
  assert.equal(getGuestPaymentPanel({ ...base, checkoutReturn: "success" }), "pay", "a success URL without any attempt proves nothing");
  assert.equal(getGuestPaymentPanel({ ...base, checkoutReturn: "success", attemptStatus: "open" }), "processing");
  assert.equal(getGuestPaymentPanel({ ...base, attemptStatus: "authorized" }), "processing");
  assert.equal(getGuestPaymentPanel({ ...base, attemptStatus: "captured" }), "processing");
  assert.equal(getGuestPaymentPanel({ ...base, attemptStatus: "unconfirmable" }), "needs_support");
  assert.equal(getGuestPaymentPanel({ ...base, checkoutReturn: "cancelled", attemptStatus: "open" }), "pay_after_cancel");
  assert.equal(getGuestPaymentPanel({ ...base, paymentsEnabled: false }), "unavailable");
  assert.equal(getGuestPaymentPanel({ ...base, canStartCheckout: false }), "too_late");
  assert.equal(getGuestPaymentPanel({ ...base, canStartCheckout: false, attemptStatus: "open" }), "pay", "an open session can be resumed");
  assert.equal(getGuestPaymentPanel({ ...base, canStartCheckout: false, attemptStatus: "expired" }), "too_late");
  // After the deadline, before expiry has run (no schedule): never offer to pay.
  const lapsed = { ...base, canStartCheckout: false, deadlinePassed: true };
  assert.equal(getGuestPaymentPanel(lapsed), "deadline_passed");
  assert.equal(getGuestPaymentPanel({ ...lapsed, attemptStatus: "open" }), "deadline_passed");
  assert.equal(getGuestPaymentPanel({ ...lapsed, paymentsEnabled: false }), "deadline_passed");
  assert.equal(getGuestPaymentPanel({ ...lapsed, attemptStatus: "authorized" }), "processing", "a held payment is still being resolved");
  assert.equal(getGuestPaymentPanel({ ...lapsed, status: "PAYMENT_EXPIRED" }), "none");
});

test("capture and cancel are idempotent; a PaymentIntent Stripe doesn't know is nothing to cancel, never to capture", async () => {
  type R = Awaited<ReturnType<IntentApi["cancelPaymentIntent"]>>;
  const api = (cancel: R, retrieve: R, capture: R = cancel): IntentApi => ({
    capturePaymentIntent: async () => capture,
    cancelPaymentIntent: async () => cancel,
    retrievePaymentIntent: async () => retrieve,
  });
  const ok = (status: string): R => ({ ok: true, data: { status } });
  const err = (status: number, code: string | null): R => ({ ok: false, status, code });
  assert.equal(await cancelAuthorization(api(ok("canceled"), err(500, null)), "pi_1"), true);
  assert.equal(await cancelAuthorization(api(err(400, "payment_intent_unexpected_state"), ok("canceled")), "pi_1"), true);
  assert.equal(await cancelAuthorization(api(err(404, "resource_missing"), err(404, "resource_missing")), "pi_fake"), true);
  assert.equal(await cancelAuthorization(api(err(400, "payment_intent_unexpected_state"), err(404, "resource_missing")), "pi_1"), true);
  assert.equal(await cancelAuthorization(api(err(400, "payment_intent_unexpected_state"), ok("succeeded")), "pi_1"), false, "captured money is never 'cancelled'");
  assert.equal(await cancelAuthorization(api(err(0, "network_error"), err(0, "network_error")), "pi_1"), false);
  assert.equal(await captureAuthorizedPayment(api(err(500, null), ok("succeeded"), ok("succeeded")), "pi_1"), true);
  assert.equal(await captureAuthorizedPayment(api(err(404, "resource_missing"), err(404, "resource_missing"), err(404, "resource_missing")), "pi_x"), false);
  assert.equal(await captureAuthorizedPayment(api(ok("canceled"), ok("canceled"), err(400, "payment_intent_unexpected_state")), "pi_1"), false);
});

test("messages: every database answer and error code has safe wording", () => {
  for (const r of ["not_found", "not_payable", "in_progress", "processing", "needs_support", "invalid"] as const) {
    assert.ok(getPaymentStartMessage(r).length > 10);
  }
  assert.match(getPaymentStartErrorMessage("FB005"), /too close to the payment deadline/);
  assert.match(getPaymentStartErrorMessage("FB006"), /payouts/);
  assert.match(getPaymentStartErrorMessage("FB004"), /€5/);
  assert.match(getPaymentStartErrorMessage("XX000"), /couldn't start the payment/);
});

test("host payout summary follows the synced Stripe state", () => {
  assert.equal(getHostPayoutSummary(null).state, "not_host");
  const row = { provider_id: "p", stripe_account_id: null, payouts_ready: null, details_submitted: null, requirements_due: null, disabled_reason: null };
  assert.equal(getHostPayoutSummary(row).state, "not_started");
  assert.equal(getHostPayoutSummary({ ...row, stripe_account_id: "acct_1", payouts_ready: false, requirements_due: 3 }).state, "action_needed");
  assert.equal(getHostPayoutSummary({ ...row, stripe_account_id: "acct_1", payouts_ready: false, requirements_due: 0 }).state, "in_progress");
  assert.equal(getHostPayoutSummary({ ...row, stripe_account_id: "acct_1", payouts_ready: true, requirements_due: 0 }).state, "ready");
});

// ── guarantees across the code ──

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}
const paymentCode = [...sourceFiles(path.join(root, "src", "lib", "payments")), ...sourceFiles(path.join(root, "src", "app", "api", "stripe"))];

/** Code without block comments and whole-line // comments (explanations may name what the code avoids). */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

test("no host transfers, payouts or refunds: no code calls those Stripe APIs", () => {
  assert.ok(paymentCode.length >= 8);
  for (const file of sourceFiles(path.join(root, "src"))) {
    const code = codeOnly(readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /["'`]\/(transfers|payouts|refunds)\b/, `${file} calls a money-moving Stripe API`);
    assert.doesNotMatch(code, /transfer_data|application_fee_amount/, file);
  }
  // The database side: 0037 never releases or transfers a host share.
  assert.doesNotMatch(migration, /host_transfer_status = '(released|transferred)'/);
  assert.doesNotMatch(migration, /stripe_transfer_id\s*=/);
});

test("payment code sends no email and never touches the email outbox", () => {
  for (const file of paymentCode) {
    const code = codeOnly(readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /@\/lib\/email|scheduleEmailDispatch|email_outbox/, file);
  }
  assert.doesNotMatch(migration, /email_outbox|notifications/);
  // 0035's email trigger ignores AWAITING_PAYMENT -> CONFIRMED (payment) and -> PAYMENT_EXPIRED.
  const trigger = read("supabase", "migrations", "0035_payment_reservation_states.sql");
  assert.ok(trigger.includes("if not ((old.status = 'REQUESTED' and new.status in ('AWAITING_PAYMENT', 'DECLINED'))"));
});

test("the secret key and webhook secrets stay on the server", () => {
  for (const file of sourceFiles(path.join(root, "src"))) {
    const code = readFileSync(file, "utf8");
    assert.doesNotMatch(code, /NEXT_PUBLIC_STRIPE|NEXT_PUBLIC_PAYMENTS/, file);
    if (/^"use client"/.test(code)) assert.doesNotMatch(code, /STRIPE_SECRET_KEY|WEBHOOK_SECRET|payments\/server|stripe-api/, file);
  }
  for (const name of ["stripe-api.ts", "server.ts", "webhook-route.ts"]) {
    assert.match(read("src", "lib", "payments", name), /^import "server-only";/, name);
  }
});

// ── 0037, statically (run on real PostgreSQL in the isolated test) ──

test("0037 pins the database to test mode and keeps felyn_private away from every API role", () => {
  assert.ok(migration.includes("insert into felyn_private.stripe_settings (id, livemode) values (true, false);"));
  assert.ok(migration.includes("revoke all on schema felyn_private from public, anon, authenticated, service_role;"));
  for (const t of ["stripe_settings", "stripe_webhook_secrets"]) {
    assert.ok(migration.includes(`revoke all on table felyn_private.${t} from public, anon, authenticated, service_role;`), t);
  }
  assert.doesNotMatch(migration, /grant [^;]* on (schema |table )?felyn_private/i);
  assert.doesNotMatch(migration, /insert into felyn_private\.stripe_webhook_secrets/, "no secret is ever in the repository");
});

test("0037 grants: guests start/read their own payment; only service_role applies events and records Stripe answers", () => {
  const grants = [...migration.matchAll(/^\s*grant execute on function (.+?) to (\w+);/gm)].map((m) => `${m[1]} -> ${m[2]}`).sort();
  assert.deepEqual(grants, [
    "public.booking_payment_guest_status(uuid) -> authenticated",
    "public.booking_payment_start(uuid) -> authenticated",
    "public.host_payout_account_status() -> authenticated",
    "public.stripe_apply_event(text, text, text) -> service_role",
    "public.stripe_record_checkout_failure(uuid, text) -> service_role",
    "public.stripe_record_checkout_session(uuid, text, timestamptz) -> service_role",
    "public.stripe_register_host_account(uuid, text) -> service_role",
  ]);
  assert.equal([...migration.matchAll(/^\s*grant /gm)].length, 7, "no other grant");
  assert.doesNotMatch(migration, /grant execute on function public\.booking_item_mark_paid/);
});

test("0037 verifies the signature before it reads or writes anything, and deduplicates", () => {
  const apply = migration.slice(migration.indexOf("create function public.stripe_apply_event("));
  const order = [
    "v_check := felyn_private.stripe_signature_check(p_endpoint, v_body, p_signature);",
    "v_event := convert_from(v_body, 'UTF8')::jsonb;",
    "return jsonb_build_object('result', 'wrong_mode');",
    "insert into public.stripe_events",
    "v_result := felyn_private.stripe_process_event(v_type, v_event);",
  ].map((clause) => {
    const at = apply.indexOf(clause);
    assert.ok(at > 0, `stripe_apply_event lacks: ${clause}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps out of order");
  assert.ok(apply.includes("(v_event - 'pending_webhooks')::text"), "the identity hash ignores pending_webhooks");
  // Booking confirmation only through 0035's owner-only payment step, refused after the deadline.
  assert.ok(migration.includes("v_paid := public.booking_item_mark_paid(v_bp.booking_request_item_id);"));
  assert.ok(migration.includes("exception when sqlstate 'FB002' then"));
  assert.ok(migration.includes("v.payment_due_at > now() + interval '2 minutes'"), "capture only with a margin before the deadline");
});

test("0037's isolated test embeds its section 2 verbatim and always rolls back", () => {
  const isolated = read("supabase", "migrations", "stripe_test_mode_isolated_test.sql");
  const lines = migration.split("\n");
  const from = lines.findIndex((l) => l.includes("═════════ 2. MIGRATION ═════════"));
  const to = lines.findIndex((l, i) => i > from && l.includes("═════════ 3. POSTCONDITIONS"));
  const bodyText = lines.slice(from + 1, to).map((l) => (l ? "  " + l : l)).join("\n").trimEnd();
  assert.ok(isolated.includes(bodyText), "regenerate stripe_test_mode_isolated_test.sql from 0037");
  assert.match(isolated, /raise exception 'FELYN TEST PASSED/);
  assert.doesNotMatch(isolated, /^\s*(begin|commit|rollback)\s*;/im);
});

// ── release documentation guards ──

test("the runbook prohibits the 0035/0036 isolated tests on production and never lists them as production steps", () => {
  const runbook = read("docs", "payments", "stripe-test-mode-runbook.md");
  assert.match(runbook, /### PROHIBITED on production/);
  const sequence = runbook.slice(runbook.indexOf("## 6. Deployment sequence"), runbook.indexOf("## 7."));
  const checklistRows = sequence.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.deepEqual(
    checklistRows.map((line) => line.split("|")[2].trim()),
    [
      "`docs/payments/production-preflight-readonly.sql`",
      "`supabase/migrations/0035_payment_reservation_states.sql`",
      "`supabase/migrations/0036_stripe_payments.sql`",
      "`supabase/migrations/stripe_test_mode_isolated_test.sql`",
      "`supabase/migrations/0037_stripe_test_mode.sql`",
      "`supabase/migrations/booking_payment_expiry_schedule.sql`",
    ],
    "the production SQL checklist, in order",
  );
  // Each checklist fingerprint is the file's real SHA-256.
  for (const line of checklistRows) {
    const [, , file, , hash] = line.split("|").map((cell) => cell.trim().replace(/`/g, ""));
    assert.equal(hash, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), file);
  }
  for (const file of ["payment_reservation_states_isolated_test.sql", "stripe_payments_isolated_test.sql"]) {
    assert.ok(runbook.includes(file), file);
    // Named only as prohibited: never a checklist row or a numbered apply step.
    assert.ok(!checklistRows.some((line) => line.includes(file)), `${file} is in the SQL checklist`);
    assert.ok(!sequence.split("\n").some((line) => /^\s*\d+\.\s/.test(line) && line.includes(file)), `${file} is a deployment step`);
    // Their trigger-disabling is the reason: keep the evidence true.
    assert.ok(read("supabase", "migrations", file).includes("disable trigger"), file);
  }
  assert.doesNotMatch(read("supabase", "migrations", "stripe_test_mode_isolated_test.sql"), /disable trigger|alter table public\./i);
  const readme = read("supabase", "migrations", "README.md");
  assert.equal((readme.match(/prohibited on production/g) ?? []).length, 2);
});

test("the production preflight is read-only", () => {
  const preflight = read("docs", "payments", "production-preflight-readonly.sql");
  const code = preflight
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    // String literals (the checks' descriptions) are text, not SQL.
    .replace(/'(?:[^']|'')*'/g, "''");
  assert.match(code.trim(), /^(with|select) /);
  assert.doesNotMatch(
    code,
    /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|vacuum|copy|call|do|set_config|lock|refresh|comment|security)\b/i,
  );
  assert.doesNotMatch(code, /email_outbox|cron\.job/, "optional tables are only in comments (they may not exist)");
  assert.equal((code.match(/;/g) ?? []).length, 1, "one statement");
});
