import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBookingStartTime, getBookingTimeLabel } from "@/lib/matching/plan";
import { getProviderRequestItems } from "@/lib/provider/dashboard";

// Phase 3: when a host accepts, the database records accepted_at, the requested
// Tenerife start as confirmed_start_at and the experience's duration (0033); the app
// shows the confirmed start and never writes any of them.
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const migration = read("supabase", "migrations", "0033_accepted_start_snapshot.sql");

function sqlFunction(sql: string, header: string): string {
  const from = sql.indexOf(header);
  assert.ok(from >= 0, `${header} not found`);
  return sql.slice(from, sql.indexOf("end $fn$;", from));
}
const lines = (body: string) => body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

test("the displayed start is the confirmed start (Tenerife time, DST-aware) once accepted", () => {
  // 19:00 UTC is 20:00 in Tenerife in summer (WEST) and 19:00 in winter (WET).
  assert.equal(getBookingStartTime({ preferredTime: "20:00", confirmedStartAt: "2027-07-15T19:00:00+00:00" }), "20:00");
  assert.equal(getBookingStartTime({ preferredTime: "19:00", confirmedStartAt: "2027-01-15T19:00:00+00:00" }), "19:00");
  assert.equal(getBookingStartTime({ preferredTime: "08:00", confirmedStartAt: "2027-03-28T07:00:00+00:00" }), "08:00");
});

test("before acceptance, and on bookings accepted before 0033, the requested time is shown as before", () => {
  assert.equal(getBookingStartTime({ preferredTime: "19:30", confirmedStartAt: null }), "19:30");
  const legacy = getBookingStartTime({ preferredTime: null, confirmedStartAt: null });
  assert.equal(legacy, null);
  assert.equal(getBookingTimeLabel("evening", legacy), "Evening · Time not specified");
});

test("host booking data carries the snapshot, and legacy confirmed rows without it still load", async () => {
  const row = (id: string, snapshot: boolean) => ({
    id,
    booking_request_id: "r1",
    experience_id: "e1",
    planned_date: "2027-07-15",
    planned_moment: "evening",
    guest_count: 2,
    price_per_person: 40,
    preferred_time: "20:00:00",
    host_note: null,
    status: "CONFIRMED",
    decline_reason: null,
    decline_note: null,
    decided_at: null,
    created_at: "2026-10-01T10:00:00Z",
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancellation_note: null,
    accepted_at: snapshot ? "2026-10-08T12:00:00Z" : null,
    confirmed_start_at: snapshot ? "2027-07-15T19:00:00+00:00" : null,
    duration_minutes: snapshot ? 120 : null,
  });
  const tables: Record<string, unknown[]> = {
    experiences: [{ id: "e1", title: "Pasta Evening", currency: "EUR" }],
    booking_request_items: [row("accepted", true), row("legacy", false)],
    booking_requests: [{ id: "r1", status: "REQUESTED", stay_id: null }],
  };
  const query = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, ko)
            : () => query(rows),
      },
    );
  const supabase = { from: (t: string) => query(tables[t] ?? []), rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;

  const items = new Map((await getProviderRequestItems(supabase, "p1")).map((i) => [i.itemId, i]));
  const accepted = items.get("accepted")!;
  assert.equal(accepted.confirmedStartAt, "2027-07-15T19:00:00+00:00");
  assert.equal(accepted.acceptedAt, "2026-10-08T12:00:00Z");
  assert.equal(accepted.acceptedDurationMinutes, 120);
  assert.equal(getBookingStartTime(accepted), "20:00");
  const legacy = items.get("legacy")!;
  assert.equal(legacy.confirmedStartAt, null);
  assert.equal(getBookingStartTime(legacy), "20:00", "legacy rows fall back to the requested time");
});

test("0033 keeps 0031's guard and acceptance authorization, and snapshots in Tenerife time", () => {
  const before = lines(sqlFunction(read("supabase", "migrations", "0031_booking_write_hardening.sql"), "create function public.booking_request_items_before_update()"));
  const after = lines(sqlFunction(migration, "create or replace function public.booking_request_items_before_update()"));
  for (const line of before.slice(1)) assert.ok(after.includes(line), `0033 dropped 0031 guard line: ${line}`);

  const confirm = sqlFunction(migration, "create or replace function public.booking_item_confirm(p_item_id uuid)");
  assert.match(confirm, /security definer set search_path = ''/);
  for (const clause of [
    "v_uid uuid := auth.uid();",
    "and bri.status = 'REQUESTED'",
    "and p.user_id = v_uid",
    "br.status in ('REQUESTED', 'CONFIRMED')",
    "for update of bri;",
    "accepted_at = now(),",
    "confirmed_start_at = (bri.planned_date + bri.preferred_time) at time zone 'Atlantic/Canary',",
    "duration_minutes = v_item.duration_minutes",
  ]) {
    assert.ok(confirm.includes(clause), `booking_item_confirm lacks: ${clause}`);
  }
  // The client never supplies the values: the function takes only the item id.
  assert.match(migration, /create or replace function public\.booking_item_confirm\(p_item_id uuid\)\s+returns boolean/);
  // No privilege statement at all: the new columns get none, the functions keep 0031's.
  assert.doesNotMatch(migration, /^\s*(grant|revoke)\b/im, "0033 must not change any privilege");
});

test("the isolated test runs section 2 of 0033 verbatim", () => {
  const section = (sql: string, start: string, end: string) => {
    const all = sql.split(/\r?\n/);
    const from = all.findIndex((l) => l.includes(start));
    const to = all.findIndex((l, i) => i > from && l.includes(end));
    return all.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("v_stage :="));
  };
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const isolated = read("supabase", "migrations", "accepted_start_snapshot_isolated_test.sql");
  assert.ok(body.length > 90);
  assert.deepEqual(section(isolated, "═════════ 1. 0033 BODY", "═════════ 2. SETUP"), body);
});

test("the app never sends the snapshot fields and explains a refused acceptance", () => {
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
      assert.doesNotMatch(payload, /accepted_at|confirmed_start_at|duration_minutes/, `${path.relative(root, file)} sends a snapshot field`);
    }
  }
  const actions = read("src", "lib", "provider", "actions.ts");
  assert.match(actions, /error\?\.code === "22023"\) \{\s+return \{ ok: false, error: UNACCEPTABLE_REQUEST_ERROR \};/);
});

test("after acceptance the start is no longer labelled a preference", () => {
  assert.match(read("src", "app", "bookings", "[itemId]", "page.tsx"), /getBookingTimeLabel\(item\.plannedMoment, getBookingStartTime\(item\)\)/);
  assert.match(read("src", "components", "provider", "ProviderBookingCard.tsx"), /getBookingStartTime\(item\)/);
  assert.match(read("src", "components", "provider", "DayCalendar.tsx"), /event\.preferredTime && event\.status === "REQUESTED" \? " \(preferred\)"/);
  for (const file of [["src", "components", "planner", "RequestedItemCard.tsx"], ["src", "components", "planner", "PlanReview.tsx"]]) {
    const code = read(...file);
    const prefers = code.indexOf("prefers ${");
    assert.ok(prefers > 0, file.join("/"));
    assert.match(code.slice(Math.max(0, prefers - 160), prefers), /"REQUESTED" \|\| [a-z.]*status === "DRAFT"/, `${file.join("/")} labels confirmed times as preferences`);
  }
});
