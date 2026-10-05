import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_REQUESTER_ROLES,
  SUPPORT_SENDER_TYPES,
  SUPPORT_STATUSES,
  isSupportCategory,
} from "@/lib/support/constants";

// Static checks of 0029_support.sql and its isolated test (neither is run by tests).
const migrations = path.resolve(import.meta.dirname, "..", "supabase", "migrations");
const migration = readFileSync(path.join(migrations, "0029_support.sql"), "utf8");
const isolatedTest = readFileSync(path.join(migrations, "support_isolated_test.sql"), "utf8");

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

/** The quoted values of a `check (column in (...))` constraint, in order. */
function checkValues(constraintName: string): string[] {
  const match = migration.match(new RegExp(`constraint ${constraintName} check \\(\\w+ in\\s*\\(([^)]*)\\)`));
  assert.ok(match, `constraint ${constraintName} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test("the isolated test runs section 2 of 0029 verbatim", () => {
  const body = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  const copy = section(isolatedTest, "═════════ 1. 0029 BODY", "═════════ 2. SETUP ═════════");
  assert.ok(body.length > 100);
  assert.deepEqual(copy, body);
});

test("TypeScript constants match the database check constraints", () => {
  assert.deepEqual(checkValues("support_threads_category_check"), [...SUPPORT_CATEGORIES]);
  assert.deepEqual(checkValues("support_threads_status_check"), [...SUPPORT_STATUSES]);
  assert.deepEqual(checkValues("support_threads_requester_role_check"), [...SUPPORT_REQUESTER_ROLES]);
  assert.deepEqual(checkValues("support_messages_sender_type_check"), [...SUPPORT_SENDER_TYPES]);
  assert.deepEqual(checkValues("staff_members_role_check"), ["support", "admin"]);
});

test("support_open_thread validates the same categories as the table", () => {
  const fn = migration.slice(migration.indexOf("create function public.support_open_thread("));
  const list = fn.match(/p_category not in\s*\(([^)]*)\)/);
  assert.ok(list);
  assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...SUPPORT_CATEGORIES]);
});

test("realtime: both support tables are published, messages is untouched, and the thread subscribes to both", () => {
  const code = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const published = [...code.matchAll(/alter publication supabase_realtime add table public\.(\w+);/g)].map((m) => m[1]);
  assert.deepEqual(published, ["support_messages", "support_threads"]);
  assert.doesNotMatch(code, /alter publication supabase_realtime (drop|set)/);
  // The end-state check verifies both, so a missing one rolls the migration back.
  const post = section(migration, "═════════ 3. POSTCONDITIONS", "$migration$;").join("\n");
  assert.match(post, /tablename = 'support_messages'/);
  assert.match(post, /tablename = 'support_threads'/);

  // Both conversation views (guest SupportThread, staff ticket) use one shared hook.
  const support = path.resolve(import.meta.dirname, "..", "src", "components", "support");
  const hook = readFileSync(path.join(support, "useSupportThreadRealtime.ts"), "utf8");
  assert.match(hook, /event: "INSERT", schema: "public", table: "support_messages", filter: `support_thread_id=eq\.\$\{threadId\}`/);
  assert.match(hook, /event: "UPDATE", schema: "public", table: "support_threads", filter: `id=eq\.\$\{threadId\}`/);
  // Two separate channels, so a status-channel problem can't affect message delivery.
  assert.match(hook, /\.channel\(`support_messages:/);
  assert.match(hook, /\.channel\(`support_threads:/);
  for (const user of ["SupportThread.tsx", path.join("admin", "StaffTicketWorkspace.tsx")]) {
    assert.match(readFileSync(path.join(support, user), "utf8"), /useSupportThreadRealtime\(threadId,/, user);
  }
});

test("isSupportCategory accepts database slugs only", () => {
  assert.ok(isSupportCategory("technical_issue"));
  assert.ok(!isSupportCategory("Technical issue"));
  assert.ok(!isSupportCategory(""));
});

test("clients get read-only table access and no email address appears", () => {
  const code = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(code, /grant\s+(insert|update|delete|all)[^;]*\bsupport_(threads|messages)\b/i);
  assert.doesNotMatch(code, /grant[^;]*\bstaff_members\b/i);
  assert.doesNotMatch(migration, /[\w.+-]+@[\w-]+\.[\w.]+/);
  assert.doesNotMatch(
    code,
    /\b(on|table|into|update|from)\s+public\.messages\b/i,
    "0029 must not act on the guest<->host messages table",
  );
  assert.doesNotMatch(code, /drop\s+table|drop\s+policy|drop\s+trigger/i);
});
