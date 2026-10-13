import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MIN_PRICE_PER_PERSON_CENTS, STRIPE_MAX_AMOUNT_CENTS, calculatePlatformFeeCents } from "../src/lib/payments/money";
import {
  HOST_TRANSFER_REVIEW_PERIOD_MS,
  MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS,
  MIN_TIME_TO_START_CHECKOUT_MS,
} from "../src/lib/payments/timing";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const migration = read("supabase", "migrations", "0036_stripe_payments.sql");
const isolated = read("supabase", "migrations", "stripe_payments_isolated_test.sql");
const MINUTE_MS = 60 * 1000;

function sqlFunction(sql: string, header: string): string {
  const start = sql.indexOf(header);
  assert.ok(start >= 0, `missing: ${header}`);
  const end = sql.indexOf("$fn$;", start);
  return sql.slice(start, end);
}

test("0036 is one DO block, run by the table owner, after 0035", () => {
  assert.equal(migration.match(/^do \$migration\$/gm)?.length, 1);
  assert.match(migration, /run this as the owner of public\.booking_request_items/);
  assert.match(migration, /0035 \(payment reservation states\) is not applied/);
  // The one grant: the admin-only staff release, to signed-in users (the function checks admin itself).
  assert.deepEqual(migration.match(/^\s*grant\b.*$/gim)?.map((l) => l.trim()), [
    "grant execute on function public.support_staff_release_host_transfer(uuid, text) to authenticated;",
  ]);
  assert.doesNotMatch(migration, /^\s*(begin|commit|rollback)\s*;/im);
});

test("the database fee rule is Stage 1's round-half-up rule, for every gross amount", () => {
  assert.match(migration, /check \(platform_fee_cents = \(gross_cents \+ 5\) \/ 10\)/);
  assert.match(migration, /host_share_cents > 0 and platform_fee_cents \+ host_share_cents = gross_cents/);
  // Postgres integer division truncates; for positive amounts that is floor, as here.
  for (let gross = 1; gross <= 50000; gross += 1) {
    assert.equal(Math.trunc((gross + 5) / 10), calculatePlatformFeeCents(gross), `gross ${gross}`);
  }
});

test("money limits agree with Stage 1: €5 minimum, Stripe's maximum, EUR only", () => {
  assert.equal(MIN_PRICE_PER_PERSON_CENTS, 500);
  assert.match(migration, new RegExp(`check \\(price_per_person_cents >= ${MIN_PRICE_PER_PERSON_CENTS}\\)`));
  assert.match(migration, new RegExp(`gross_cents between 1 and ${STRIPE_MAX_AMOUNT_CENTS}`));
  assert.match(migration, /check \(currency = 'EUR'\)/);
  // Euro amounts in SQL (numeric) use the same €5.
  assert.equal(migration.match(/price_per_person < 5\b/g)?.length, 4);
});

test("acceptance needs the same 60 minutes to pay as Stage 1's constant", () => {
  const confirm = sqlFunction(migration, "create or replace function public.booking_item_confirm(p_item_id uuid)");
  assert.equal(MIN_PAYMENT_WINDOW_AT_ACCEPTANCE_MS, 60 * MINUTE_MS);
  assert.match(confirm, /if v_due < now\(\) \+ interval '60 minutes' then/);
  assert.doesNotMatch(confirm, /'30 minutes'/);
  assert.match(confirm, /using errcode = 'FB001'/);
  assert.match(confirm, /using errcode = 'FB004'/);
  // Everything else is 0035's acceptance: lock, lazy release, overlap check, deadline.
  for (const clause of [
    "perform public.booking_host_lock(v_provider);",
    "for update of bri;",
    "v_due := least(now() + interval '24 hours', v_start - interval '2 hours');",
    "perform public.booking_expire_host_payments(v_provider);",
    "using errcode = '23P01';",
    "payment_due_at = v_due",
  ]) {
    assert.ok(confirm.includes(clause), `booking_item_confirm lacks: ${clause}`);
  }
});

test("a new payment attempt needs exactly the app's 41-minute Checkout cutoff", () => {
  const match = /if v_item\.payment_due_at - now\(\) < interval '(\d+) minutes' then/.exec(migration);
  assert.ok(match, "the attempt window check is missing");
  const dbCutoffMs = Number(match[1]) * MINUTE_MS;
  assert.equal(dbCutoffMs, 41 * MINUTE_MS);
  assert.equal(dbCutoffMs, MIN_TIME_TO_START_CHECKOUT_MS);
});

