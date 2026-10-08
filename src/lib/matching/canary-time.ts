/**
 * Felyn's business clock: every experience happens in Tenerife, so requested
 * dates and times are Atlantic/Canary local wall-clock values (a plain date
 * plus 'HH:MM', exactly as booking_request_items stores them). This module
 * converts between that local clock and real instants using the IANA zone
 * itself (Intl), so DST (WET/WEST) is handled by the time-zone database, never
 * by a hard-coded UTC offset — and the server's own clock zone (UTC on Vercel)
 * never matters. The database applies the same rule with
 * `(planned_date + preferred_time) at time zone 'Atlantic/Canary'` (0032).
 *
 * Pure module (no "use server"/"use client"), so server actions, client
 * components and `npm test` share it.
 */

export const CANARY_TIME_ZONE = "Atlantic/Canary";

/** Guests must request an experience at least this long before it starts (0032 enforces the same). */
export const MIN_REQUEST_LEAD_MINUTES = 4 * 60;

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: CANARY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(instantMs: number): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of PARTS_FORMATTER.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The Canary local date ('YYYY-MM-DD') and time ('HH:MM') at an instant. */
export function canaryLocalDateTime(instantMs: number): { date: string; time: string } {
  const p = localParts(instantMs);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** Today's date in Tenerife (not the server's or the browser's own zone). */
export function canaryToday(nowMs: number): string {
  return canaryLocalDateTime(nowMs).date;
}

/**
 * The real instant (epoch ms) of a Canary local date + 'HH:MM'. Starts from
 * the same wall-clock values read as UTC, then corrects by the zone's actual
 * offset at that instant (twice, so a guess on the other side of a DST switch
 * settles too). Felyn's bookable times (07:00–22:00) never fall in the
 * one-hour gap or overlap of a DST switch.
 */
export function canaryLocalToInstant(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = localParts(instant);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    instant -= shownAsUtc - wallAsUtc;
  }
  return instant;
}

/** True when a Canary local start is at least MIN_REQUEST_LEAD_MINUTES after `nowMs` (so never in the past). */
export function isFarEnoughAhead(date: string, time: string, nowMs: number): boolean {
  return canaryLocalToInstant(date, time) >= nowMs + MIN_REQUEST_LEAD_MINUTES * 60 * 1000;
}
