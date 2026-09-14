"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestPasswordReset, type ActionState } from "./actions";

const initialState: ActionState = {};

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(
    requestPasswordReset,
    initialState,
  );

  if (state.sent) {
    return (
      <p className="text-center text-navy-600">
        If an account exists for that email, we&apos;ve sent a link to reset
        your password. Check your inbox.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
