"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startHostPayoutOnboarding } from "@/lib/payments/actions";

/**
 * Opens Stripe's hosted onboarding for the host's connected account (test mode).
 * Readiness is never set here: it comes only from Stripe's verified account.updated
 * events (public.stripe_apply_event).
 */
export function HostPayoutSetupButton({ label }: { label: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startHostPayoutOnboarding();
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={start} disabled={pending} className="self-start">
        {pending ? "Opening Stripe…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
