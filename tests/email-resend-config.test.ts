import assert from "node:assert/strict";
import { test } from "node:test";
import { readEmailConfig } from "../src/lib/email/config";
import { RESEND_EMAILS_ENDPOINT, sendWithResend, type SendEmailInput } from "../src/lib/email/resend";

const INPUT: SendEmailInput = {
  apiKey: "re_test",
  from: "Felyn <bookings@felyn.eu>",
  to: "ana@example.com",
  replyTo: null,
  subject: "Confirmed",
  html: "<p>x</p>",
  text: "x",
  idempotencyKey: "felyn-email-1",
};

function fakeFetch(status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) {
  return async (url: string, init: RequestInit) => {
    if (seen) Object.assign(seen, { url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

test("sends one POST to Resend with the documented Idempotency-Key header", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const result = await sendWithResend(INPUT, fakeFetch(200, { id: "re_123" }, seen));
  assert.deepEqual(result, { ok: true, id: "re_123" });
  assert.equal(seen.url, RESEND_EMAILS_ENDPOINT);
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "felyn-email-1");
  assert.equal(headers.Authorization, "Bearer re_test");
  const body = JSON.parse(String(seen.init?.body));
  assert.deepEqual(body.to, ["ana@example.com"]);
  assert.equal("reply_to" in body, false);
});

test("classifies Resend errors as retryable or permanent", async () => {
  assert.equal((await sendWithResend(INPUT, fakeFetch(503, { name: "internal_server_error" }))).ok, false);
  const r503 = await sendWithResend(INPUT, fakeFetch(503, { name: "internal_server_error" }));
  const r429 = await sendWithResend(INPUT, fakeFetch(429, { name: "rate_limit_exceeded" }));
  const busy = await sendWithResend(INPUT, fakeFetch(409, { name: "concurrent_idempotent_requests" }));
  const conflict = await sendWithResend(INPUT, fakeFetch(409, { name: "invalid_idempotent_request" }));
  const invalid = await sendWithResend(INPUT, fakeFetch(422, { name: "validation_error", message: "bad from" }));
  const network = await sendWithResend(INPUT, async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(
    [r503, r429, busy, conflict, invalid, network].map((r) => (r.ok ? "ok" : r.retryable)),
    [true, true, true, false, false, true],
  );
  assert.equal((await sendWithResend(INPUT, fakeFetch(200, {}))).ok, false);
});

test("email config: off by default, strict for send", () => {
  assert.deepEqual(readEmailConfig({}), { ok: true, config: null });
  assert.equal(readEmailConfig({ EMAIL_DELIVERY_MODE: "loud" }).ok, false);
  assert.equal(readEmailConfig({ EMAIL_DELIVERY_MODE: "send", EMAIL_FROM: "Felyn <bookings@felyn.eu>", EMAIL_APP_URL: "https://app.felyn.eu" }).ok, false);
  assert.equal(
    readEmailConfig({ EMAIL_DELIVERY_MODE: "send", RESEND_API_KEY: "re_x", EMAIL_FROM: "Felyn <bookings@felyn.eu>", EMAIL_APP_URL: "http://localhost:3000" }).ok,
    false,
  );
  assert.equal(
    readEmailConfig({ EMAIL_DELIVERY_MODE: "send", RESEND_API_KEY: "re_x", EMAIL_FROM: "Felyn\r\nBcc: x <a@b.eu>", EMAIL_APP_URL: "https://app.felyn.eu" }).ok,
    false,
  );
  const ok = readEmailConfig({
    EMAIL_DELIVERY_MODE: "send",
    RESEND_API_KEY: "re_x",
    EMAIL_FROM: "Felyn <bookings@felyn.eu>",
    EMAIL_APP_URL: "https://app.felyn.eu/",
    EMAIL_RECIPIENT_ALLOWLIST: "Ana@Example.com, b@example.com",
  });
  assert.ok(ok.ok && ok.config);
  assert.equal(ok.config.appUrl, "https://app.felyn.eu");
  assert.deepEqual([...(ok.config.allowlist ?? [])], ["ana@example.com", "b@example.com"]);
  const log = readEmailConfig({ EMAIL_DELIVERY_MODE: "log", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
  assert.ok(log.ok && log.config);
  assert.equal(log.config.appUrl, "http://localhost:3000");
  assert.equal(readEmailConfig({ EMAIL_DELIVERY_MODE: "send", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@felyn.eu", EMAIL_APP_URL: "https://app.felyn.eu/x" }).ok, false);
});
