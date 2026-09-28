"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type State = { status: "idle" | "pending" } | { status: "sent" } | { status: "error"; message: string };

/**
 * Milestone 1: real email change via Supabase Auth's own verification flow
 * — never a direct write to a profile table. Calling updateUser({ email })
 * from the BROWSER client for the same PKCE reason as signup/reset-password
 * (see their comments): the confirmation link's code_verifier only
 * persists via the browser client's synchronous cookie write.
 *
 * The active session's email does NOT change yet — Supabase requires the
 * link (sent to the new address, and to the old one too if this project has
 * "Secure email change" on, a Supabase dashboard setting this code can't
 * see or control) to be confirmed first. It lands on the existing
 * /auth/callback route, which already handles a bare confirmation code.
 */
export function EmailChangeForm({ currentEmail }: { currentEmail: string }) {
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newEmail = String(new FormData(event.currentTarget).get("email") ?? "").trim();

    if (!newEmail || newEmail === currentEmail) {
      setState({ status: "error", message: "Enter a different email address." });
      return;
    }

    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { error } = await supabase.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: `${siteUrl}/auth/callback` },
    );
    if (error) {
      setState({ status: "error", message: error.message });
      return;
    }

    setState({ status: "sent" });
  }

  if (state.status === "sent") {
    return (
      <p className="text-sm text-sky-700">
        Check your inbox to confirm your new email address. Your current email stays active until then.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Input label="Email" name="email" type="email" defaultValue={currentEmail} autoComplete="email" required />
      {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
      <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={state.status === "pending"}>
        {state.status === "pending" ? "Sending…" : "Change email"}
      </Button>
    </form>
  );
}
