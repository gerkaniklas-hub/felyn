import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DECLINE_REASONS, GUEST_CANCEL_REASONS, PROVIDER_CANCEL_REASONS } from "@/lib/matching/booking-status";

// Static checks of 0031_booking_write_hardening.sql, its isolated test, and the app code
// that writes bookings (the SQL itself is not run by `npm test`).
const root = path.resolve(import.meta.dirname, "..");
const migrations = path.join(root, "supabase", "migrations");
const migration = readFileSync(path.join(migrations, "0031_booking_write_hardening.sql"), "utf8");
const isolatedTest = readFileSync(path.join(migrations, "booking_write_hardening_isolated_test.sql"), "utf8");

/** Lines strictly between the first line containing `start` and the next containing `end`, trimmed, blank lines dropped. */
function section(sql: string, start: string, end: string): string[] {
  const lines = sql.split(/\r?\n/);
  const from = lines.findIndex((line) => line.includes(start));
  const to = lines.findIndex((line, i) => i > from && line.includes(end));
  assert.ok(from >= 0 && to > from, `markers "${start}" / "${end}" not found`);
  return lines
    .slice(from + 1, to)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("v_stage :="));
}

/** The body of one `create function public.<name>(` in the migration, up to its closing `$fn$;`. */
function functionBody(name: string): string {
  const start = migration.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  return migration.slice(start, migration.indexOf("$fn$;", start));
}

/** The quoted values of the `p_reason not in (...)` list in one function. */
function reasonList(name: string): string[] {
  const match = functionBody(name).match(/p_reason not in\s*\(([^)]*)\)/);
  assert.ok(match, `reason list of ${name} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Every .ts/.tsx file under src/. */
function sourceFiles(dir = path.join(root, "src")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

test("the isolated test runs section 2 of 0031 verbatim", () => {
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const copy = section(isolatedTest, "═════════ 1. 0031 BODY", "═════════ 2. SETUP ═════════");
  assert.ok(body.length > 200);
  assert.deepEqual(copy, body);
});

test("the database reason lists match the app's", () => {
  assert.deepEqual(reasonList("booking_item_decline"), DECLINE_REASONS.map((r) => r.value));
  assert.deepEqual(reasonList("booking_item_cancel_as_guest"), GUEST_CANCEL_REASONS.map((r) => r.value));
  assert.deepEqual(reasonList("booking_item_cancel_as_host"), PROVIDER_CANCEL_REASONS.map((r) => r.value));
});

test("every booking transition function checks the signed-in user and the current state", () => {
  const guards: Record<string, string> = {
    booking_item_withdraw: "bri.status = 'REQUESTED'",
    booking_item_confirm: "bri.status = 'REQUESTED'",
    booking_item_decline: "bri.status = 'REQUESTED'",
    booking_item_cancel_as_guest: "bri.status = 'CONFIRMED'",
    booking_item_cancel_as_host: "bri.status = 'CONFIRMED'",
    booking_request_withdraw: "br.status in ('REQUESTED', 'CONFIRMED')",
  };
  for (const [name, stateGuard] of Object.entries(guards)) {
    const body = functionBody(name);
    assert.match(body, /security definer set search_path = ''/, `${name} is not SECURITY DEFINER with an empty search_path`);
    assert.match(body, /v_uid uuid := auth\.uid\(\);/, `${name} does not read auth.uid()`);
    assert.ok(body.includes(stateGuard), `${name} does not guard on ${stateGuard}`);
    assert.ok(migration.includes(`grant execute on function public.${name}(`), `${name} is not granted to authenticated`);
  }
  // Host transitions check the experience's provider; guest transitions the request's owner.
  for (const name of ["booking_item_confirm", "booking_item_decline", "booking_item_cancel_as_host"]) {
    assert.ok(functionBody(name).includes("p.user_id = v_uid"), `${name} does not check the host`);
  }
  for (const name of ["booking_item_withdraw", "booking_item_cancel_as_guest", "booking_request_withdraw"]) {
    assert.ok(functionBody(name).includes("user_id = v_uid"), `${name} does not check the guest`);
  }
});

test("whole-request withdrawal withdraws the request's REQUESTED items in the same function", () => {
  const body = functionBody("booking_request_withdraw");
  assert.match(body, /update public\.booking_requests br\s+set status = 'WITHDRAWN'/);
  assert.match(body, /update public\.booking_request_items bri\s+set status = 'WITHDRAWN'\s+where bri\.booking_request_id = p_request_id\s+and bri\.status = 'REQUESTED'/);
});

test("clients get no UPDATE on either booking table and INSERT only on the request columns", () => {
  assert.ok(migration.includes("grant insert (user_id, stay_id) on public.booking_requests to authenticated;"));
  assert.ok(
    migration.includes(
      "grant insert (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, host_note)\n    on public.booking_request_items to authenticated;",
    ),
  );
  const grants = migration.match(/grant [^;]+ on public\.booking_request(s|_items)\b[^;]*;/g) ?? [];
  for (const grant of grants) assert.doesNotMatch(grant, /\bupdate\b/i, `unexpected grant: ${grant}`);
  assert.match(functionBody("booking_request_items_before_insert"), /new\.price_per_person := v_exp\.price_per_person;/);
});

test("the app calls only transition functions that 0031 defines", () => {
  const calls = sourceFiles()
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\.rpc\("(booking_[a-z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(calls)].sort(), [
    "booking_item_cancel_as_guest",
    "booking_item_cancel_as_host",
    "booking_item_confirm",
    "booking_item_decline",
    "booking_item_withdraw",
    "booking_request_withdraw",
  ]);
  for (const name of calls) assert.ok(migration.includes(`create function public.${name}(`), `${name} is not defined in 0031`);
});

test("no app code writes booking columns that 0031 makes database-only", () => {
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const match of code.matchAll(/from\("booking_request(?:s|_items)"\)\s*\.(update|upsert)\(/g)) {
      assert.fail(`${rel} still calls .${match[1]}() on a booking table`);
    }
    assert.doesNotMatch(code, /from\("booking_request_items"\)\s*\.delete\(/, `${rel} deletes booking items directly`);
    // What is passed to .insert(): up to the end of the statement or the chained .select(.
    for (const match of code.matchAll(/from\("booking_request(?:s|_items)"\)\s*\.insert\(/g)) {
      const rest = code.slice(match.index + match[0].length);
      const payload = rest.slice(0, Math.min(...[rest.indexOf(".select("), rest.indexOf(";")].filter((i) => i >= 0)));
      assert.doesNotMatch(payload, /price_per_person|estimated_total|status/, `${rel} inserts a database-only column: ${payload}`);
    }
  }
  // The planner's item rows are built by insertRows(), which must list only the client columns.
  const planner = readFileSync(path.join(root, "src", "lib", "matching", "booking-requests.ts"), "utf8");
  const insertRows = planner.slice(planner.indexOf("const insertRows ="), planner.indexOf("}));", planner.indexOf("const insertRows =")));
  assert.ok(insertRows.includes("booking_request_id: bookingRequestId"));
  assert.doesNotMatch(insertRows, /price_per_person|status|\.\.\.row/);
});
