import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailConfig } from "../src/lib/email/config";
import { idempotencyKeyFor, processClaimedRow, type DispatchDeps } from "../src/lib/email/dispatch-core";
import { MAX_ATTEMPTS, type CurrentBookingState, type OutboxRow } from "../src/lib/email/events";
import type { SendEmailInput, SendEmailResult } from "../src/lib/email/resend";

const NOW = new Date("2030-05-01T12:00:00Z");
const ITEM = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const GUEST = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";

const CONFIG: EmailConfig = {
  mode: "send",
  from: "Felyn <bookings@felyn.eu>",
  replyTo: null,
  appUrl: "https://app.felyn.eu",
  resendApiKey: "re_test",
  allowlist: null,
};

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    event_key: `request_confirmed_guest:${ITEM}`,
    event_type: "request_confirmed_guest",
    recipient_role: "guest",
    recipient_user_id: GUEST,
    booking_request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    booking_request_item_ids: [ITEM],
    payload: {
      items: [{ title: "Paella Feast", planned_date: "2030-06-01", planned_moment: "evening", preferred_time: "19:30", guest_count: 2, price_per_person: 40, currency: "EUR", host_display_name: "Maria" }],
      guest_first_name: "Ana",
    },
    status: "sending",
    attempts: 1,
    claim_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

type Recorder = { calls: string[]; sent: SendEmailInput[]; lookups: string[] };

function deps(options: {
  state?: CurrentBookingState | null;
  emails?: Record<string, string>;
  sendResults?: SendEmailResult[];
  config?: Partial<EmailConfig>;
  throwOnState?: boolean;
} = {}): { deps: DispatchDeps; rec: Recorder } {
  const rec: Recorder = { calls: [], sent: [], lookups: [] };
  const results = [...(options.sendResults ?? [{ ok: true, id: "re_msg_1" }])];
  return {
    rec,
    deps: {
      config: { ...CONFIG, ...options.config },
      now: () => NOW,
      async loadCurrentState() {
        if (options.throwOnState) throw new Error("db unavailable");
        return options.state === undefined ? { requestStatus: "REQUESTED", items: [{ id: ITEM, status: "CONFIRMED", cancelledBy: null }] } : options.state;
      },
      async getRecipientEmail(userId) {
        rec.lookups.push(userId);
        return (options.emails ?? { [GUEST]: "ana@example.com", [HOST]: "maria@example.com" })[userId] ?? null;
      },
      async send(input) {
        rec.sent.push(input);
        return results.shift() ?? { ok: true, id: "re_msg_x" };
      },
      log() {},
      async markSent(r, id) {
        rec.calls.push(`sent:${r.claim_token}:${id}`);
      },
      async markRetry(r, error, next) {
        rec.calls.push(`retry:${r.claim_token}:${next.getTime() - NOW.getTime()}`);
      },
      async markFailed(r, error) {
        rec.calls.push(`failed:${error}`);
      },
      async markSkipped(r, reason) {
        rec.calls.push(`skipped:${reason}`);
      },
    },
  };
}

test("guest recipient: looked up by the guest's user id, sent with a stable idempotency key", async () => {
  const { deps: d, rec } = deps();
  assert.equal(await processClaimedRow(row(), d), "sent");
  assert.deepEqual(rec.lookups, [GUEST]);
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0].to, "ana@example.com");
  assert.equal(rec.sent[0].idempotencyKey, "felyn-email-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.match(rec.sent[0].text, new RegExp(`https://app\\.felyn\\.eu/bookings/${ITEM}`));
  assert.deepEqual(rec.calls, ["sent:cccccccc-cccc-4ccc-8ccc-cccccccccccc:re_msg_1"]);
});

test("host recipient: looked up by the provider's user id; CTA opens the host request page", async () => {
  const { deps: d, rec } = deps({ state: { requestStatus: "REQUESTED", items: [{ id: ITEM, status: "REQUESTED", cancelledBy: null }] } });
  const r = row({ event_type: "request_created_host", recipient_role: "host", recipient_user_id: HOST, event_key: `request_created_host:${ITEM}` });
  assert.equal(await processClaimedRow(r, d), "sent");
  assert.deepEqual(rec.lookups, [HOST]);
  assert.equal(rec.sent[0].to, "maria@example.com");
  assert.match(rec.sent[0].text, new RegExp(`https://app\\.felyn\\.eu/provider/requests/${ITEM}`));
  assert.doesNotMatch(rec.sent[0].text, /ana@example\.com/);
});

test("missing provider account: no lookup, nothing sent, recorded as skipped", async () => {
  const { deps: d, rec } = deps();
  const r = row({ event_type: "request_created_host", recipient_role: "host", recipient_user_id: null });
  assert.equal(await processClaimedRow(r, d), "skipped");
  assert.deepEqual(rec.calls, ["skipped:no_recipient_account"]);
  assert.equal(rec.lookups.length, 0);
  assert.equal(rec.sent.length, 0);
});

