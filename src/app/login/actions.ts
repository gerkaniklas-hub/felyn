"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ActionState = { error?: string };

function friendlyLoginError(message: string): string {
  if (message.toLowerCase().includes("email not confirmed")) {
    return "Please confirm your email address first — check your inbox for the link we sent when you signed up.";
  }
  return "Incorrect email or password.";
}

export async function login(
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
    return { error: friendlyLoginError(error.message) };
  }

  redirect("/home");
}
