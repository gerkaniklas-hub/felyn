import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkEventStillCurrent, parsePayload, type EmailPayload } from "@/lib/email/events";
import { renderBookingEmail } from "@/lib/email/templates/booking-emails";
import { formatCanaryDeadline } from "@/lib/matching/canary-time";
import {
  deriveAggregateItemStage,
  getItemStatusLabel,
  getMessagingClosedLabel,
  getMessagingWindowState,
  isSlotOccupyingStatus,
} from "@/lib/matching/booking-status";
import { getProviderRequestItems } from "@/lib/provider/dashboard";

// Phase 5 (0035): REQUESTED --host accepts--> AWAITING_PAYMENT --payment--> CONFIRMED,
// AWAITING_PAYMENT --deadline--> PAYMENT_EXPIRED. The SQL itself (transitions, deadline,
// overlap, expiry, concurrency) runs against real Postgres: see the 0035 README entry.
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = read("supabase", "migrations", "0035_payment_reservation_states.sql");
const DAY = 24 * 60 * 60 * 1000;

function sqlFunction(sql: string, header: string, end = "$fn$;"): string {
  const from = sql.indexOf(header);
  assert.ok(from >= 0, `${header} not found`);
  return sql.slice(from, sql.indexOf(end, from));
}
const lines = (body: string) => body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

test("the new states read as 'not confirmed yet' and 'released'", () => {
  assert.equal(getItemStatusLabel("AWAITING_PAYMENT"), "Awaiting payment");
  assert.equal(getItemStatusLabel("PAYMENT_EXPIRED"), "Payment expired");
  assert.equal(isSlotOccupyingStatus("AWAITING_PAYMENT"), true, "an accepted, unpaid booking still holds the guest's slot");
  assert.equal(isSlotOccupyingStatus("PAYMENT_EXPIRED"), false);
  assert.equal(deriveAggregateItemStage(["PAYMENT_EXPIRED"]), "expired");
  assert.equal(deriveAggregateItemStage(["AWAITING_PAYMENT", "CONFIRMED"]), "partially_confirmed");
  assert.equal(formatCanaryDeadline("2027-07-15T19:00:00Z"), "Thu 15 Jul, 20:00", "deadlines are shown in Tenerife time");
});

test("messaging: open while awaiting payment; 30 days from the deadline once expired", () => {
  assert.deepEqual(getMessagingWindowState("AWAITING_PAYMENT", null, null, null), { canSend: true, daysRemaining: null });
  const recent = new Date(Date.now() - 2 * DAY).toISOString();
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  assert.equal(getMessagingWindowState("PAYMENT_EXPIRED", null, null, recent).canSend, true);
  const closed = getMessagingWindowState("PAYMENT_EXPIRED", null, null, old);
  assert.equal(closed.canSend, false);
  assert.equal(getMessagingClosedLabel("PAYMENT_EXPIRED", closed), "The 30-day reply window for this expired booking has closed.");
  assert.equal(getMessagingWindowState("PAYMENT_EXPIRED", null, null, null).canSend, false, "no anchor, no window");
});

test("the acceptance email is current while accepted or paid, and never says 'confirmed'", async () => {
  const state = (status: "AWAITING_PAYMENT" | "CONFIRMED" | "PAYMENT_EXPIRED") => ({
    requestStatus: "REQUESTED",
    items: [{ id: "i", status, cancelledBy: null }],
  });
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("AWAITING_PAYMENT")).current, true);
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("CONFIRMED")).current, true);
  assert.equal(checkEventStillCurrent("request_confirmed_guest", state("PAYMENT_EXPIRED")).current, false);
  assert.equal(checkEventStillCurrent("request_created_guest", state("AWAITING_PAYMENT")).current, true);

  const payload = parsePayload({
    items: [{ title: "Paella", planned_date: "2030-06-01", planned_moment: "evening", preferred_time: "19:30", guest_count: 2, price_per_person: 40, currency: "EUR", host_display_name: "Maria" }],
    guest_first_name: "Ana",
  }) as EmailPayload;
  const email = await renderBookingEmail("request_confirmed_guest", payload, "https://app.felyn.eu/bookings/x");
  assert.equal(email.subject, "Request accepted: Paella");
  assert.match(email.text, /isn't confirmed until you pay/);
  assert.doesNotMatch(email.text, /has confirmed|is confirmed|booked/i);
});

