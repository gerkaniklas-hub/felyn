/**
 * Stripe integration, Stage 1: pure rules about what a payment means for a
 * booking — kept apart from Stripe and the database so they can be tested.
 *
 * Two rules carried into the later stages:
 *   1. Only the database confirms a booking. CONFIRMED is reached solely through
 *      0035's owner-only payment step, driven by a verified Stripe payment (the
 *      app never calls it directly). Returning from Checkout to a success URL proves
 *      nothing: until the database says CONFIRMED, the guest sees "processing".
 *   2. Capturing the guest's payment and paying the host are separate events
 *      (decision 4: separate charges and transfers). The host's share stays in
 *      Felyn's Stripe balance until the experience is completed AND the database's
 *      release gate has released it (0036's transfer_released_at, set only by the
 *      release step — completion alone never releases anything); never for a
 *      refunded, disputed or blocked payment. The reasons match the database's
 *      transfer-blocker reasons (0036) where both have the same condition.
 *
 * Pure module (relative imports only), so it runs under `npm test` as well as in Next.js.
 */
import type { BookingItemStatus } from "../matching/booking-status";

/** What the guest's return from Stripe Checkout said, as read from the return URL. Untrusted. */
export type CheckoutReturn = "success" | "cancelled" | null;

export type GuestPaymentDisplayState =
  | "payment_required" // AWAITING_PAYMENT, nothing in progress
  | "processing" // AWAITING_PAYMENT, the guest came back from Checkout saying success: waiting for the verified payment
  | "payment_not_completed" // AWAITING_PAYMENT, the guest left Checkout without paying
  | "confirmed" // CONFIRMED (paid)
  | "payment_expired" // PAYMENT_EXPIRED
  | "not_payable"; // any other status: nothing to pay

/**
 * What to show the guest about paying. The booking status read from the
 * database decides; the Checkout return value only picks the wording while the
 * booking is still AWAITING_PAYMENT, and can never make it "confirmed".
 */
export function getGuestPaymentDisplayState(status: BookingItemStatus, checkoutReturn: CheckoutReturn): GuestPaymentDisplayState {
  switch (status) {
    case "CONFIRMED":
      return "confirmed";
    case "PAYMENT_EXPIRED":
      return "payment_expired";
    case "AWAITING_PAYMENT":
      if (checkoutReturn === "success") return "processing";
      if (checkoutReturn === "cancelled") return "payment_not_completed";
      return "payment_required";
    default:
      return "not_payable";
  }
}

/** Reads the `checkout` return parameter; anything unexpected counts as no return at all. */
export function parseCheckoutReturn(value: string | string[] | undefined): CheckoutReturn {
  return value === "success" || value === "cancelled" ? value : null;
}

/** The guest's latest payment attempt status (public.booking_payment_guest_status, 0037), or null. */
export type GuestAttemptStatus =
  | "creating" | "open" | "expired" | "failed" | "authorized" | "released" | "captured" | "confirmed" | "unconfirmable" | null;

export type GuestPaymentPanel =
  | "none" // not AWAITING_PAYMENT: the page shows the booking's own status
  | "pay" // the Pay button (also resumes an open Checkout session)
  | "pay_after_cancel" // the guest left Checkout without paying: Pay again
  | "processing" // money received or the guest says so: waiting for the verified webhook
  | "unavailable" // payments are switched off
  | "too_late" // under 41 minutes to the deadline and nothing in progress
  | "deadline_passed" // the deadline has passed but the booking isn't marked expired yet
  | "needs_support"; // captured but the booking couldn't be confirmed

/**
 * What the booking page offers while a booking awaits payment. The database decides
 * everything (status, attempt); the Checkout return value only picks the wording and
 * can never confirm anything. `canStartCheckout` is timing.ts's 41-minute rule.
 *
 * `deadlinePassed`: payment_due_at is in the past. Expiry to PAYMENT_EXPIRED is done
 * by 0035's expiry function (scheduled or run by hand) or lazily by the host's
 * next acceptance, so a booking can still read AWAITING_PAYMENT after its
 * deadline; it can no longer be paid either way (0035 FB002).
 */
