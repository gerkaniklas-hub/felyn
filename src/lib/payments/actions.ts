"use server";

import { redirect } from "next/navigation";
import { assertGuestJourney } from "@/lib/journey-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildAccountLinkRequest,
  buildCheckoutSessionParams,
  buildRecipientAccountRequest,
  checkAttemptAmounts,
  describeStripeFailure,
  isStripeAccountId,
  isStripeCheckoutUrl,
  isStripeConnectUrl,
  isTestCheckoutSessionId,
  parsePaymentStart,
} from "./checkout";
import { getCheckoutTimingMessage, getPaymentStartErrorMessage, getPaymentStartMessage, PAYMENT_GENERIC_ERROR, PAYMENTS_UNAVAILABLE_MESSAGE } from "./messages";
import { createPaymentsAdminClient, getServerPayments } from "./server";
import { createStripeApi } from "./stripe-api";
import { getCheckoutWindow } from "./timing";

/**
 * The guest's "Pay now" and the host's "Set up payouts" (Stripe TEST MODE).
 *
 * Neither action ever marks anything paid or ready: they only open Stripe pages.
 * Payment and payout readiness are recorded exclusively from verified Stripe webhook
 * events (src/app/api/stripe/*, public.stripe_apply_event). Returning from Stripe
 * proves nothing; the booking page shows the database's state.
 *
 * On success both redirect to Stripe (redirect() is called outside any try/catch, as
 * Next.js requires); otherwise they return a message for the user.
 */
export type PaymentActionResult = { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function startBookingPayment(itemId: string): Promise<PaymentActionResult> {
  await assertGuestJourney();
  const payments = getServerPayments();
  if (!payments.enabled) return { ok: false, error: PAYMENTS_UNAVAILABLE_MESSAGE };
  if (typeof itemId !== "string" || !UUID.test(itemId)) return { ok: false, error: getPaymentStartMessage("not_found") };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: getPaymentStartErrorMessage("42501") };

  // The database computes the attempt from the booking's own snapshot (never from here).
  const { data, error } = await supabase.rpc("booking_payment_start", { p_item_id: itemId });
  if (error) return { ok: false, error: getPaymentStartErrorMessage(error.code) };
  const start = parsePaymentStart(data);
  const stripe = createStripeApi(payments.config.secretKey);

  let checkoutUrl: string | null = null;
  if (start.result === "existing") {
    // Resume the guest's own open session instead of creating a second one.
    const session = await stripe.retrieveCheckoutSession(start.checkoutSessionId);
    const url = session.ok && session.data.status === "open" ? session.data.url : null;
    if (!isStripeCheckoutUrl(url)) return { ok: false, error: getPaymentStartMessage("in_progress") };
    checkoutUrl = url;
  } else if (start.result === "created") {
    const admin = createPaymentsAdminClient();
    if (!admin) return { ok: false, error: PAYMENTS_UNAVAILABLE_MESSAGE };
    const fail = async (reason: string, message: string): Promise<PaymentActionResult> => {
      await admin.rpc("stripe_record_checkout_failure", { p_payment_id: start.paymentId, p_reason: reason });
      return { ok: false, error: message };
    };

    if (!checkAttemptAmounts(start).ok) {
      console.error("payments: the database's payment attempt failed the app's money checks; nothing was sent to Stripe");
      return fail("The payment amounts did not pass the server's checks", PAYMENT_GENERIC_ERROR);
    }
    const window = getCheckoutWindow(Date.now(), start.paymentDueAtMs);
    if (!window.ok) return fail("Too close to the payment deadline to start Checkout", getCheckoutTimingMessage(window.error));

    const session = await stripe.createCheckoutSession(
      buildCheckoutSessionParams({
        attempt: start,
        bookingItemId: itemId,
        expiresAtUnixSeconds: window.expiresAtUnixSeconds,
        appUrl: payments.config.appUrl,
        customerEmail: user.email ?? null,
      }),
      start.paymentId,
    );
    const sessionId = session.ok ? session.data.id : null;
    const sessionUrl = session.ok ? session.data.url : null;
    if (!isTestCheckoutSessionId(sessionId) || !isStripeCheckoutUrl(sessionUrl)) {
      console.error(`payments: Stripe did not create a Checkout session (status ${session.ok ? "ok" : session.status})`);
      return fail("Stripe did not create a Checkout session", PAYMENT_GENERIC_ERROR);
    }
    const recorded = await admin.rpc("stripe_record_checkout_session", {
      p_payment_id: start.paymentId,
      p_session_id: sessionId,
      p_expires_at: new Date(window.expiresAtMs).toISOString(),
    });
    if (recorded.error || recorded.data !== true) {
      // Never leave a payable session the database doesn't know about.
      await stripe.expireCheckoutSession(sessionId);
      return fail("The Checkout session could not be recorded", PAYMENT_GENERIC_ERROR);
    }
    checkoutUrl = sessionUrl;
  } else {
    return { ok: false, error: getPaymentStartMessage(start.result) };
  }

  redirect(checkoutUrl);
}

export async function startHostPayoutOnboarding(): Promise<PaymentActionResult> {
  const payments = getServerPayments();
  if (!payments.enabled) return { ok: false, error: "Payout setup isn't available yet." };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const { data: rows, error } = await supabase.rpc("host_payout_account_status");
  const status = Array.isArray(rows) ? (rows[0] as { provider_id?: string; stripe_account_id?: string | null } | undefined) : undefined;
  if (error || !status?.provider_id) return { ok: false, error: "Only approved Felyn hosts can set up payouts." };

  const stripe = createStripeApi(payments.config.secretKey);
  let accountId = status.stripe_account_id ?? null;
  if (!accountId) {
    const request = buildRecipientAccountRequest({ providerId: status.provider_id, email: user.email ?? null });
    if (!request) return { ok: false, error: "Your Felyn account needs an email address before you can set up payouts." };
    const created = await stripe.createRecipientAccount(request, status.provider_id);
    if (!created.ok || !isStripeAccountId(created.data.id)) {
      // Status, type, code and request id only: never the key, the email or Stripe's message.
      console.error(`payments: Stripe did not create a connected account (${created.ok ? "no account id in the response" : describeStripeFailure(created)})`);
      return { ok: false, error: "We couldn't start payout setup. Please try again in a moment." };
    }
    const admin = createPaymentsAdminClient();
    if (!admin) return { ok: false, error: "Payout setup isn't available yet." };
    // An existing account wins (a second click returns the first account).
    const registered = await admin.rpc("stripe_register_host_account", {
      p_provider_id: status.provider_id,
      p_account_id: created.data.id,
    });
    if (registered.error || !isStripeAccountId(registered.data)) {
      // Stripe created the account but Felyn didn't record it; the next click returns the same account (idempotency key).
      console.error(`payments: could not record the connected account (database code ${registered.error?.code ?? "none"})`);
      return { ok: false, error: "We couldn't start payout setup. Please try again in a moment." };
    }
    accountId = registered.data;
  }

  const link = await stripe.createAccountLink(buildAccountLinkRequest({ accountId, appUrl: payments.config.appUrl }));
  const linkUrl = link.ok ? link.data.url : null;
  if (!isStripeConnectUrl(linkUrl)) {
    console.error(`payments: Stripe did not create an onboarding link (${link.ok ? "unexpected link URL" : describeStripeFailure(link)})`);
    return { ok: false, error: "We couldn't open Stripe's payout setup. Please try again in a moment." };
  }
  redirect(linkUrl);
}
