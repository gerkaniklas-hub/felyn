import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Static checks of 0034_host_booking_overlap.sql, its isolated test and the host action.
// The SQL itself (overlap rules, locking, concurrency) is exercised against real Postgres:
// see the 0034 README entry.
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = read("supabase", "migrations", "0034_host_booking_overlap.sql");

function sqlFunction(sql: string, header: string): string {
  const from = sql.indexOf(header);
  assert.ok(from >= 0, `${header} not found`);
  const end = sql.indexOf("$fn$;", from);
  return sql.slice(from, end);
}
const lines = (body: string) => body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

test("the isolated test runs section 2 of 0034 verbatim", () => {
  const section = (sql: string, start: string, end: string) => {
    const all = sql.split(/\r?\n/);
    const from = all.findIndex((l) => l.includes(start));
    const to = all.findIndex((l, i) => i > from && l.includes(end));
    return all.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("v_stage :="));
  };
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const isolated = read("supabase", "migrations", "host_booking_overlap_isolated_test.sql");
  assert.ok(body.length > 150);
  assert.deepEqual(section(isolated, "═════════ 1. 0034 BODY", "═════════ 2. SETUP"), body);
});

test("0034 keeps every 0033 guard rule and every 0033 acceptance check", () => {
  const before = lines(sqlFunction(read("supabase", "migrations", "0033_accepted_start_snapshot.sql"), "create or replace function public.booking_request_items_before_update()"));
  const after = lines(sqlFunction(migration, "create or replace function public.booking_request_items_before_update()"));
  for (const line of before.slice(1)) assert.ok(after.includes(line), `0034 dropped 0033 guard line: ${line}`);

  const confirm = sqlFunction(migration, "create or replace function public.booking_item_confirm(p_item_id uuid)");
  for (const clause of [
    "security definer set search_path = ''",
    "v_uid uuid := auth.uid();",
    "and bri.status = 'REQUESTED'",
    "and p.user_id = v_uid",
    "br.status in ('REQUESTED', 'CONFIRMED')",
    "raise exception 'This request has no requested start time' using errcode = '22023';",
    "raise exception 'This experience has no valid duration' using errcode = '22023';",
    "v_start := (v_item.planned_date + v_item.preferred_time) at time zone 'Atlantic/Canary';",
    "accepted_at = now(),",
    "confirmed_start_at = v_start,",
    "duration_minutes = v_item.duration_minutes",
  ]) {
    assert.ok(confirm.includes(clause), `booking_item_confirm lacks: ${clause}`);
  }
});

test("acceptance takes the host lock before re-reading the item and checking for overlaps", () => {
  const confirm = sqlFunction(migration, "create or replace function public.booking_item_confirm(p_item_id uuid)");
  const lock = confirm.indexOf("perform public.booking_host_lock(v_provider);");
  const reread = confirm.indexOf("for update of bri;");
  const overlap = confirm.indexOf("public.booking_host_overlap_exists(v_provider, v_item.id, v_start,");
  const update = confirm.indexOf("update public.booking_request_items bri");
  assert.ok(lock > 0 && lock < reread && reread < overlap && overlap < update, "order must be: lock, re-read, overlap check, update");
  assert.match(confirm, /errcode = '23P01'/);

  const guard = sqlFunction(migration, "create or replace function public.booking_request_items_before_update()");
  const accepting = guard.slice(guard.indexOf("if v_accepting then"), guard.indexOf("elsif new.accepted_at is distinct from old.accepted_at"));
  assert.ok(accepting.includes("perform public.booking_host_lock(v_provider);"), "the guard's backstop must take the same lock");
  assert.ok(accepting.indexOf("booking_host_lock") < accepting.indexOf("booking_host_overlap_exists"));
});

test("one deterministic, namespaced transaction-level lock per host", () => {
  const lock = sqlFunction(migration, "create function public.booking_host_lock(p_provider_id uuid)");
  assert.ok(lock.includes("pg_catalog.pg_advisory_xact_lock("), "must be a transaction-level advisory lock");
  assert.ok(lock.includes("pg_catalog.hashtextextended('felyn.booking_host_acceptance:' || p_provider_id::text, 0)"));
  assert.doesNotMatch(lock, /pg_advisory_lock\(|pg_try_advisory/, "no session-level or non-blocking locks");
});

test("the overlap rule: same host via the experience, half-open intervals, CONFIRMED only, snapshot only", () => {
  const overlap = sqlFunction(migration, "create function public.booking_host_overlap_exists(");
  for (const clause of [
    "join public.experiences e on e.id = o.experience_id",
    "where e.provider_id = p_provider_id",
    "and o.id <> p_item_id",
    "and o.status in ('CONFIRMED')",
    "and o.confirmed_start_at is not null",
    "and o.confirmed_start_at < p_end",
    "and o.confirmed_start_at + o.duration_minutes * interval '1 minute' > p_start",
  ]) {
    assert.ok(overlap.includes(clause), `overlap check lacks: ${clause}`);
  }
  assert.match(overlap, /language sql volatile/, "must see bookings committed while it waited for the lock");
  assert.doesNotMatch(overlap, /\be\.duration_minutes/, "never the experience's current duration (only the o.duration_minutes snapshot)");
  assert.doesNotMatch(overlap, /planned_date|preferred_time/, "never re-derived from the requested time");
});

test("no client can call the helpers, and 0034 grants nothing", () => {
  assert.doesNotMatch(migration, /^\s*grant\b/im);
  assert.ok(migration.includes("revoke execute on function public.booking_host_lock(uuid) from public, anon, authenticated, service_role;"));
  assert.ok(migration.includes("revoke execute on function public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)\n    from public, anon, authenticated, service_role;"));
  assert.match(migration, /create index booking_request_items_accepted_interval_idx\s+on public\.booking_request_items \(experience_id, confirmed_start_at\)\s+where confirmed_start_at is not null;/);
});

test("the host is told clearly when an acceptance overlaps", () => {
  const actions = read("src", "lib", "provider", "actions.ts");
  assert.match(actions, /error\?\.code === "23P01"\) \{\s+return \{ ok: false, error: OVERLAPPING_BOOKING_ERROR \};/);
  assert.match(actions, /OVERLAPPING_BOOKING_ERROR =\s+"This experience overlaps another confirmed booking\./);
});