export function getGuestPaymentPanel(input: {
  status: BookingItemStatus;
  attemptStatus: GuestAttemptStatus;
  checkoutReturn: CheckoutReturn;
  paymentsEnabled: boolean;
  canStartCheckout: boolean;
  deadlinePassed: boolean;
}): GuestPaymentPanel {
  if (input.status !== "AWAITING_PAYMENT") return "none";
  if (input.attemptStatus === "unconfirmable") return "needs_support";
  if (input.attemptStatus === "authorized" || input.attemptStatus === "captured" || input.attemptStatus === "confirmed") {
    return "processing";
  }
  if (input.deadlinePassed) return "deadline_passed";
  if (!input.paymentsEnabled) return "unavailable";
  const display = getGuestPaymentDisplayState(input.status, input.checkoutReturn);
  if (display === "processing" && (input.attemptStatus === "open" || input.attemptStatus === "creating")) return "processing";
  // An open session can still be resumed whatever the clock says (the database decides).
  if (input.attemptStatus !== "open" && !input.canStartCheckout) return "too_late";
  return display === "payment_not_completed" ? "pay_after_cancel" : "pay";
}

export type HostTransferInput = {
  bookingStatus: BookingItemStatus;
  /** booking_request_items.completed_at (0016), set once the experience's date has passed. */
  completedAt: string | null;
  /** When the database's release gate released the transfer (0036), or null. Never set from client input. */
  transferReleasedAt: string | null;
  /** The transfer is blocked for Felyn support to reconcile (0036's host_transfer_status = 'blocked'). */
  transferBlocked: boolean;
  /** The guest's payment was captured (money received, not just authorized). */
  paymentCaptured: boolean;
  /** The host's nominal share recorded for this payment (see money.ts). */
  hostShareCents: number;
  /** Anything refunded to the guest so far. */
  refundedCents: number;
  /** A dispute (chargeback) was opened on the payment. */
  disputed: boolean;
  /** A transfer to the host already exists for this booking. */
  transferAlreadyCreated: boolean;
};

export type HostTransferIneligibleReason =
  | "already_transferred"
  | "payment_not_captured"
  | "booking_not_confirmed"
  | "not_completed"
  | "disputed"
  | "refunded" // any refund, partial or full: support decides by hand in v1
  | "blocked"
  | "awaiting_release" // completed, but the release gate hasn't released it
  | "invalid_amount";

export type HostTransferEligibility =
  | { eligible: true; amountCents: number }
  | { eligible: false; reason: HostTransferIneligibleReason };

/**
 * Whether the host's share may now be transferred, and how much. Conservative
 * by design: anything unusual (a refund, a dispute, a block) stops the transfer
 * and leaves it to Felyn support. Checked in the same order as the database.
 */
export function getHostTransferEligibility(input: HostTransferInput): HostTransferEligibility {
  if (input.transferAlreadyCreated) return { eligible: false, reason: "already_transferred" };
  if (!input.paymentCaptured) return { eligible: false, reason: "payment_not_captured" };
  if (input.bookingStatus !== "CONFIRMED") return { eligible: false, reason: "booking_not_confirmed" };
  if (!input.completedAt) return { eligible: false, reason: "not_completed" };
  if (input.disputed) return { eligible: false, reason: "disputed" };
  if (input.refundedCents !== 0) return { eligible: false, reason: "refunded" };
  if (input.transferBlocked) return { eligible: false, reason: "blocked" };
  if (!input.transferReleasedAt) return { eligible: false, reason: "awaiting_release" };
  if (!Number.isSafeInteger(input.hostShareCents) || input.hostShareCents <= 0) return { eligible: false, reason: "invalid_amount" };
  return { eligible: true, amountCents: input.hostShareCents };
}
