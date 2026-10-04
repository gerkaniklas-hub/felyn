"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { PhoneInput } from "@/components/ui/phone-input";
import { mobileStepHref, PENDING_PHONE_COUNTRY_KEY, PENDING_PHONE_NUMBER_KEY } from "@/lib/contact/constants";
import { validatePhone } from "@/lib/phone";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type PhoneError = { error: string; field: "country" | "number" };

/**
 * Calls signUp from the BROWSER client, not a Server Action — same reason
 * as the forgot-password form (see its comment): signUp generates a PKCE
 * code_verifier for the confirmation link, but the server client only
 * flushes storage writes to cookies on a SIGNED_IN/TOKEN_REFRESHED/etc
 * event. With email confirmation on, no session comes back yet, so that
 * event never fires server-side and the verifier would be silently lost.
 * The browser client writes cookies synchronously on every change instead.
 *
 * The mobile number is required. With no session yet it can't be written
 * to user_contact_details here, so the validated E.164 number travels in
 * user_metadata as a pending value; /account/mobile (where the confirmation
 * link lands) re-validates and saves it on the server. See
 * src/lib/contact/constants.ts.
 */
export function SignupForm({ hostIntent = false }: { hostIntent?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<PhoneError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPhoneError(null);

    const formData = new FormData(event.currentTarget);
    const firstName = String(formData.get("firstName") ?? "").trim();
    const lastName = String(formData.get("lastName") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const phone = validatePhone(String(formData.get("phoneCountry") ?? ""), String(formData.get("phoneNumber") ?? ""));

    if (!firstName || !lastName || !email || !password) {
      setError("Please fill in your name, email, mobile number and password.");
      if (!phone.ok) setPhoneError({ error: phone.error, field: phone.field });
      return;
    }
    if (!phone.ok) {
      setPhoneError({ error: phone.error, field: phone.field });
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setSubmitting(true);
    const supabase = createSupabaseBrowserClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // host_intent is navigation context only (the confirmation link then
        // opens /host/apply instead of /home). It grants nothing: host access
        // exists only once Felyn approves the application in the database.
        data: {
          first_name: firstName,
          last_name: lastName,
          [PENDING_PHONE_NUMBER_KEY]: phone.e164,
          [PENDING_PHONE_COUNTRY_KEY]: phone.country,
          ...(hostIntent ? { host_intent: true } : {}),
        },
        emailRedirectTo: `${siteUrl}/auth/callback`,
      },
    });
    setSubmitting(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (data.session) {
      // Only happens if email confirmation is off — already signed in.
      router.push(mobileStepHref(hostIntent ? "/host/apply" : "/home"));
      return;
    }

    router.push(`/signup/check-email?email=${encodeURIComponent(email)}${hostIntent ? "&intent=host" : ""}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="First name" name="firstName" autoComplete="given-name" required />
        <Input label="Last name" name="lastName" autoComplete="family-name" required />
      </div>
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      <PhoneInput
        required
        error={phoneError?.error}
        errorField={phoneError?.field}
        onChange={() => setPhoneError(null)}
      />
      <PasswordInput
        label="Password"
        name="password"
        autoComplete="new-password"
        minLength={6}
        required
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={submitting}>
        {submitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
