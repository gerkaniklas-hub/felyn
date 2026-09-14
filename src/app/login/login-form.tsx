"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { login, type ActionState } from "./actions";

const initialState: ActionState = {};

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);

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
      <Button type="submit" disabled={isPending}>
        {isPending ? "Logging in…" : "Log in"}
      </Button>
      <Link
        href="/forgot-password"
        className="text-center text-sm text-sky-600 hover:text-sky-700"
      >
        Forgot password?
      </Link>
    </form>
  );
}