test("status re-check: a confirmation that has since been cancelled is not sent", async () => {
  const { deps: d, rec } = deps({ state: { requestStatus: "REQUESTED", items: [{ id: ITEM, status: "CANCELLED", cancelledBy: "provider" }] } });
  assert.equal(await processClaimedRow(row(), d), "skipped");
  assert.deepEqual(rec.calls, ["skipped:no_longer_confirmed"]);
  assert.equal(rec.sent.length, 0);
});

test("deleted booking or deleted recipient account is skipped", async () => {
  const gone = deps({ state: null });
  assert.equal(await processClaimedRow(row(), gone.deps), "skipped");
  assert.deepEqual(gone.rec.calls, ["skipped:booking_missing"]);
  const noUser = deps({ emails: {} });
  assert.equal(await processClaimedRow(row(), noUser.deps), "skipped");
  assert.deepEqual(noUser.rec.calls, ["skipped:recipient_missing"]);
});

test("retry after failure: same idempotency key on the next attempt, then sent", async () => {
  const first = deps({ sendResults: [{ ok: false, retryable: true, error: "resend 503 internal_server_error" }] });
  assert.equal(await processClaimedRow(row({ attempts: 1 }), first.deps), "retry");
  assert.deepEqual(first.rec.calls, ["retry:cccccccc-cccc-4ccc-8ccc-cccccccccccc:60000"]);

  const second = deps();
  const reclaimed = row({ attempts: 2, claim_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
  assert.equal(await processClaimedRow(reclaimed, second.deps), "sent");
  assert.equal(second.rec.sent[0].idempotencyKey, first.rec.sent[0].idempotencyKey);
  assert.deepEqual(second.rec.calls, ["sent:dddddddd-dddd-4ddd-8ddd-dddddddddddd:re_msg_1"]);
});

test("a database error before sending is retried, not lost", async () => {
  const { deps: d, rec } = deps({ throwOnState: true });
  assert.equal(await processClaimedRow(row({ attempts: 2 }), d), "retry");
  assert.deepEqual(rec.calls, ["retry:cccccccc-cccc-4ccc-8ccc-cccccccccccc:300000"]);
  assert.equal(rec.sent.length, 0);
});

test("retries stop after MAX_ATTEMPTS; non-retryable errors fail at once", async () => {
  const last = deps({ sendResults: [{ ok: false, retryable: true, error: "resend 503" }] });
  assert.equal(await processClaimedRow(row({ attempts: MAX_ATTEMPTS }), last.deps), "failed");
  assert.deepEqual(last.rec.calls, ["failed:resend 503"]);

  const tooMany = deps();
  assert.equal(await processClaimedRow(row({ attempts: MAX_ATTEMPTS + 1 }), tooMany.deps), "failed");
  assert.equal(tooMany.rec.sent.length, 0);

  const conflict = deps({ sendResults: [{ ok: false, retryable: false, error: "resend 409 invalid_idempotent_request" }] });
  assert.equal(await processClaimedRow(row(), conflict.deps), "failed");
});

test("expired events and allowlist / log mode never reach Resend", async () => {
  const old = deps();
  assert.equal(await processClaimedRow(row({ created_at: "2030-04-01T00:00:00Z" }), old.deps), "skipped");
  assert.deepEqual(old.rec.calls, ["skipped:expired"]);

  const justInside = deps();
  assert.equal(await processClaimedRow(row({ created_at: new Date(NOW.getTime() - (23 * 60 - 1) * 60_000).toISOString() }), justInside.deps), "sent");
  const justOutside = deps();
  assert.equal(await processClaimedRow(row({ created_at: new Date(NOW.getTime() - (23 * 60 + 1) * 60_000).toISOString() }), justOutside.deps), "skipped");
  assert.deepEqual(justOutside.rec.calls, ["skipped:expired"]);
  assert.equal(justOutside.rec.sent.length, 0);

  const allow = deps({ config: { allowlist: new Set(["someone-else@example.com"]) } });
  assert.equal(await processClaimedRow(row(), allow.deps), "skipped");
  assert.deepEqual(allow.rec.calls, ["skipped:not_allowlisted"]);

  const logOnly = deps({ config: { mode: "log" } });
  assert.equal(await processClaimedRow(row(), logOnly.deps), "logged");
  assert.deepEqual(logOnly.rec.calls, ["skipped:log_only"]);
  assert.equal(logOnly.rec.sent.length, 0);
});

test("a malformed or mismatched row is failed without sending", async () => {
  const wrongRole = deps();
  assert.equal(await processClaimedRow(row({ recipient_role: "host" }), wrongRole.deps), "failed");
  const badPayload = deps();
  assert.equal(await processClaimedRow(row({ payload: { items: [] } }), badPayload.deps), "failed");
  assert.equal(wrongRole.rec.sent.length + badPayload.rec.sent.length, 0);
});

test("idempotency key is per outbox row and within Resend's 256-character limit", () => {
  const key = idempotencyKeyFor(row());
  assert.ok(key.length <= 256);
  assert.notEqual(key, idempotencyKeyFor(row({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })));
});
