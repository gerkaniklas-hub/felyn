/**
 * Signup runs before the account has a session (email confirmation comes
 * first), so it can't write user_contact_details yet. It leaves the number
 * it validated in user_metadata under these keys; the first signed-in visit
 * to /account/mobile re-validates it server-side, saves it to
 * user_contact_details and clears them. They are never read as a source of
 * truth anywhere else.
 */
export const PENDING_PHONE_NUMBER_KEY = "pending_phone_number";
export const PENDING_PHONE_COUNTRY_KEY = "pending_phone_country";

/**
 * Where /account/mobile may continue to once the number is saved (the same
 * landing pages a login can have). Anything else falls back to /home.
 */
const ACCOUNT_DESTINATIONS = new Set(["/home", "/provider", "/host/apply"]);

export function safeAccountDestination(value: string | null | undefined): string {
  return value && ACCOUNT_DESTINATIONS.has(value) ? value : "/home";
}

/** The step every new account passes through after confirming its email or logging in without a number. */
export function mobileStepHref(destination: string): string {
  return `/account/mobile?next=${encodeURIComponent(safeAccountDestination(destination))}`;
}
