import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  canaryLocalDateTime,
  canaryLocalToInstant,
  canaryToday,
  isFarEnoughAhead,
  MIN_REQUEST_LEAD_MINUTES,
} from "@/lib/matching/canary-time";
import type { MatchedExperience } from "@/lib/matching/hard-filter";
import {
  getLatestStart,
  getRequestedStartError,
  getTimeOptions,
  isAvailableAt,
  MOMENT_RANGES,
} from "@/lib/matching/slot-availability";

// Phase 2: a requested start is required, fits the moment with the experience's
// duration, and is at least 4 hours ahead in Tenerife time — in the app (both
// request paths, both pickers) and in the database (0032).
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

type Window = MatchedExperience["availability"][number];
function experience(durationMinutes: number, windows: Partial<Window>[] = [{}]) {
  return {
    title: "Pasta Evening",
    duration_minutes: durationMinutes,
    availability: windows.map((w) => ({
      available_from: "2026-01-01",
      available_until: "2030-12-31",
      start_time: null,
      end_time: null,
      max_bookings: null,
      ...w,
    })) as Window[],
  };
}
const TWO_HOURS = experience(120);
const ONE_HOUR = experience(60);
const FAR_PAST_NOW = utc(2026, 1, 1, 0); // "now" long before the dates used below

test("Canary local time converts to real instants with the zone's own DST (no fixed offset)", () => {
  assert.equal(canaryLocalToInstant("2026-07-15", "20:00"), utc(2026, 7, 15, 19)); // WEST, UTC+1
  assert.equal(canaryLocalToInstant("2026-01-15", "19:00"), utc(2026, 1, 15, 19)); // WET, UTC+0
  assert.equal(canaryLocalToInstant("2026-03-29", "08:00"), utc(2026, 3, 29, 7)); // after spring-forward
  assert.equal(canaryLocalToInstant("2026-03-28", "08:00"), utc(2026, 3, 28, 8)); // the day before
  assert.equal(canaryLocalToInstant("2026-10-25", "07:00"), utc(2026, 10, 25, 7)); // after fall-back
  assert.equal(canaryLocalToInstant("2026-10-24", "07:00"), utc(2026, 10, 24, 6)); // the day before
});

test("Tenerife's date and clock are read in Atlantic/Canary, not the server's zone", () => {
  // 23:30 UTC in summer is already the next day in Tenerife.
  assert.deepEqual(canaryLocalDateTime(utc(2026, 7, 15, 23, 30)), { date: "2026-07-16", time: "00:30" });
  assert.equal(canaryToday(utc(2026, 7, 15, 23, 30)), "2026-07-16");
  assert.deepEqual(canaryLocalDateTime(utc(2026, 1, 15, 23, 30)), { date: "2026-01-15", time: "23:30" });
});

test("4-hour rule: exact boundaries in summer, winter and on both DST switch days; the past is refused", () => {
  assert.equal(MIN_REQUEST_LEAD_MINUTES, 240);
  const cases: [string, string, number, boolean][] = [
    ["2026-07-15", "20:00", utc(2026, 7, 15, 15), true], // 16:00 WEST + 4 h
    ["2026-07-15", "19:30", utc(2026, 7, 15, 15), false], // a UTC-based rule would accept this
    ["2026-01-15", "19:00", utc(2026, 1, 15, 15), true], // 15:00 WET + 4 h (a fixed UTC+1 rule would refuse)
    ["2026-01-15", "18:30", utc(2026, 1, 15, 15), false],
    ["2026-03-29", "08:00", utc(2026, 3, 29, 3), true],
    ["2026-03-29", "07:30", utc(2026, 3, 29, 3), false],
    ["2026-10-25", "07:00", utc(2026, 10, 25, 3), true],
    ["2026-10-25", "07:00", utc(2026, 10, 25, 3, 1), false],
    ["2026-07-14", "20:00", utc(2026, 7, 15, 15), false], // yesterday
  ];
  for (const [date, time, now, ok] of cases) {
    assert.equal(isFarEnoughAhead(date, time, now), ok, `${date} ${time}`);
  }
});

