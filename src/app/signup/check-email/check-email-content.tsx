"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type ResendStatus = "idle" | "sending" | "sent" | "error";

export function CheckEmailContent() {
  const email = useSearchParams().get("email");
  const [status, setStatus] = useState<ResendStatus>("idle");

  async function handleResend() {
    if (!email) return;
    setStatus("sending");
    const supabase = createSupabaseBrowserClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${siteUrl}/auth/callback` },
    });
    setStatus(error ? "error" : "sent");
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <Heading level={2}>Check your email</Heading>
      <p className="text-navy-600">
        We&apos;ve sent a confirmation link
        {email && (
          <>
            {" "}
            to <span className="font-medium text-navy-900">{email}</span>
          </>
        )}
        . Click it to activate your account.
      </p>
      {email && (
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleResend}
            disabled={status === "sending" || status === "sent"}
          >
            {status === "sending"
              ? "Sending…"
              : status === "sent"
                ? "Email sent!"
                : "Resend email"}
          </Button>
          {status === "error" && (
            <p className="text-sm text-red-600">
              Something went wrong. Please try again in a moment.
            </p>
          )}
        </div>
      )}
      <Link href="/login" className="text-sm font-medium text-sky-600 hover:text-sky-700">
        Back to login
      </Link>
    </div>
  );
}
