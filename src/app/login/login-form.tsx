"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { login, type ActionState } from "./actions";

const initialState: ActionState = {};

type ResendStatus = "idle" | "sending" | "sent" | "error";

export function LoginForm({
  redirectTo = "/home",
  forgotPasswordHref = "/forgot-password",
}: {
  redirectTo?: string;
  /** Host login passes /host/forgot-password so the reset keeps the host journey. */
  forgotPasswordHref?: string;
}) {
  const loginWithRedirect = login.bind(null, redirectTo);
  const [state, formAction, isPending] = useActionState(loginWithRedirect, initialState);
  const [resendStatus, setResendStatus] = useState<ResendStatus>("idle");

  async function handleResend() {
    if (!state.unconfirmedEmail) return;
    setResendStatus("sending");
    const supabase = createSupabaseBrowserClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: state.unconfirmedEmail,
      options: { emailRedirectTo: `${siteUrl}/auth/callback` },
    });
    setResendStatus(error ? "error" : "sent");
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Input
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <PasswordInput
        label="Password"
        name="password"
        autoComplete="current-password"
        required
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.unconfirmedEmail && (
        <div className="flex flex-col items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            onClick={handleResend}
            disabled={resendStatus === "sending" || resendStatus === "sent"}
          >
            {resendStatus === "sending"
              ? "Sending…"
              : resendStatus === "sent"
                ? "Verification email sent!"
                : "Resend verification email"}
          </Button>
          {resendStatus === "error" && (
            <p className="text-sm text-red-600">
              Something went wrong. Please try again in a moment.
            </p>
          )}
        </div>
      )}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Logging in…" : "Log in"}
      </Button>
      <Link
        href={forgotPasswordHref}
        className="text-center text-sm text-sky-600 hover:text-sky-700"
      >
        Forgot password?
      </Link>
    </form>
  );
}
