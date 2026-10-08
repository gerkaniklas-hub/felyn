import { canaryLocalDateTime } from "./canary-time";
import type { StayDay } from "./timeline";

/**
 * M6.4/M6.6: the user's own plan state. Deliberately shaped like a future
 * database row so a later milestone can replace this client state with a
 * real `planned_moments` table without reshaping the concept. No table is
 * created in this milestone — see StayPlanner for where this actually
 * lives (React state).
 */
export type PlannedMoment = "morning" | "afternoon" | "evening";

export type PlannedSlot = {
  date: string; // 'YYYY-MM-DD', always one of getPlannableDates(timeline)
  moment: PlannedMoment;
};

/**
 * M6.6: one entry in the guest's plan. `selectionId` is the row's own
 * identity — independent of experienceId/date/moment — precisely so the
 * SAME experience can be selected for two different dates/moments as two
 * separate PlanSelections without colliding. Never derive a selection's
 * identity from experienceId alone (that was the M6.6 bug — see
 * StayPlanner's module comment).
 */
export type PlanSelection = {
  selectionId: string;
  experienceId: string;
  slot: PlannedSlot;
  /** Per-experience group size — independent of the stay's own guest_count. */
  guestCount: number;
  /** 'HH:MM' preference (not a confirmed appointment) or null for "no preference". */
  preferredTime: string | null;
  /** Optional plain-text note for the provider (see HOST_NOTE_MAX_LENGTH). */
  hostNote: string;
};

export const HOST_NOTE_MAX_LENGTH = 500;

export const PLANNED_MOMENTS: { value: PlannedMoment; label: string }[] = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
];

export function getPlannedMomentLabel(moment: PlannedMoment): string {
  return PLANNED_MOMENTS.find((m) => m.value === moment)?.label ?? moment;
}

/**
 * The single headline time label used everywhere a booking's date/time is
 * shown (host request cards, guest booking history, confirmations): the
 * guest's exact requested/confirmed time when one was given (e.g. "19:30"),
 * or the daypart alone otherwise (a pre-0012 legacy row and a row where the
 * guest simply chose no preference are indistinguishable — preferred_time
 * is null either way — so both correctly fall back to the plain moment
 * label rather than ever inventing a time; see ExperienceConfigModal).
 */
export function getBookingTimeLabel(moment: PlannedMoment, preferredTime: string | null): string {
  return preferredTime ?? `${getPlannedMomentLabel(moment)} · Time not specified`;
}

/**
 * The start time to show for a booking ('HH:MM', Tenerife time): the
 * authoritative confirmed_start_at once the host has accepted (0033), else
 * the requested preferred_time — which is also all that bookings accepted
 * before 0033 ever had, so they keep displaying exactly as before.
 */
export function getBookingStartTime(item: { preferredTime: string | null; confirmedStartAt: string | null }): string | null {
  if (item.confirmedStartAt) return canaryLocalDateTime(Date.parse(item.confirmedStartAt)).time;
  return item.preferredTime;
}

/**
 * Stay dates a plan item can be moved to — every day except departure (the
 * guest is leaving, not settling in for an experience that day). Mirrors
 * the same exclusion timeline.ts's assignment already uses.
 */
export function getPlannableDates(timeline: StayDay[]): string[] {
  return timeline.slice(0, -1).map((day) => day.date);
}

/**
 * The day the M5.2-ranked suggestion was originally grouped under, if any
 * — null for an experience the AI didn't suggest for a specific day (i.e.
 * one the guest found through "other ideas"). Only ever used to seed a
 * sensible starting point for a brand new selection; once created, a
 * PlanSelection's slot is never recomputed from this.
 */
export function getSuggestedDate(timeline: StayDay[], experienceId: string): string | null {
  return timeline.find((day) => day.experienceIds.includes(experienceId))?.date ?? null;
}

export function defaultPlannedSlot(timeline: StayDay[], experienceId: string, fallbackDate?: string): PlannedSlot {
  const suggested = getSuggestedDate(timeline, experienceId);
  const plannable = getPlannableDates(timeline);
  const date = suggested ?? fallbackDate ?? plannable[0] ?? timeline[0]?.date ?? "";
  return { date, moment: "evening" };
}

/**
 * The only planning conflict Felyn enforces: two PlanSelections sharing
 * the exact same date AND the same moment (multiple experiences on one
 * date, or the same moment across different dates, are both fine). Works
 * on `selectionId`, not `experienceId` — two selections of the very same
 * experience on two different dates must never be flagged against each
 * other, and if a guest genuinely put the same experience twice on the
 * same date+moment, that IS still a real conflict (both selectionIds get
 * flagged). Purely derived from current selections — nothing is
 * auto-removed or auto-rescheduled; the guest resolves it via Remove or Change.
 */
export function findConflictingSelectionIds(
  selections: { selectionId: string; slot: PlannedSlot }[],
): Set<string> {
  const byKey = new Map<string, string[]>();
  for (const selection of selections) {
    const key = `${selection.slot.date}|${selection.slot.moment}`;
    const existing = byKey.get(key);
    if (existing) existing.push(selection.selectionId);
    else byKey.set(key, [selection.selectionId]);
  }
  const conflicting = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) {
      for (const id of ids) conflicting.add(id);
    }
  }
  return conflicting;
}
