import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  hostJourneyHome,
  isGuestRoute,
  isLoginPage,
  journeyForEntryPoint,
  JOURNEY_COOKIE,
  JOURNEY_COOKIE_OPTIONS,
  parseJourney,
  type Journey,
} from "@/lib/journey";
import { RETURN_TO_PARAM, safeReturnTo } from "@/lib/return-to";

/**
 * Routes that require a signed-in user. Everything else stays public.
 * Extend this list as real product routes land in later milestones.
 * "/stays" is reserved here ahead of the Milestone 1 stay-overview page
 * (/stays/[stayId]) landing in a later stage of this same milestone.
 */
const PROTECTED_PREFIXES = [
  "/home",
  "/onboarding",
  "/explore",
  "/provider",
  "/messages",
  "/profile",
  "/experiences",
  "/stays",
  "/trips",
  "/bookings",
  "/host",
  "/account",
];

/**
 * The only /host pages a signed-out user may open: the host password-reset
 * pages (a host who forgot their password can't be signed in). Exact paths
 * only — every other /host route stays protected. They grant nothing: a
 * successful reset continues to /host/apply, which checks the database.
 */
const PUBLIC_HOST_PATHS = new Set(["/host/forgot-password", "/host/reset-password"]);

function isHostArea(pathname: string): boolean {
  return (
    pathname === "/host" ||
    pathname.startsWith("/host/") ||
    pathname === "/provider" ||
    pathname.startsWith("/provider/")
  );
}

/**
 * GET/HEAD page requests only — Server Action calls are POSTs and never
 * change the journey (guest actions guard themselves). NOTE: Next.js strips
 * its own RSC/prefetch headers (next-router-prefetch, rsc, …) before the
 * proxy runs (next/dist/server/web/adapter.js), so a client-router prefetch
 * is indistinguishable from a real visit here. That is why the two login
 * pages — which link to, and prefetch, each other — never switch the
 * journey on a signed-out visit (see below and login/actions.ts). Browser
 * speculative prefetches that do announce themselves are skipped.
 */
function isPageRequest(request: NextRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`.toLowerCase();
  return !purpose.includes("prefetch");
}

/**
 * Named `proxy` (not `middleware`) per the Next.js 16 rename — this runs on
 * the Node.js runtime before rendering, refreshes the Supabase session
 * cookie on every request, and redirects based on auth state.
 *
 * It also keeps the guest and host JOURNEYS apart (see src/lib/journey.ts):
 * explicit entry points set an httpOnly journey cookie, and in the host
 * journey guest pages redirect to the host experience chosen from the
 * account's DATABASE status. The cookie only selects the experience — host
 * access itself is still enforced by RLS (a providers row), the /provider
 * layout, and each Server Action's own checks.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() must be called before any redirect decision — it's
  // what actually triggers the token refresh and cookie write above.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname, searchParams } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p)) && !PUBLIC_HOST_PATHS.has(pathname);

  // ── journey: explicit entry points select it ──
  // Signed-out visits to the login pages are excluded (prefetch-safe); a
  // successful login writes the journey from the login Server Action.
  const storedJourney = parseJourney(request.cookies.get(JOURNEY_COOKIE)?.value);
  const entryJourney =
    isPageRequest(request) && !(isLoginPage(pathname) && !user) ? journeyForEntryPoint(pathname, searchParams) : null;
  const journey: Journey = entryJourney ?? storedJourney;
  const shouldWriteJourney = entryJourney !== null && entryJourney !== storedJourney;

  /** Every response carries the refreshed Supabase session cookies and, when it changed, the journey cookie. */
  function finalize(result: NextResponse): NextResponse {
    if (result !== response) {
      response.cookies.getAll().forEach((cookie) => result.cookies.set(cookie));
    }
    if (shouldWriteJourney) result.cookies.set(JOURNEY_COOKIE, journey, JOURNEY_COOKIE_OPTIONS);
    return result;
  }

  function redirectTo(path: string): NextResponse {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    return finalize(NextResponse.redirect(url));
  }

  // The old host-login alias now lives on the dedicated host login page.
  if (pathname === "/login" && searchParams.get("next") === "host") {
    return redirectTo(user ? "/host/apply" : "/login/host");
  }

  if (!user && isProtected) {
    // Host/provider areas return through the host login; everything else
    // through the guest login, exactly as before. A safe internal page
    // (src/lib/return-to.ts) is passed along as ?returnTo= so the login can
    // continue there — e.g. the booking an email button links to. Only for
    // query-free URLs (every email link is one): a page that needs its query
    // (e.g. onboarding's ?stay=) keeps the previous behaviour.
    const hostArea = isHostArea(pathname);
    const returnTo = request.nextUrl.search ? null : safeReturnTo(pathname, hostArea ? "host" : "guest");
    if (hostArea) {
      const url = request.nextUrl.clone();
      url.pathname = "/login/host";
      url.search = "";
      if (returnTo) url.searchParams.set(RETURN_TO_PARAM, returnTo);
      return finalize(NextResponse.redirect(url));
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.delete(RETURN_TO_PARAM);
    if (returnTo) url.searchParams.set(RETURN_TO_PARAM, returnTo);
    return finalize(NextResponse.redirect(url));
  }

  if (user && (pathname === "/login" || pathname === "/signup" || pathname === "/login/host")) {
    // Decided by the entry point itself: host login / host sign-up -> host
    // experience; the explicit guest login / sign-up -> guest home. Navigation
    // only: /host/apply decides from the database whether this account should
    // apply, see its application, or go to /provider.
    return redirectTo(journeyForEntryPoint(pathname, searchParams) === "host" ? "/host/apply" : "/home");
  }

  // ── host journey: guest pages are not part of it ──
  // Only page navigations are redirected here; guest Server Actions refuse
  // themselves in the host journey (assertGuestJourney), because a Server
  // Action POST can target any route and can't be identified from the path.
  // Prefetches are redirected too (so no guest payload can be cached for a
  // later client-side navigation) — they just never *change* the journey.
  if (user && journey === "host" && isGuestRoute(pathname) && (request.method === "GET" || request.method === "HEAD")) {
    const [providerRes, applicationRes] = await Promise.all([
      supabase.from("providers").select("id").eq("user_id", user.id).maybeSingle(),
      supabase.from("host_applications").select("id").eq("user_id", user.id).maybeSingle(),
    ]);
    // Fail closed: a failed read must not count as "no application". Send the
    // user to /host/apply, which re-reads the database itself and shows an
    // error rather than the form if the read fails again. Error code only.
    if (providerRes.error || applicationRes.error) {
      const failed = providerRes.error ? "providers" : "host_applications";
      const code = (providerRes.error ?? applicationRes.error)?.code ?? "unknown";
      console.error(`proxy: host journey ${failed} read failed (code ${code})`);
      return redirectTo("/host/apply");
    }
    return redirectTo(
      hostJourneyHome({ isProvider: Boolean(providerRes.data), hasApplication: Boolean(applicationRes.data) }),
    );
  }

  return finalize(response);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
