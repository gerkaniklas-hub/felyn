import { SUPPORT_ERROR_CODES } from "./constants";

/**
 * Friendly copy for the SQLSTATEs the 0029 support functions raise. Pure (no
 * server imports) so it can be unit-tested; raw database messages never reach
 * the guest. `context` picks the wording for the action that failed.
 */
export type SupportErrorContext = "open" | "send";

export function getSupportErrorMessage(code: string | undefined | null, context: SupportErrorContext): string {
  switch (code) {
    case SUPPORT_ERROR_CODES.CLOSED:
      return "This conversation is closed. You can contact Felyn again to start a new one.";
    case SUPPORT_ERROR_CODES.NOT_FOUND:
      return context === "open"
        ? "We couldn't find that booking on your account."
        : "This conversation isn't available.";
    case SUPPORT_ERROR_CODES.INVALID_INPUT:
      return "Please choose a topic and write a message (up to 2,000 characters).";
    case SUPPORT_ERROR_CODES.NOT_ALLOWED:
      return "Please sign in again to contact Felyn.";
    default:
      return context === "open"
        ? "We couldn't send your message to Felyn. Please try again."
        : "We couldn't send that message. Please try again.";
  }
}

/** Friendly copy for the staff (admin) side of the same database errors. */
export function getStaffSupportErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case SUPPORT_ERROR_CODES.CLOSED:
      return "This conversation is closed. Reopen it to reply.";
    case SUPPORT_ERROR_CODES.ALREADY_OPEN:
      return "This customer already has another open conversation about this. Resolve or close that one first.";
    case SUPPORT_ERROR_CODES.NOT_FOUND:
      return "This conversation no longer exists.";
    case SUPPORT_ERROR_CODES.NOT_ALLOWED:
      return "Your account doesn't have access to Felyn Support.";
    case SUPPORT_ERROR_CODES.INVALID_INPUT:
      return "Please write a reply (up to 2,000 characters).";
    default:
      return "Something went wrong. Please try again.";
  }
}
