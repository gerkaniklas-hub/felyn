import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  formatActivityTime,
  getCustomerDisplayName,
  getCustomerShortName,
  getRequesterRoleLabel,
  getStaffReplyMode,
  parseStatusFilter,
} from "@/lib/support/admin-format";
import { SUPPORT_ERROR_CODES } from "@/lib/support/constants";
import { getStaffSupportErrorMessage } from "@/lib/support/errors";
import { getSupportSubtitle } from "@/lib/support/inbox";
import { GUEST_ROUTE_PREFIXES } from "@/lib/journey";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
function filesUnder(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

// ── staff route authorization (static audit of the code paths) ──

test("every /admin page and layout requires staff before doing anything", () => {
  const files = filesUnder(path.join("src", "app", "admin")).filter((f) => /(page|layout)\.tsx$/.test(f));
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), ["layout.tsx", "page.tsx", "page.tsx"]);
  for (const file of files) {
    const code = read(file);
    assert.match(code, /await requireStaff\(\)/, `${file} must call requireStaff()`);
    // requireStaff comes before any data access in the component body.
    const body = code.slice(code.indexOf("export default async function"));
    const first = body.search(/await (requireStaff|getStaff|supabase|params|searchParams)/);
    assert.equal(body.slice(first, first + "await requireStaff()".length).includes("requireStaff"), true, `${file}: requireStaff first`);
  }
});