test("host booking data includes accepted (awaiting payment) and expired bookings, never withdrawn ones", async () => {
  const row = (id: string, status: string, due: string | null) => ({
    id, booking_request_id: "r1", experience_id: "e1", planned_date: "2027-07-15", planned_moment: "evening",
    guest_count: 2, price_per_person: 40, preferred_time: "20:00:00", host_note: null, status, decline_reason: null,
    decline_note: null, decided_at: null, created_at: "2026-10-01T10:00:00Z", cancelled_at: null, cancelled_by: null,
    cancellation_reason: null, cancellation_note: null,
    accepted_at: due ? "2026-10-08T12:00:00Z" : null, confirmed_start_at: due ? "2027-07-15T19:00:00+00:00" : null,
    duration_minutes: due ? 120 : null, payment_due_at: due,
  });
  const tables: Record<string, unknown[]> = {
    experiences: [{ id: "e1", title: "Pasta Evening", currency: "EUR" }],
    booking_request_items: [
      row("awaiting", "AWAITING_PAYMENT", "2026-10-09T12:00:00Z"),
      row("expired", "PAYMENT_EXPIRED", "2026-10-09T12:00:00Z"),
      row("withdrawn", "WITHDRAWN", null),
    ],
    booking_requests: [{ id: "r1", status: "WITHDRAWN", stay_id: null }],
  };
  const query = (rows: unknown[]): unknown =>
    new Proxy({}, {
      get: (_t, prop) =>
        prop === "then"
          ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, ko)
          : () => query(rows),
    });
  const supabase = { from: (t: string) => query(tables[t] ?? []), rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  const items = new Map((await getProviderRequestItems(supabase, "p1")).map((i) => [i.itemId, i]));
  // Kept even under a withdrawn request: the host accepted them (history), unlike withdrawn items.
  assert.deepEqual([...items.keys()].sort(), ["awaiting", "expired"]);
  assert.equal(items.get("awaiting")!.paymentDueAt, "2026-10-09T12:00:00Z");
});

test("the isolated test runs section 2 of 0035 verbatim", () => {
  const section = (sql: string, start: string, end: string) => {
    const all = sql.split(/\r?\n/);
    const from = all.findIndex((l) => l.includes(start));
    const to = all.findIndex((l, i) => i > from && l.includes(end));
    return all.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("v_stage :="));
  };
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const isolated = read("supabase", "migrations", "payment_reservation_states_isolated_test.sql");
  assert.ok(body.length > 300);
  assert.deepEqual(section(isolated, "═════════ 1. 0035 BODY", "═════════ 2. SETUP"), body);
});

