import { isFarEnoughAhead } from "./canary-time";
import type { MatchedExperience } from "./hard-filter";
import { getPlannedMomentLabel, type PlannedMoment } from "./plan";

/**
 * Pure helpers behind guest-facing time selection and the request rules that
 * the server actions (requestExperience, submitBookingRequest) and the
 * database (0032's booking_request_start_error) all apply the same way.
 *
 * A request's start time (`preferred_time`, Tenerife local 'HH:MM') must:
 *   - be given (required for every new request since 0032);
 *   - fall inside the chosen moment's fixed range, with the WHOLE experience
 *     (experiences.duration_minutes) ending by the end of that range — e.g. a
 *     2-hour evening experience can start at 20:00 at the latest;
 *   - be on a date+moment one of the experience's availability windows covers
 *     (date range, and the window's own hours, if any, touching the moment);
 *   - be at least 4 hours after now, in real time (canary-time.ts).
 *
 * Host-defined window start/end times only decide which MOMENT(S) can be
 * requested on a date; within an offered moment the guest picks from the
 * standard 30-minute grid (the host reviews the time when confirming).
 */

type AvailabilityWindow = MatchedExperience["availability"][number];
type RequestableExperience = Pick<MatchedExperience, "title" | "duration_minutes" | "availability">;

const STEP_MINUTES = 30;

// Minutes since midnight, [start, end) — the fixed MVP time-of-day ranges.
// 0032 hard-codes the same three ranges in the database; keep them in sync.
export const MOMENT_RANGES: Record<PlannedMoment, { start: number; end: number }> = {
  morning: { start: 7 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 22 * 60 },
};

export const PREFERRED_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Shown when the database (0032, SQLSTATE 22023) refuses a new item that passed
 * the server's own checks — in practice a time that became too soon in between.
 */
export const START_REFUSED_ERROR =
  "This start time can no longer be requested — experiences need at least 4 hours' notice. Please choose a later time.";

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

/** The latest start ('HH:MM') at which the whole experience still ends by the end of the moment, or null if it can't fit at all. */
export function getLatestStart(experience: Pick<MatchedExperience, "duration_minutes">, moment: PlannedMoment): string | null {
  const range = MOMENT_RANGES[moment];
  const latest = range.end - experience.duration_minutes;
  return latest >= range.start ? formatMinutes(latest) : null;
}

/** The guest-facing note under a start-time picker, e.g. "Tenerife time. At least 4 hours' notice. Lasts 2 hours, so the latest evening start is 20:00." */
export function getStartTimeHint(experience: Pick<MatchedExperience, "duration_minutes">, moment: PlannedMoment | null): string {
  const base = "Tenerife time. Requests need at least 4 hours' notice.";
  if (!moment) return base;
  const latest = getLatestStart(experience, moment);
  const hours = Math.round((experience.duration_minutes / 60) * 2) / 2;
  const lasts = `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
  return latest ? `${base} Lasts ${lasts}, so the latest ${getPlannedMomentLabel(moment).toLowerCase()} start is ${latest}.` : base;
}

function windowsOn(experience: RequestableExperience, date: string): AvailabilityWindow[] {
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

function momentOffered(experience: RequestableExperience, date: string, moment: PlannedMoment): boolean {
  return windowsOn(experience, date).some((window) => windowCoversMoment(window, moment));
}

/**
 * The start times a guest can choose for one experience on one date+moment:
 * the standard 30-minute grid, limited to starts where the whole experience
 * ends by the end of the moment, and — when `nowMs` is given — to starts at
 * least 4 hours from now. Null when nothing can be requested there (no
 * availability window covers it, the experience is too long for the moment,
 * or every start is too soon).
 */
export function getTimeOptions(
  experience: RequestableExperience,
  date: string,
  moment: PlannedMoment,
  nowMs?: number,
): string[] | null {
  if (!momentOffered(experience, date, moment)) return null;
  const range = MOMENT_RANGES[moment];
  const times: string[] = [];
  for (let t = range.start; t + experience.duration_minutes <= range.end; t += STEP_MINUTES) {
    const time = formatMinutes(t);
    if (nowMs === undefined || isFarEnoughAhead(date, time, nowMs)) times.push(time);
  }
  return times.length > 0 ? times : null;
}

/** Whether at least one start time can be requested on this date+moment (see getTimeOptions; `nowMs` adds the 4-hour rule). */
export function isAvailableAt(experience: RequestableExperience, date: string, moment: PlannedMoment, nowMs?: number): boolean {
  return getTimeOptions(experience, date, moment, nowMs) !== null;
}

export function isAvailableOnDate(experience: RequestableExperience, date: string, nowMs?: number): boolean {
  return (["morning", "afternoon", "evening"] as const).some((moment) => isAvailableAt(experience, date, moment, nowMs));
}

/**
 * The one server-side (and UI) check for a requested start, mirroring 0032's
 * booking_request_start_error: null when the request may be sent, otherwise
 * a message for the guest. The caller has already checked the date format
 * and the moment value.
 */
export function getRequestedStartError(
  experience: RequestableExperience,
  date: string,
  moment: PlannedMoment,
  time: string | null | undefined,
  nowMs: number,
): string | null {
  const momentLabel = getPlannedMomentLabel(moment).toLowerCase();
  if (!time) return `Choose a start time for ${experience.title}.`;
  if (!PREFERRED_TIME_PATTERN.test(time)) return `Choose a valid start time for ${experience.title}.`;
  if (getMomentForTime(time) !== moment) return `${time} isn't in the ${momentLabel}. Choose a start time in the ${momentLabel}.`;
  if (toMinutes(time) + experience.duration_minutes > MOMENT_RANGES[moment].end) {
    const latest = getLatestStart(experience, moment);
    return latest
      ? `${experience.title} would end too late. The latest start in the ${momentLabel} is ${latest}.`
      : `${experience.title} is too long for the ${momentLabel}.`;
  }
  if (!momentOffered(experience, date, moment)) return `${experience.title} isn't available on that date in the ${momentLabel}.`;
  if (!isFarEnoughAhead(date, time, nowMs)) {
    return `Experiences must be requested at least 4 hours before they start. Choose a later time for ${experience.title}.`;
  }
  return null;
}

/** Stay dates this experience can actually be requested on — the config modal's date list. */
export function getBookableDates(experience: RequestableExperience, plannableDates: string[], nowMs?: number): string[] {
  return plannableDates.filter((date) => isAvailableOnDate(experience, date, nowMs));
}

/** Guest-count range for one experience: its own group-size limits, capped at the stay's guest count. */
export function getGuestCountRange(experience: MatchedExperience, stayGuestCount: number): { min: number; max: number } {
  return { min: Math.max(1, experience.min_guests), max: Math.min(experience.max_guests, stayGuestCount) };
}