test("offered start times fit the whole experience inside the moment (30-minute grid kept)", () => {
  const twoHourEvening = getTimeOptions(TWO_HOURS, "2027-05-05", "evening");
  assert.deepEqual(twoHourEvening, ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"]);
  assert.equal(getLatestStart(TWO_HOURS, "evening"), "20:00");
  assert.equal(getTimeOptions(ONE_HOUR, "2027-05-05", "evening")?.at(-1), "21:00");
  assert.equal(getTimeOptions(experience(360), "2027-05-05", "morning"), null, "6 hours never fit a 5-hour moment");
  assert.equal(isAvailableAt(experience(360), "2027-05-05", "morning"), false);
});

test("with a 'now', only starts at least 4 hours ahead are offered, and a moment with none is unavailable", () => {
  const now = utc(2026, 7, 15, 15); // 16:00 in Tenerife
  assert.deepEqual(getTimeOptions(TWO_HOURS, "2026-07-15", "evening", now), ["20:00"]);
  assert.equal(isAvailableAt(TWO_HOURS, "2026-07-15", "afternoon", now), false);
  assert.equal(isAvailableAt(TWO_HOURS, "2026-07-16", "morning", now), true);
});

test("availability windows still decide the date and (by their hours) the moment", () => {
  const windowed = experience(60, [{ start_time: "09:00:00", end_time: "11:00:00" }]);
  assert.ok(getTimeOptions(windowed, "2027-05-05", "morning"));
  assert.equal(getTimeOptions(windowed, "2027-05-05", "evening"), null);
  assert.equal(getTimeOptions(TWO_HOURS, "2031-01-10", "evening"), null, "after every window");
});

test("the request validator: required, inside the moment, fits, available, 4 hours ahead", () => {
  const check = (date: string, moment: "morning" | "afternoon" | "evening", time: string | null, now = FAR_PAST_NOW, exp = TWO_HOURS) =>
    getRequestedStartError(exp, date, moment, time, now);
  assert.match(check("2027-05-05", "evening", null) ?? "", /Choose a start time/);
  assert.match(check("2027-05-05", "evening", "16:30") ?? "", /isn't in the evening/);
  assert.match(check("2027-05-05", "evening", "20:30") ?? "", /latest start in the evening is 20:00/);
  assert.match(check("2027-05-05", "evening", "21:00") ?? "", /latest start in the evening is 20:00/);
  assert.equal(check("2027-05-05", "evening", "20:00"), null);
  assert.equal(check("2027-05-05", "evening", "21:00", FAR_PAST_NOW, ONE_HOUR), null);
  assert.match(check("2031-01-10", "evening", "19:00") ?? "", /isn't available on that date/);
  assert.match(check("2026-07-15", "evening", "19:30", utc(2026, 7, 15, 15)) ?? "", /at least 4 hours/);
  assert.equal(check("2026-07-15", "evening", "20:00", utc(2026, 7, 15, 15)), null);
  assert.match(check("2026-07-14", "evening", "20:00", utc(2026, 7, 15, 15)) ?? "", /at least 4 hours/);
});

test("both request paths apply the same validator with one 'now' and map a database refusal", () => {
  for (const file of [
    ["src", "lib", "matching", "request-experience.ts"],
    ["src", "lib", "matching", "booking-requests.ts"],
  ]) {
    const code = read(...file);
    const name = file.join("/");
    assert.match(code, /getRequestedStartError\(experience, item\.plannedDate, item\.plannedMoment, item\.preferredTime, now\)/, name);
    assert.match(code, /const now = Date\.now\(\);/, name);
    assert.match(code, /code === "22023"\) return \{ ok: false, error: START_REFUSED_ERROR \}/, name);
    assert.doesNotMatch(code, /isPreferredTimeAllowed|preferredTime != null/, `${name} still treats the time as optional`);
  }
  assert.match(read("src", "lib", "matching", "request-experience.ts"), /item\.plannedDate < canaryToday\(now\)/);
});

test("0032 mirrors the app's moments and lead time, keeps every 0031 insert check, and is tested verbatim", () => {
  const migration = read("supabase", "migrations", "0032_requested_start_rules.sql");
  const isolated = read("supabase", "migrations", "requested_start_rules_isolated_test.sql");
  assert.match(
    migration,
    new RegExp(
      `when 'morning' then ${MOMENT_RANGES.morning.start} when 'afternoon' then ${MOMENT_RANGES.afternoon.start} when 'evening' then ${MOMENT_RANGES.evening.start}`,
    ),
  );
  for (const range of Object.values(MOMENT_RANGES)) assert.equal(range.end - range.start, 300);
  assert.ok(migration.includes("v_moment_end := v_moment_start + 300;"));
  assert.ok(migration.includes(`< p_now + interval '${MIN_REQUEST_LEAD_MINUTES / 60} hours'`));
  assert.ok(migration.includes("(p_date + p_time) at time zone 'Atlantic/Canary'"));
  assert.ok(migration.includes("new.experience_id, new.planned_date, new.planned_moment, new.preferred_time, now());"));

  // Every line of 0031's insert guard is still in 0032's replacement.
  const body = (sql: string, start: string) => {
    const from = sql.indexOf(start);
    return sql.slice(from, sql.indexOf("end $fn$;", from)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  };
  const before = body(read("supabase", "migrations", "0031_booking_write_hardening.sql"), "create function public.booking_request_items_before_insert()");
  const after = body(migration, "create or replace function public.booking_request_items_before_insert()");
  for (const line of before.slice(1)) assert.ok(after.includes(line), `0032 dropped 0031 line: ${line}`);

  const section = (sql: string, start: string, end: string) => {
    const lines = sql.split(/\r?\n/);
    const from = lines.findIndex((l) => l.includes(start));
    const to = lines.findIndex((l, i) => i > from && l.includes(end));
    return lines.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("v_stage :="));
  };
  const original = section(migration, "═════════ 2. MIGRATION ═════════", "═════════ 3. POSTCONDITIONS");
  assert.ok(original.length > 60);
  assert.deepEqual(section(isolated, "═════════ 1. 0032 BODY", "═════════ 2. SETUP ═════════"), original);
});

test("both pickers require a start time, offer only valid ones, and re-check on submit", () => {
  for (const file of [
    ["src", "components", "booking", "RequestExperienceModal.tsx"],
    ["src", "components", "planner", "ExperienceConfigModal.tsx"],
  ]) {
    const code = read(...file);
    const name = file.join("/");
    assert.doesNotMatch(code, /No preference|\(optional\)<\/span>\s*<\/label>\s*<select/, `${name} still offers "no preference"`);
    assert.match(code, />\s*Start time\s*</, name);
    assert.match(code, /<option value="" disabled>\s*Choose a start time\s*<\/option>/, name);
    assert.match(code, /getTimeOptions\(experience, [^)]*, now\)/, `${name} doesn't apply the 4-hour rule to the options`);
    assert.match(code, /getRequestedStartError\([^)]*readClock\(\)\)/, `${name} doesn't re-check the time on submit`);
  }
  assert.match(read("src", "components", "planner", "ExperienceConfigModal.tsx"), /config\.preferredTime !== null/);
});

test("max_bookings is no longer presented to hosts (not enforced anywhere)", () => {
  const form = read("src", "components", "provider", "ExperienceAvailabilityManager.tsx");
  assert.doesNotMatch(form, /maxBookings|Max bookings|max \$\{/);
  assert.doesNotMatch(read("src", "lib", "provider", "experience-actions.ts"), /maxBookings|max_bookings:/);
  assert.doesNotMatch(read("src", "lib", "provider", "experiences.ts"), /max_bookings|maxBookings/);
});

test("the guest booking page offers Message host through the existing booking conversation", () => {
  const page = read("src", "app", "bookings", "[itemId]", "page.tsx");
  assert.match(page, /<MessageLauncherButton\s+label="Message host"/);
  assert.match(page, /getMessagingWindowState\(item\.status, item\.decidedAt, item\.cancelledAt\)/);
  assert.match(page, /canSend: messagingWindow\.canSend/);
  // Withdraw stays REQUESTED-only and support stays separate below.
  assert.ok(page.indexOf("<MessageLauncherButton") < page.indexOf("<GetHelpButton"));
});
