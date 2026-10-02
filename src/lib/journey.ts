/**
 * Guest vs host JOURNEY — which experience (navigation, landing pages,
 * logout destination) a signed-in account is currently using.
 *
 * This is deliberately NOT an authorization role. One Supabase account can
 * use both journeys, chosen by the explicit entry point it came through.
 * The cookie only selects the experience; it never grants anything:
 *   - host access = a providers row for auth.uid() (RLS-enforced, created
 *     only by felyn_admin.approve_host_application)
 *   - applicant status = the user's own host_applications row (RLS)
 * A tampered cookie can at most change which pages a user is routed to.
 *
 * Pure module (no next/headers) so both proxy.ts and server code can use it.
 */

export const JOURNEY_COOKIE = "felyn_journey";

export type Journey = "guest" | "host";

/** Anything other than an explicit "host" is the guest journey — the default for every existing account. */
export function parseJourney(value: string | undefined | null): Journey {
  return value === "host" ? "host" : "guest";
}

export const JOURNEY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365, // one year: survives logout so the next login keeps the same journey
};

/** Where a signed-in account in the host journey belongs, given its DATABASE status. */
export function hostJourneyHome(access: { isProvider: boolean; hasApplication: boolean }): string {
  if (access.isProvider) return "/provider";
  if (access.hasApplication) return "/host/application";
  return "/host/apply";
}

/** Guest-experience routes. In the host journey these redirect to the host experience. */
export const GUEST_ROUTE_PREFIXES = [
  "/home",
  "/onboarding",
  "/explore",
  "/messages",
  "/profile",
  "/experiences",
  "/stays",
  "/trips",
  "/bookings",
  "/recommendations",
];

export function isGuestRoute(pathname: string): boolean {
  return GUEST_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The journey an explicit entry point belongs to, or null for pages that
 * don't select one. Host: the host landing page, host login, host sign-up,
 * and the host/provider areas. Guest: only the explicit guest login and
 * sign-up. Guest *routes* never switch the journey back, or the host-journey
 * restrictions would be trivially bypassed by following a link.
 *
 * Note for callers: proxy.ts cannot tell a Link prefetch from a real visit
 * (Next.js strips its RSC/prefetch headers before the proxy runs), so the
 * two LOGIN pages — which link to each other and get prefetched — must not
 * switch the journey on a signed-out visit. There the journey is written by
 * the login Server Action on success instead (see login/actions.ts).
 */
export function journeyForEntryPoint(pathname: string, searchParams: URLSearchParams): Journey | null {
  if (
    pathname === "/become-a-host" ||
    pathname === "/login/host" ||
    pathname === "/host" ||
    pathname.startsWith("/host/") ||
    pathname === "/provider" ||
    pathname.startsWith("/provider/")
  ) {
    return "host";
  }
  if (pathname === "/login") return searchParams.get("next") === "host" ? "host" : "guest";
  if (pathname === "/signup") return searchParams.get("intent") === "host" ? "host" : "guest";
  return null;
}

/** The two login pages, which only select a journey via a successful login (or a signed-in redirect). */
export function isLoginPage(pathname: string): boolean {
  return pathname === "/login" || pathname === "/login/host";
}

/** The journey implied by a (server-allow-listed) post-login destination. */
export function journeyForLoginDestination(destination: string): Journey {
  return destination === "/home" ? "guest" : "host";
}
