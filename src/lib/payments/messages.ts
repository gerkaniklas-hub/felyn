/**
 * What the guest or host is told when a payment step can't go ahead. Pure, so the
 * wording for every database answer and error code is tested. Never includes an
 * amount, an id or an internal error.
 */
import { getCheckoutWindowErrorMessage, type CheckoutWindowError } from "./timing";

export const PAYMENTS_UNAVAILABLE_MESSAGE = "Online payment isn't available yet. Your booking stays reserved until the payment deadline.";
export const PAYMENT_GENERIC_ERROR = "We couldn't start the payment. Please try again in a moment.";

/** booking_payment_start answers other than "created" / "existing". */
export function getPaymentStartMessage(result: "not_found" | "not_payable" | "in_progress" | "processing" | "needs_support" | "invalid"): string {
  switch (result) {
    case "not_found":
      return "We couldn't find this booking.";
    case "not_payable":
      return "This booking isn't waiting for payment any more. Refresh the page to see its current status.";
    case "in_progress":
      return "A payment for this booking is already being started. Please wait a minute, then try again.";
    case "processing":
      return "We've received your payment and are confirming your booking. This page will update shortly.";
    case "needs_support":
      return "Something went wrong with this payment. Please use \"Get help\" below so the Felyn team can sort it out.";
    default:
      return PAYMENT_GENERIC_ERROR;
  }
}

/** Database error codes from starting a payment (0036's attempt guard, 0037). */
export function getPaymentStartErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "FB005":
      return getCheckoutWindowErrorMessage("too_late_to_start_checkout");
    case "FB002":
      return getCheckoutWindowErrorMessage("payment_deadline_passed");
    case "FB004":
      return "This experience is priced below the €5 per person minimum, so it can't be paid for online.";
    case "FB006":
      return "Your host hasn't finished setting up payouts yet, so this booking can't be paid online right now. Please message your host or contact Felyn support.";
    case "42501":
      return "Please sign in again to pay for this booking.";
    default:
      return PAYMENT_GENERIC_ERROR;
  }
}

export function getCheckoutTimingMessage(error: CheckoutWindowError): string {
  return getCheckoutWindowErrorMessage(error);
}