test("0035 keeps every 0034 guard rule except the three it deliberately replaces", () => {
  const before = lines(sqlFunction(read("supabase", "migrations", "0034_host_booking_overlap.sql"), "create or replace function public.booking_request_items_before_update()"));
  const after = lines(sqlFunction(migration, "create or replace function public.booking_request_items_before_update()"));
  const replaced = [
    "v_accepting boolean := old.status = 'REQUESTED' and new.status = 'CONFIRMED';",
    "and not ((old.status = 'REQUESTED' and new.status in ('CONFIRMED', 'DECLINED', 'WITHDRAWN'))",
    "or v_cancelling) then",
  ];
  for (const line of before.slice(1)) {
    if (replaced.includes(line)) continue;
    assert.ok(after.includes(line), `0035 dropped 0034 guard line: ${line}`);
  }
  for (const line of [
    "v_accepting boolean := old.status = 'REQUESTED' and new.status = 'AWAITING_PAYMENT';",
    "v_paying boolean := old.status = 'AWAITING_PAYMENT' and new.status = 'CONFIRMED';",
    "v_expiring boolean := old.status = 'AWAITING_PAYMENT' and new.status = 'PAYMENT_EXPIRED';",
    "and not ((old.status = 'REQUESTED' and new.status in ('AWAITING_PAYMENT', 'DECLINED', 'WITHDRAWN'))",
    "or v_paying or v_expiring or v_cancelling) then",
    // expiry: owner only (the expiry function / acceptance's release), never before the deadline
    "if v_expiring then",
    "raise exception 'Only payment expiry can expire a booking' using errcode = '42501';",
    "if old.payment_due_at > now() then",
    "if not v_accepting and new.payment_due_at is distinct from old.payment_due_at then",
    "least(new.accepted_at + interval '24 hours', new.confirmed_start_at - interval '2 hours') then",
    // payment: owner only, before the deadline, under the host lock
    "if v_paying then",
    "is distinct from (select c.relowner from pg_catalog.pg_class c where c.oid = tg_relid) then",
    "raise exception 'Only the payment step can confirm a booking' using errcode = '42501';",
    "if old.payment_due_at is null or old.payment_due_at <= now() then",
  ]) {
    assert.ok(after.includes(line), `0035 guard lacks: ${line}`);
  }
});

