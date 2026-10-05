"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { mobileStepHref } from "@/lib/contact/constants";
import { getContactDetails } from "@/lib/contact/queries";
import { JOURNEY_COOKIE, JOURNEY_COOKIE_OPTIONS, journeyForLoginDestination } from "@/lib/journey";
import { safeReturnTo } from "@/lib/return-to";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = {
  error?: string;
  unconfirmedEmail?: string;
};

/**
 * The only places a login may land. Bound arguments of a Server Action
 * travel with the client's request, so the destination is re-checked
 * against this allow-list server-side rather than trusted.
 */
const ALLOWED_REDIRECTS = new Set(["/home", "/provider", "/host/apply"]);

/**
 * `redirectTo` is bound by the caller (see LoginForm) rather than read from
 * form data, so it can never be spoofed via the submitted request — it's
 * baked into the Server Action reference itself. Guest login binds "/home",
 * host login binds "/host/apply"; everything else (Supabase Auth call,
 * validation, unconfirmed-email handling) is shared, unchanged logic.
 *
 * A successful login also records the journey it came through (guest login
 * -> guest, host login -> host). This is the prefetch-safe place to do it:
 * a Server Action is never prefetched, unlike a visit to the login page.
 * The journey selects the experience only — it grants no access.
 *
 * An account without a mobile number (user_contact_details) continues via
 * /account/mobile first, which saves the one given at signup or asks for one.
 *
 * `returnTo` (also bound, also re-checked here) is the page a signed-out
 * visitor originally opened, e.g. a booking from an email link. It is used
 * only if safeReturnTo accepts it for THIS login's journey (guest pages for
 * the guest login, /provider pages for the host login); the journey cookie
 * is still decided by `redirectTo` alone. The mobile step keeps its own
 * allow-list, so an account without a number lands on the usual page.
 */
export async function login(
  redirectTo: string,
  returnTo: string | null,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.code === "email_not_confirmed") {
      return {
        error: "Please confirm your email address before logging in.",
        unconfirmedEmail: email,
      };
    }
    return { error: "Incorrect email or password." };
  }

  const destination = ALLOWED_REDIRECTS.has(redirectTo) ? redirectTo : "/home";
  const journey = journeyForLoginDestination(destination);
  (await cookies()).set(JOURNEY_COOKIE, journey, JOURNEY_COOKIE_OPTIONS);
  const finalDestination = safeReturnTo(returnTo, journey) ?? destination;

  let hasMobile = true;
  try {
    hasMobile = Boolean(await getContactDetails(supabase, data.user.id));
  } catch {
    // A failed read must not block the login; /account/mobile is reached again on the next one.
  }
  redirect(hasMobile ? finalDestination : mobileStepHref(destination));
}
