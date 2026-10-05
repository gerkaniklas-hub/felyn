import type { SupportRequesterRole, SupportStatus } from "./constants";

/**
 * Pure helpers for the internal Felyn Support screens (no React, no Supabase —
 * unit-tested). Staff see customers by name, never by id.
 */

/** "Niklas Gerka", else the email, else a neutral fallback. */
export function getCustomerDisplayName(c: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.email || "Customer";
}

/** The first name only, for message labels ("Niklas"), else "Guest"/"Host". */
export function getCustomerShortName(firstName: string | null, role: SupportRequesterRole): string {
  return firstName?.trim() || (role === "host" ? "Host" : "Guest");
}

export function getRequesterRoleLabel(role: SupportRequesterRole): string {
  return role === "host" ? "Host" : "Guest";
}

/** "Today, 20:14" / "Yesterday, 09:30" / "Mon 12 Oct" (same year) / "12 Oct 2025". */
export function formatActivityTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The list's status filter from `?status=`: open (default), resolved or closed. */
export function parseStatusFilter(value: string | undefined | null): SupportStatus {
  const upper = (value ?? "").toUpperCase();
  return upper === "RESOLVED" || upper === "CLOSED" ? upper : "OPEN";
}

/**
 * What the staff reply area offers, mirroring the database (0029): staff may reply
 * while OPEN or RESOLVED (a reply does not change the status), never while CLOSED —
 * a closed conversation must be re-opened first.
 */
export function getStaffReplyMode(status: SupportStatus): "reply" | "reply-resolved" | "reopen-required" {
  if (status === "CLOSED") return "reopen-required";
  return status === "RESOLVED" ? "reply-resolved" : "reply";
}