test("no client or service_role access to the new tables and helpers; service_role can't write bookings", () => {
  for (const table of ["host_payout_accounts", "booking_payments", "stripe_events", "booking_payment_transfer_releases"]) {
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`));
  }
  for (const fn of [
    "host_payout_accounts_before_update()",
    "booking_payments_before_insert()",
    "booking_payments_before_update()",
    "booking_payment_transfer_blocker(uuid)",
    "stripe_events_before_update()",
    "experiences_enforce_min_price()",
    "booking_request_items_min_price()",
    "booking_support_case_key(uuid)",
    "booking_support_case_lock(uuid)",
    "booking_payment_open_support_case(uuid, timestamptz)",
    "support_threads_case_activity()",
    "booking_payment_transfer_releases_append_only()",
    "booking_payments_record_release()",
  ]) {
    assert.ok(migration.includes(`revoke execute on function public.${fn} from public, anon, authenticated, service_role;`), fn);
  }
  for (const table of ["booking_requests", "booking_request_items"]) {
    assert.match(migration, new RegExp(`revoke insert, update, delete, truncate on table public\\.${table} from service_role;`));
  }
});

test("the host-transfer release gate lives in the database, with Stage 1's seven days", () => {
  const has = (source: string, clause: string, label: string) => assert.ok(source.includes(clause), `${label} lacks: ${clause}`);
  const guard = sqlFunction(migration, "create function public.booking_payments_before_update()");
  const gate = guard.slice(guard.indexOf("-- The release gate:"));
  assert.ok(guard.includes("-- The release gate:"), "the release gate is missing from the update guard");
  // Seven full days after the snapshot's scheduled end = the app's constant.
  assert.equal(HOST_TRANSFER_REVIEW_PERIOD_MS, 168 * 60 * MINUTE_MS);
  has(gate, "v_item.confirmed_start_at + v_item.duration_minutes * interval '1 minute' + interval '168 hours'", "the release gate");
  // Locks first, then the database's own clock, then the checks.
  const order = [
    "perform public.booking_support_case_lock(new.booking_request_item_id);",
    "new.transfer_released_at := pg_catalog.clock_timestamp();",
    "using errcode = 'FB007'",
    "s.role = 'admin'",
    "using errcode = 'FB008'",
  ].map((clause) => {
    has(gate, clause, "the release gate");
    return gate.indexOf(clause);
  });
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "release gate steps out of order");
  // A staff release: a signed-in admin acting as themselves, never an owner session.
  has(gate, "coalesce(pg_catalog.current_setting('role', true), '') <> 'authenticated'", "the release gate");
  has(gate, "new.transfer_released_by is distinct from auth.uid()", "the release gate");
  // Shared locks for support-thread writes, exclusive for the release; one key for both.
  const threads = sqlFunction(migration, "create function public.support_threads_case_activity()");
  has(threads, "pg_catalog.pg_advisory_xact_lock_shared(public.booking_support_case_key(new.user_id));", "the thread trigger");
  has(threads, "new.case_activity_at := pg_catalog.clock_timestamp();", "the thread trigger");
  has(migration, "before insert or update on public.support_threads", "0036");
  const lock = sqlFunction(migration, "create function public.booking_support_case_lock(p_item_id uuid)");
  has(lock, "perform pg_catalog.pg_advisory_xact_lock(public.booking_support_case_key(v_user));", "the release lock");
  has(lock, "order by x.u", "the release lock");
  has(migration, "pg_catalog.hashtextextended('felyn.support_case:' || p_user_id::text, 0)", "0036");
  // Admin-only staff path; audited, append-only.
  has(migration, "revoke execute on function public.support_staff_release_host_transfer(uuid, text) from public, anon, service_role;", "0036");
  has(migration, "grant execute on function public.support_staff_release_host_transfer(uuid, text) to authenticated;", "0036");
  has(migration, "before update or delete on public.booking_payment_transfer_releases", "0036");
  has(migration, "before truncate on public.booking_payment_transfer_releases", "0036");
  has(migration, "for each row when (old.host_transfer_status = 'pending' and new.host_transfer_status = 'released')", "0036");
});

test("0035's payment and expiry guards are not redefined by 0036", () => {
  for (const name of ["booking_request_items_before_update", "booking_item_mark_paid", "expire_due_booking_payments", "booking_expire_host_payments"]) {
    assert.doesNotMatch(migration, new RegExp(`create (or replace )?function public\\.${name}\\(`), name);
  }
});

test("payment attempts: one live attempt per booking, confirmed only after the booking is", () => {
  assert.match(
    migration,
    /create unique index booking_payments_one_live_attempt\s+on public\.booking_payments \(booking_request_item_id\)\s+where status in \('creating', 'open', 'authorized', 'captured', 'confirmed', 'unconfirmable'\);/,
  );
  const update = sqlFunction(migration, "create function public.booking_payments_before_update()");
  assert.match(update, /A payment can only be confirmed once its booking is CONFIRMED/);
  assert.match(update, /A host transfer needs a CONFIRMED, completed experience/);
  assert.match(update, /A host transfer needs seven full days after the experience''s scheduled end/);
  const insert = sqlFunction(migration, "create function public.booking_payments_before_insert()");
  assert.match(insert, /must match the booking''s own price and guest count/);
  assert.match(insert, /using errcode = 'FB005'/);
  assert.match(insert, /using errcode = 'FB006'/);
});

test("the isolated test embeds 0036's section 2 verbatim", () => {
  const lines = migration.split("\n");
  const from = lines.findIndex((l) => l.includes("═════════ 2. MIGRATION ═════════"));
  const to = lines.findIndex((l, i) => i > from && l.includes("═════════ 3. POSTCONDITIONS"));
  const body = lines.slice(from + 1, to).map((l) => (l ? "  " + l : l)).join("\n").trimEnd();
  assert.ok(isolated.includes(body), "regenerate stripe_payments_isolated_test.sql from 0036");
  assert.match(isolated, /raise exception 'FELYN TEST PASSED/);
  assert.doesNotMatch(isolated, /^\s*(begin|commit|rollback)\s*;/im);
});

test("no application code touches the payment tables directly (only 0037's functions do)", () => {
  for (const file of readdirSync(path.join(root, "src"), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file)) continue;
    assert.doesNotMatch(
      read("src", file),
      /booking_payments|host_payout_accounts|stripe_events|booking_payment_transfer_blocker|booking_payment_transfer_releases|support_staff_release_host_transfer/,
      file,
    );
  }
});
