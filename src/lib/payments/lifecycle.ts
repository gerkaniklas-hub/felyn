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
