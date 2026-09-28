export type CheckOutError = { title: string; detail: string };

/**
 * Local-date (not UTC) "today" as YYYY-MM-DD, matching what a <input
 * type="date"> shows the user. Run identically on the browser (browser's
 * local time) and the server (server's local time) — see the comment on
 * validateStayDates for why a small mismatch near midnight is an accepted
 * tradeoff rather than something worth wiring timezone data across for.
 */
export function todayISODate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Check-in may be today or in the past — a guest can discover Felyn while
 * already staying at the property. Check-out must be today or later, and
 * strictly after check-in. Deliberately NOT enforced as a DB constraint:
 * a completed stay's check-out is legitimately in the past once the stay
 * is over, so "today or later" can only be a point-in-time UI/action
 * check, never a standing CHECK (check_out > check_in) is still fine at
 * the DB level since that's true forever, independent of today's date.
 */
export function validateStayDates(checkIn: string, checkOut: string): CheckOutError | null {
  const today = todayISODate();

  if (checkOut < today) {
    return {
      title: "Your stay has already ended",
      detail: "Please choose a check-out date today or later.",
    };
  }

  if (checkOut <= checkIn) {
    return {
      title: "Check-out must be after check-in",
      detail: "Please choose a later check-out date.",
    };
  }

  return null;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The earliest selectable check-out date for the date-picker's `min`
 * attribute — the later of "today" and "the day after check-in", so a
 * past check-in (e.g. check-in Sept 10, today Sept 14) still floors
 * check-out at today (Sept 14), not just Sept 11.
 */
export function minCheckOutDate(checkIn: string): string {
  const today = todayISODate();
  if (!checkIn) return today;
  const dayAfterCheckIn = addDays(checkIn, 1);
  return dayAfterCheckIn > today ? dayAfterCheckIn : today;
}
