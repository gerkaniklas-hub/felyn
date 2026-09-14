"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Calls resetPasswordForEmail from the BROWSER client, not a Server Action.
 * This matters: the PKCE code_verifier this generates only gets persisted
 * as a cookie by @supabase/ssr's browser client (a synchronous
 * document.cookie write). The server client only flushes its storage to
 * cookies on specific auth events (SIGNED_IN, TOKEN_REFRESHED, ...), none
 * of which fire for a bare password-reset request — so a server-issued
 * request's verifier is silently dropped and the emailed link can never
 * be redeemed, regardless of how quickly it's clicked.
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!email) {
      setError("Enter your email address.");
      return;
    }

    setSubmitting(true);
    const supabase = createSupabaseBrowserClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/reset-password`,
    });
    setSubmitting(false);

    if (resetError) {
      setError("Something went wrong. Please try again in a moment.");
      return;
    }

    setSent(true);
  }

  if (sent) {
    return (
      <p className="text-center text-navy-600">
        If an account exists for that email, we&apos;ve sent a link to reset
        your password. Check your inbox.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
