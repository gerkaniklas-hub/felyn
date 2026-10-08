import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMessagingClosedLabel, getMessagingWindowState } from "@/lib/matching/booking-status";
import { getProviderConversations } from "@/lib/messaging/conversations";
import { getProviderMessagingItems, getProviderRequestItems } from "@/lib/provider/dashboard";

// A guest's WITHDRAWN request stays in the host's Messages as read-only history,
// and nowhere else on the host side.
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");

const HOST = "host-user";
const GUEST = "guest-user";

/** An item row as booking_request_items returns it (only the columns the provider query reads). */
function item(id: string, requestId: string, status: string) {
  return {
    id,
    booking_request_id: requestId,
    experience_id: "exp-1",
    planned_date: "2026-11-01",
    planned_moment: "evening",
    guest_count: 2,
    price_per_person: 40,
    preferred_time: "19:00:00",
    host_note: null,
    status,
    decline_reason: null,
    decline_note: null,
    decided_at: null,
    created_at: "2026-10-01T10:00:00Z",
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancellation_note: null,
  };
}

/**
 * A stand-in for the RLS-scoped Supabase client: every query on a table resolves to that
 * table's rows (filters are the database's job and RLS is covered by the policy checks
 * below; here only the app's own inclusion rules are under test).
 */
function fakeSupabase(tables: Record<string, unknown[]>): SupabaseClient {
  const query = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
          }
          return () => query(rows);
        },
      },
    );
  return {
    from: (table: string) => query(tables[table] ?? []),
    rpc: async () => ({ data: [], error: null }),
    auth: { getUser: async () => ({ data: { user: { id: HOST } } }) },
  } as unknown as SupabaseClient;
}

// r-active: a live request with one item of each status, incl. a single withdrawn item.
// r-withdrawn: a request the guest withdrew as a whole (its item is WITHDRAWN too).
const tables = {
  experiences: [{ id: "exp-1", title: "Pasta Evening", currency: "EUR" }],
  experience_gallery: [],
  booking_requests: [
    { id: "r-active", status: "REQUESTED", stay_id: null },
    { id: "r-withdrawn", status: "WITHDRAWN", stay_id: null },
  ],
  booking_request_items: [
    item("i-requested", "r-active", "REQUESTED"),
    item("i-confirmed", "r-active", "CONFIRMED"),
    item("i-declined", "r-active", "DECLINED"),
    item("i-withdrawn", "r-active", "WITHDRAWN"),
    item("i-withdrawn-whole", "r-withdrawn", "WITHDRAWN"),
  ],
  stays: [],
  stay_occasions: [],
  stay_dietary_requirements: [],
  messages: ["i-requested", "i-confirmed", "i-withdrawn", "i-withdrawn-whole"].map((itemId, i) => ({
    id: `m-${i}`,
    booking_request_item_id: itemId,
    sender_id: GUEST,
    body: `Hello about ${itemId}`,
    created_at: `2026-10-0${i + 2}T10:00:00Z`,
    read_at: null,
  })),
};

test("host booking surfaces (Requests, Dashboard, Calendar, request detail) never get WITHDRAWN items", async () => {
  const items = await getProviderRequestItems(fakeSupabase(tables), "provider-1");
  assert.deepEqual(items.map((i) => i.itemId).sort(), ["i-confirmed", "i-declined", "i-requested"]);
  assert.ok(items.every((i) => (i.status as string) !== "WITHDRAWN"));
});

test("host Messages data keeps WITHDRAWN items (single item and whole request) next to the active ones", async () => {
  const items = await getProviderMessagingItems(fakeSupabase(tables), "provider-1");
  const statusById = Object.fromEntries(items.map((i) => [i.itemId, i.status]));
  assert.deepEqual(statusById, {
    "i-requested": "REQUESTED",
    "i-confirmed": "CONFIRMED",
    "i-declined": "DECLINED",
    "i-withdrawn": "WITHDRAWN",
    "i-withdrawn-whole": "WITHDRAWN",
  });
});

