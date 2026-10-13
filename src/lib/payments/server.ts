import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readPaymentsConfig, type PaymentsConfig } from "./config";
import { getCheckoutWindow } from "./timing";

/**
 * The server's view of the payment configuration: payments are offered only when
 * PAYMENTS_ENABLED=true, the Stripe test-mode settings are complete and valid
 * (config.ts), and the server can reach the database with its secret key (the
 * webhook and the session recording need it). Anything less means "off".
 */
export type ServerPayments =
  | { enabled: true; config: PaymentsConfig }
  | { enabled: false; reason: "disabled" | "misconfigured" };

export function getServerPayments(): ServerPayments {
  const result = readPaymentsConfig(process.env);
  if (!result.ok) {
    // Names the variable, never its value (config.ts).
    console.error(`payments: configuration error — ${result.error}`);
    return { enabled: false, reason: "misconfigured" };
  }
  if (!result.config) return { enabled: false, reason: "disabled" };
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error("payments: configuration error — SUPABASE_SECRET_KEY is required when PAYMENTS_ENABLED=true");
    return { enabled: false, reason: "misconfigured" };
  }
  return { enabled: true, config: result.config };
}

/** Whether a new Checkout session could start now (timing.ts's 41-minute rule), for display only. */
export function canStartCheckoutNow(paymentDueAt: string | null): boolean {
  return getCheckoutWindow(Date.now(), paymentDueAt ? Date.parse(paymentDueAt) : NaN).ok;
}

/** Whether payment_due_at has passed (display only; the database refuses payment then anyway). */
export function isPaymentDeadlinePassed(paymentDueAt: string | null): boolean {
  const due = paymentDueAt ? Date.parse(paymentDueAt) : NaN;
  return Number.isFinite(due) && Date.now() >= due;
}

/** The service_role client for the payment functions only (0037 grants it nothing else). */
export function createPaymentsAdminClient() {
  return createSupabaseAdminClient();
}