test("acceptance: AWAITING_PAYMENT with the deadline, at least 30 minutes to pay, lapsed reservations released first", () => {
  const confirm = sqlFunction(migration, "create or replace function public.booking_item_confirm(p_item_id uuid)");
  const order = [
    "perform public.booking_host_lock(v_provider);",
    "for update of bri;",
    "v_due := least(now() + interval '24 hours', v_start - interval '2 hours');",
    "if v_due < now() + interval '30 minutes' then",
    "perform public.booking_expire_host_payments(v_provider);",
    "public.booking_host_overlap_exists(v_provider, v_item.id, v_start,",
    "set status = 'AWAITING_PAYMENT',",
    "payment_due_at = v_due",
  ].map((clause) => {
    const at = confirm.indexOf(clause);
    assert.ok(at > 0, `booking_item_confirm lacks: ${clause}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "steps out of order");
  assert.match(confirm, /using errcode = 'FB001'/);
  assert.doesNotMatch(confirm, /set status = 'CONFIRMED'/, "acceptance never confirms");
});

test("AWAITING_PAYMENT reserves the host's time; expiry is deadline-only, per host, owner-only", () => {
  const overlap = sqlFunction(migration, "create or replace function public.booking_host_overlap_exists(");
  assert.ok(overlap.includes("and o.status in ('AWAITING_PAYMENT', 'CONFIRMED')"));
  const hostExpiry = sqlFunction(migration, "create function public.booking_expire_host_payments(p_provider_id uuid)");
  for (const clause of ["set status = 'PAYMENT_EXPIRED'", "and bri.status = 'AWAITING_PAYMENT'", "and bri.payment_due_at <= now()", "and e.provider_id = p_provider_id"]) {
    assert.ok(hostExpiry.includes(clause), `booking_expire_host_payments lacks: ${clause}`);
  }
  const expiry = sqlFunction(migration, "create function public.expire_due_booking_payments()");
  assert.ok(expiry.includes("if public.booking_host_try_lock(v_provider) then"), "expiry must never wait for a host lock");
  assert.match(expiry, /security definer set search_path = ''/);
  for (const fn of ["booking_host_try_lock(uuid)", "booking_expire_host_payments(uuid)", "expire_due_booking_payments()", "booking_item_mark_paid(uuid)"]) {
    assert.ok(migration.includes(`revoke execute on function public.${fn} from public, anon, authenticated, service_role;`), `${fn} not revoked`);
  }
  assert.doesNotMatch(migration, /^\s*grant\b/im, "0035 grants nothing");
});

test("payment: owner-only booking_item_mark_paid confirms under the host lock, only before the deadline", () => {
  const pay = sqlFunction(migration, "create function public.booking_item_mark_paid(p_item_id uuid)");
  assert.match(pay, /security definer set search_path = ''/);
  const order = [
    "perform public.booking_host_lock(v_provider);",
    "for update;",
    "if v_item.status = 'PAYMENT_EXPIRED'",
    "or (v_item.status = 'AWAITING_PAYMENT' and v_item.payment_due_at <= now()) then",
    "using errcode = 'FB002';",
    "set status = 'CONFIRMED'",
    "and bri.status = 'AWAITING_PAYMENT';",
  ].map((clause) => {
    const at = pay.indexOf(clause);
    assert.ok(at > 0, `booking_item_mark_paid lacks: ${clause}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "steps out of order");
  assert.doesNotMatch(pay, /payment_due_at\s*=|accepted_at\s*=|confirmed_start_at\s*=/, "payment changes nothing but the status");
  // The app never calls it: payment is the Stripe phase's job.
  for (const file of readdirSync(path.join(root, "src"), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file)) continue;
    assert.doesNotMatch(readFileSync(path.join(root, "src", file), "utf8"), /booking_item_mark_paid/, file);
  }
});

test("the host's Upcoming list labels each booking by its status", () => {
  const row = read("src", "components", "provider", "UpcomingBookingRow.tsx");
  assert.match(row, /tone=\{getItemStatusTone\(status\)\}/);
  assert.match(row, /\{getItemStatusLabel\(status\)\}/);
  assert.doesNotMatch(row, />\s*Confirmed\s*</, "no hard-coded Confirmed badge");
  assert.match(read("src", "app", "provider", "page.tsx"), /<UpcomingBookingRow[\s\S]*?status=\{item\.status\}/);
  assert.equal(getItemStatusLabel("AWAITING_PAYMENT"), "Awaiting payment");
  assert.equal(getItemStatusLabel("CONFIRMED"), "Confirmed");
});

test("the expiry schedule is pg_cron every minute, straight to the database function", () => {
  const schedule = read("supabase", "migrations", "booking_payment_expiry_schedule.sql");
  assert.match(schedule, /cron\.schedule\('expire-due-booking-payments', '\* \* \* \* \*', 'select public\.expire_due_booking_payments\(\);'\)/);
  // A booking-state job: no HTTP call, no app route (unlike the email sweep).
  assert.doesNotMatch(schedule, /net\.http_post|https?:\/\//);
});

test("the app never sends payment_due_at and explains every refused acceptance", () => {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
  })(path.join(root, "src"));
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/from\("booking_request_items"\)\s*\.(insert|update|upsert)\(/g)) {
      const rest = code.slice(match.index + match[0].length);
      const payload = rest.slice(0, Math.min(...[rest.indexOf(".select("), rest.indexOf(";")].filter((i) => i >= 0)));
      assert.doesNotMatch(payload, /payment_due_at|AWAITING_PAYMENT|PAYMENT_EXPIRED/, path.relative(root, file));
    }
  }
  const actions = read("src", "lib", "provider", "actions.ts");
  assert.match(actions, /error\?\.code === "FB001"\) \{\s+return \{ ok: false, error: TOO_LATE_TO_ACCEPT_ERROR \};/);
  const ria = read("src", "components", "provider", "RequestItemActions.tsx");
  for (const state of ["AWAITING_PAYMENT", "PAYMENT_EXPIRED"]) {
    assert.ok(ria.indexOf(`if (status === "${state}")`) > 0 && ria.indexOf(`if (status === "${state}")`) < ria.lastIndexOf("onClick={handleConfirm}"),
      `RequestItemActions must handle ${state} before offering Accept/Decline`);
  }
  assert.match(ria, /"Accepting…" : "Accept"/);
  const requests = read("src", "app", "provider", "requests", "page.tsx");
  assert.match(requests, /section\("Accepted · awaiting payment", awaitingPayment/);
  assert.match(requests, /section\("Payment expired", expired/);
});