test("every staff Server Action checks staff status itself and writes only through database functions", () => {
  const code = read("src", "lib", "support", "admin-actions.ts");
  assert.match(code, /^"use server";/);
  const fns = code.split(/\nexport async function /).slice(1);
  assert.equal(fns.length, 4);
  for (const fn of fns) {
    const name = fn.slice(0, fn.indexOf("("));
    assert.match(fn, /const staff = await getStaffContext\(\);\s+if \(!staff/, `${name} must check staff first`);
  }
  assert.doesNotMatch(code, /\.from\(/, "no direct table access from staff actions");
  for (const rpc of ["support_staff_reply", "support_staff_set_status", "support_mark_read"]) assert.match(code, new RegExp(`rpc\\("${rpc}"`));
});

test("no service-role key, no hardcoded email address, no direct support writes anywhere in support code", () => {
  const files = [
    ...filesUnder(path.join("src", "app", "admin")),
    ...filesUnder(path.join("src", "lib", "support")),
    ...filesUnder(path.join("src", "components", "support")),
  ];
  for (const file of files) {
    const code = read(file);
    assert.doesNotMatch(code, /supabase\/admin|createSupabaseAdminClient|SUPABASE_SECRET_KEY|service_role/, file);
    assert.doesNotMatch(code, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${file} must not contain an email address`);
    assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/, `${file} must not write support tables directly`);
  }
});

test("/admin is sign-in protected, not a guest route, and not in the guest navigation", () => {
  assert.match(read("src", "proxy.ts"), /"\/admin",/);
  assert.ok(!GUEST_ROUTE_PREFIXES.includes("/admin"), "host-journey staff must not be redirected away");
  assert.doesNotMatch(read("src", "components", "navigation", "GuestNav.tsx"), /\/admin/);
  // The only link in the guest app is staff-gated on the profile page.
  const profile = read("src", "app", "profile", "page.tsx");
  assert.match(profile, /\{isStaff \? \(\s*<Link\s+href="\/admin\/support"/);
});

test("staff land in the support inbox: after login and on /home, decided by the database check", () => {
  const login = read("src", "app", "login", "actions.ts");
  const staffCheck = login.indexOf("if (await isFelynStaff(supabase)) redirect(\"/admin/support\");");
  assert.ok(staffCheck > 0, "login redirects staff to /admin/support");
  assert.ok(staffCheck > login.indexOf("signInWithPassword"), "only after a successful sign-in");
  assert.ok(staffCheck < login.indexOf("let hasMobile"), "before the guest/host mobile step");
  // Guest and host destinations are unchanged.
  assert.match(login, /const ALLOWED_REDIRECTS = new Set\(\["\/home", "\/provider", "\/host\/apply"\]\);/);

  const home = read("src", "app", "home", "page.tsx");
  assert.match(home, /user \? isFelynStaff\(supabase\) : false/);
  assert.match(home, /if \(isStaff\) redirect\("\/admin\/support"\);/);

  // One staff check (staff.ts) and no email address.
  for (const source of [login, home]) {
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");
    assert.match(code, /from "@\/lib\/support\/staff"/);
    assert.doesNotMatch(code, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(code, /staff_members|is_felyn_staff/, "no second copy of the staff check");
  }
  // The staff workspace is self-contained: its only link is its own logo -> /admin/support.
  const layout = read("src", "app", "admin", "layout.tsx");
  assert.deepEqual([...layout.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["/admin/support"]);
  assert.doesNotMatch(layout, /Back to Felyn/);
  // …plus "Log out", through the app's existing logout Server Action (no new auth mechanism).
  assert.match(layout, /import \{ logout \} from "@\/app\/home\/actions";/);
  assert.match(layout, /<form action=\{logout\}[^>]*>\s*<button\s+type="submit"[\s\S]*?Log out\s*<\/button>/);
  assert.doesNotMatch(layout, /signOut\(/, "no second sign-out implementation");
});

// ── list / detail presentation ──

test("customer names: full name, else email, else a neutral word — never an id", () => {
  assert.equal(getCustomerDisplayName({ firstName: "Niklas", lastName: "Gerka", email: "x" }), "Niklas Gerka");
  assert.equal(getCustomerDisplayName({ firstName: "Niklas", lastName: null, email: "x" }), "Niklas");
  assert.equal(getCustomerDisplayName({ firstName: null, lastName: null, email: "guest@example.test" }), "guest@example.test");
  assert.equal(getCustomerDisplayName({ firstName: null, lastName: null, email: null }), "Customer");
  assert.equal(getCustomerShortName(" Maria ", "guest"), "Maria");
  assert.equal(getCustomerShortName(null, "guest"), "Guest");
  assert.equal(getCustomerShortName(null, "host"), "Host");
  assert.equal(getRequesterRoleLabel("host"), "Host");
});

test("activity time: today, yesterday, this year, older", () => {
  const now = new Date(2026, 9, 5, 21, 0);
  assert.equal(formatActivityTime(new Date(2026, 9, 5, 20, 14).toISOString(), now), "Today, 20:14");
  assert.equal(formatActivityTime(new Date(2026, 9, 4, 9, 30).toISOString(), now), "Yesterday, 09:30");
  assert.equal(formatActivityTime(new Date(2026, 9, 12 - 7, 9).toISOString(), new Date(2026, 9, 12)), "Mon 5 Oct");
  assert.equal(formatActivityTime(new Date(2025, 9, 12).toISOString(), now), "12 Oct 2025");
});

test("status filter defaults to Open and accepts only the three statuses", () => {
  assert.equal(parseStatusFilter(undefined), "OPEN");
  assert.equal(parseStatusFilter("resolved"), "RESOLVED");
  assert.equal(parseStatusFilter("CLOSED"), "CLOSED");
  assert.equal(parseStatusFilter("pending"), "OPEN");
  assert.equal(parseStatusFilter("'; drop table"), "OPEN");
});

test("reply area mirrors the database: reply while open or resolved, reopen first when closed", () => {
  assert.equal(getStaffReplyMode("OPEN"), "reply");
  assert.equal(getStaffReplyMode("RESOLVED"), "reply-resolved");
  assert.equal(getStaffReplyMode("CLOSED"), "reopen-required");
});

test("staff list subtitle works from 'is a booking' alone", () => {
  assert.equal(getSupportSubtitle({ category: "booking", isBooking: true, experienceTitle: "Dinner Experience" }), "Booking · Dinner Experience");
  assert.equal(getSupportSubtitle({ category: "payment", isBooking: false, experienceTitle: null }), "Payment");
  assert.equal(getSupportSubtitle({ category: "booking", bookingItemId: "x", experienceTitle: null }), "Booking · Your booking");
});

test("staff error messages are friendly and specific", () => {
  assert.equal(getStaffSupportErrorMessage(SUPPORT_ERROR_CODES.CLOSED), "This conversation is closed. Reopen it to reply.");
  assert.match(getStaffSupportErrorMessage(SUPPORT_ERROR_CODES.ALREADY_OPEN), /another open conversation/);
  assert.match(getStaffSupportErrorMessage(SUPPORT_ERROR_CODES.NOT_ALLOWED), /access to Felyn Support/);
  assert.equal(getStaffSupportErrorMessage("PGRST202"), "Something went wrong. Please try again.");
});
