import type { MatchedExperience } from "./hard-filter";
import type { PlannedMoment } from "./plan";

/**
 * Pure helpers behind guest-facing time selection.
 *
 * MVP simplification: preferred time is a guest PREFERENCE across a fixed,
 * standard time-of-day range — never restricted to whatever specific
 * start/end an experience's own `experience_availability` row happens to
 * define. Host-defined start/end times still decide which MOMENT(S) an
 * experience can be requested for on a given date (that's real data about
 * when the host actually runs it), but once a moment is available, the
 * guest can pick ANY time in that moment's standard range — the host
 * reviews the preference when confirming. Proper host availability/
 * calendar management (constraining guest time choices to what a host has
 * actually opened up) is a separate, later phase.
 */

type AvailabilityWindow = MatchedExperience["availability"][number];

const STEP_MINUTES = 30;

// Minutes since midnight, [start, end) — the fixed MVP time-of-day ranges.
// Deliberately narrower than a full day (unlike an earlier version of this
// file): a time outside 07:00–22:00 belongs to no moment and is never
// offered or accepted.
const MOMENT_RANGES: Record<PlannedMoment, { start: number; end: number }> = {
  morning: { start: 7 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 22 * 60 },
};

export const PREFERRED_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'HH:MM' or Postgres 'HH:MM:SS' → minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Normalises a Postgres `time` value ('19:00:00') to the 'HH:MM' the app uses everywhere. */
export function normalizeTime(time: string | null): string | null {
  return time ? time.slice(0, 5) : null;
}

/** Which standard moment a time falls in, or null if it's outside all three fixed ranges (07:00–22:00). */
export function getMomentForTime(time: string): PlannedMoment | null {
  const minutes = toMinutes(time);
  for (const moment of Object.keys(MOMENT_RANGES) as PlannedMoment[]) {
    const range = MOMENT_RANGES[moment];
    if (minutes >= range.start && minutes < range.end) return moment;
  }
  return null;
}

/** The full 30-minute grid for one moment, e.g. evening → ["17:00", "17:30", …, "21:30"]. */
function standardGrid(moment: PlannedMoment): string[] {
  const range = MOMENT_RANGES[moment];
  const times: string[] = [];
  for (let t = range.start; t < range.end; t += STEP_MINUTES) times.push(formatMinutes(t));
  return times;
}

const STANDARD_GRIDS: Record<PlannedMoment, string[]> = {
  morning: standardGrid("morning"),
  afternoon: standardGrid("afternoon"),
  evening: standardGrid("evening"),
};

function windowsOn(experience: MatchedExperience, date: string): AvailabilityWindow[] {
  return experience.availability.filter((w) => w.available_from <= date && w.available_until >= date);
}

/** Whether an availability window (its own start/end, if any) touches this moment's fixed range at all. Undefined times = an open window, offered in every moment. */
function windowCoversMoment(window: AvailabilityWindow, moment: PlannedMoment): boolean {
  if (!window.start_time || !window.end_time) return true;
  const range = MOMENT_RANGES[moment];
  const start = toMinutes(window.start_time);
  const end = toMinutes(window.end_time);
  return start < range.end && end > range.start;
}

/**
 * The preferred-time choices for one experience on one date+moment: the
 * FULL standard 30-minute grid for that moment (never narrowed to a host's
 * own service hours), or null when the experience isn't available on that
 * date+moment at all (no availability window covers the date and touches
 * this moment).
 */
export function getTimeOptions(experience: MatchedExperience, date: string, moment: PlannedMoment): string[] | null {
  const windows = windowsOn(experience, date);
  if (windows.length === 0) return null;
  if (!windows.some((window) => windowCoversMoment(window, moment))) return null;
  return STANDARD_GRIDS[moment];
}

export function isAvailableAt(experience: MatchedExperience, date: string, moment: PlannedMoment): boolean {
  return getTimeOptions(experience, date, moment) !== null;
}

export function isAvailableOnDate(experience: MatchedExperience, date: string): boolean {
  return (["morning", "afternoon", "evening"] as const).some((moment) => isAvailableAt(experience, date, moment));
}

/**
 * Server-side (and UI) check that a preferred time is acceptable: correct
 * 'HH:MM' format, inside the chosen moment's fixed standard range, and the
 * experience is actually available on that date+moment. Never depends on a
 * host's own specific service hours — see the module note above.
 */
export function isPreferredTimeAllowed(
  experience: MatchedExperience,
  date: string,
  moment: PlannedMoment,
  time: string,
): boolean {
  if (!PREFERRED_TIME_PATTERN.test(time)) return false;
  if (getMomentForTime(time) !== moment) return false;
  return isAvailableAt(experience, date, moment);
}

/** Stay dates this experience can actually be requested on — the config modal's date list. */
export function getBookableDates(experience: MatchedExperience, plannableDates: string[]): string[] {
  return plannableDates.filter((date) => isAvailableOnDate(experience, date));
}

/** Guest-count range for one experience: its own group-size limits, capped at the stay's guest count. */
export function getGuestCountRange(experience: MatchedExperience, stayGuestCount: number): { min: number; max: number } {
  return { min: Math.max(1, experience.min_guests), max: Math.min(experience.max_guests, stayGuestCount) };
}