test("the host inbox lists withdrawn conversations as read-only and active ones as open", async () => {
  const conversations = await getProviderConversations(fakeSupabase(tables), "provider-1");
  const byId = new Map(conversations.map((c) => [c.itemId, c]));
  // Only items with messages are conversations; all four of them are listed.
  assert.deepEqual([...byId.keys()].sort(), ["i-confirmed", "i-requested", "i-withdrawn", "i-withdrawn-whole"]);
  for (const id of ["i-withdrawn", "i-withdrawn-whole"]) {
    const c = byId.get(id)!;
    assert.equal(c.itemStatus, "WITHDRAWN");
    assert.equal(c.lastMessage?.body, `Hello about ${id}`, "the existing messages stay readable");
    const window = getMessagingWindowState(c.itemStatus, c.decidedAt, c.cancelledAt);
    assert.equal(window.canSend, false, `${id} must be read-only`);
    assert.ok(getMessagingClosedLabel(c.itemStatus, window));
  }
  for (const id of ["i-requested", "i-confirmed"]) {
    const c = byId.get(id)!;
    assert.equal(getMessagingWindowState(c.itemStatus, c.decidedAt, c.cancelledAt).canSend, true, `${id} must stay open`);
  }
});

test("only host Messages uses the withdrawn-inclusive data; booking pages keep getProviderRequestItems", () => {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
  })(path.join(root, "src"));
  const users = files
    .filter((f) => readFileSync(f, "utf8").includes("getProviderMessagingItems("))
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(users, ["src/lib/messaging/conversations.ts", "src/lib/provider/dashboard.ts"]);
  for (const page of [
    ["src", "app", "provider", "page.tsx"],
    ["src", "app", "provider", "requests", "page.tsx"],
    ["src", "app", "provider", "requests", "[itemId]", "page.tsx"],
    ["src", "app", "provider", "calendar", "page.tsx"],
  ]) {
    assert.match(read(...page), /getProviderRequestItems\(supabase, identity\.id\)/, `${page.join("/")} changed its data source`);
  }
});

test("the database blocks sending on WITHDRAWN for guest and host, and still allows reading", () => {
  // 0021 holds the current INSERT policies; 0014 the SELECT (read) policies, never replaced.
  const insertPolicies = read("supabase", "migrations", "0021_post_decision_messaging_windows.sql");
  for (const name of ["Guests send messages on their own active items", "Providers send messages on their own active items"]) {
    const start = insertPolicies.indexOf(`create policy "${name}"`);
    assert.ok(start >= 0, `${name} not found`);
    const policy = insertPolicies.slice(start, insertPolicies.indexOf(");\n", start));
    assert.match(policy, /for insert to authenticated/);
    assert.match(policy, /bri\.status in \('REQUESTED', 'CONFIRMED'\)/);
    assert.doesNotMatch(policy, /WITHDRAWN/, `${name} must never allow a WITHDRAWN item`);
  }
  const later = readdirSync(path.join(root, "supabase", "migrations")).filter((f) => /^\d{4}_/.test(f) && f.slice(0, 4) > "0021");
  for (const file of later) {
    assert.doesNotMatch(read("supabase", "migrations", file), /policy[^;]*on public\.messages/i, `${file} changes messages policies`);
  }
  const readPolicies = read("supabase", "migrations", "0014_guest_host_messaging.sql");
  for (const name of ["Guests view messages for their own items", "Providers view messages for their experiences"]) {
    const start = readPolicies.indexOf(`create policy "${name}"`);
    const policy = readPolicies.slice(start, readPolicies.indexOf(");\n", start));
    assert.match(policy, /for select to authenticated/);
    assert.doesNotMatch(policy, /status/, `${name} must not depend on the booking status`);
  }
});

test("the host inbox marks withdrawn conversations and replaces the composer with a read-only note", () => {
  const inbox = read("src", "components", "messaging", "HostInbox.tsx");
  assert.ok(inbox.includes('c.itemStatus === "WITHDRAWN" ? `Withdrawn request · ${c.experienceTitle}`'));
  assert.match(inbox, /subtitleMuted=\{[^}]*c\.itemStatus === "WITHDRAWN"/);
  assert.match(inbox, /selected\.itemStatus === "WITHDRAWN" \? null : \(\s*<Link href=\{selected\.bookingHref\}/);
  assert.ok(inbox.includes('"The guest withdrew this request. This conversation is read-only."'));
  // The composer is only rendered when the shared window state allows sending.
  assert.match(read("src", "components", "messaging", "MessageThread.tsx"), /\{canSend \? \(\s*<ThreadComposer/);
});

test("guest messaging rules are unchanged: open while active, closed once withdrawn", () => {
  assert.equal(getMessagingWindowState("REQUESTED", null, null).canSend, true);
  assert.equal(getMessagingWindowState("CONFIRMED", null, null).canSend, true);
  const withdrawn = getMessagingWindowState("WITHDRAWN", null, null);
  assert.equal(withdrawn.canSend, false);
  assert.equal(getMessagingClosedLabel("WITHDRAWN", withdrawn), "This booking was withdrawn — the conversation is closed.");
});
