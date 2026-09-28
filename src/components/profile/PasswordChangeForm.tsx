"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type State = { status: "idle" | "pending" | "saved" } | { status: "error"; message: string };

/** Milestone 1: password change for an already-signed-in guest — plain updateUser, same call reset-password-content.tsx uses once its own code exchange completes. */
export function PasswordChangeForm() {
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (password.length < 6) {
      setState({ status: "error", message: "Password must be at least 6 characters." });
      return;
    }
    if (password !== confirm) {
      setState({ status: "error", message: "Passwords don't match." });
      return;
    }

    setState({ status: "pending" });
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setState({ status: "error", message: "We couldn't update your password. Please try again." });
      return;
    }

    setState({ status: "saved" });
    event.currentTarget.reset();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <PasswordInput label="New password" name="password" autoComplete="new-password" minLength={6} required />
      <PasswordInput label="Confirm new password" name="confirm" autoComplete="new-password" minLength={6} required />
      {state.status === "error" ? <p className="text-sm text-red-600">{state.message}</p> : null}
      {state.status === "saved" ? <p className="text-sm text-sky-700">Password updated.</p> : null}
      <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={state.status === "pending"}>
        {state.status === "pending" ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
