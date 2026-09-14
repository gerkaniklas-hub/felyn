"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { signup, type ActionState } from "./actions";

const initialState: ActionState = {};

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signup, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="First name" name="firstName" autoComplete="given-name" required />
        <Input label="Last name" name="lastName" autoComplete="family-name" required />
      </div>
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      <Input
        label="Mobile number"
        name="phone"
        type="tel"
        autoComplete="tel"
        placeholder="Optional"
      />
      <PasswordInput
        label="Password"
        name="password"
        autoComplete="new-password"
        minLength={6}
        required
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
