"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { JOURNEY_COOKIE, JOURNEY_COOKIE_OPTIONS, journeyForLoginDestination } from "@/lib/journey";
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
 */
export async function login(
  redirectTo: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

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
  (await cookies()).set(JOURNEY_COOKIE, journeyForLoginDestination(destination), JOURNEY_COOKIE_OPTIONS);
  redirect(destination);
}
