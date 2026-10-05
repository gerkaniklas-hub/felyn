/**
 * "Return after login": a signed-out visitor who opens a protected page (for
 * example from an email button) is sent to the login page with
 * ?returnTo=<path>, and after a successful login continues to that page.
 *
 * Only an internal PATH is ever accepted, never a URL: it must start with a
 * single "/", contain only letters, digits, "-", "_" and "/" (so no "//",
 * "\", ".", "%", ":", "?" or "#" — no external, protocol-relative, encoded
 * or traversal tricks), be at most 200 characters, and belong to the login's
 * own journey: guest pages for the guest login, /provider pages for the host
 * login. Anything else is ignored and the login lands where it always has.
 *
 * Pure module (relative imports only) so proxy.ts, the login pages, the
 * login Server Action and the unit tests can all use it.
 */
import { isGuestRoute, type Journey } from "./journey";

export const RETURN_TO_PARAM = "returnTo";

const SAFE_PATH = /^\/[A-Za-z0-9_\-/]*$/;

export function safeReturnTo(value: unknown, journey: Journey): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 200) return null;
  if (!SAFE_PATH.test(value) || value.includes("//")) return null;
  if (journey === "guest") return isGuestRoute(value) ? value : null;
  return value === "/provider" || value.startsWith("/provider/") ? value : null;
}
