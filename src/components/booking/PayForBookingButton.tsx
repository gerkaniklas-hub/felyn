"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startBookingPayment } from "@/lib/payments/actions";

/**
 * The guest's "Pay now" for a booking awaiting payment. It only opens Stripe's
 * hosted Checkout (the server action redirects there); it never marks anything
 * paid. Stripe test mode: no real card is charged.
 */
export function PayForBookingButton({ itemId, label }: { itemId: string; label: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pay() {
    setError(null);
    startTransition(async () => {
      const result = await startBookingPayment(itemId);
      // Only reached when the action did not redirect to Stripe.
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={pay} disabled={pending} className="self-start">
        {pending ? "Opening secure payment…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
