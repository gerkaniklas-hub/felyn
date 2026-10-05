/**
 * Delivery of ONE claimed outbox row. Every outside effect (database reads,
 * the auth admin lookup, Resend, the outbox updates) is passed in as a
 * dependency, so this logic is unit-tested without Supabase or Resend
 * (tests/email-dispatch.test.ts); dispatcher.ts wires the real ones.
 *
 * The row has already been claimed by claim_email_outbox() (status
 * 'sending', a fresh claim_token). Every finishing update in the real
 * dependencies is conditional on that claim_token, so a sender whose lease
 * expired and was re-claimed by another can no longer record a result.
 */
import type { EmailConfig } from "./config";
import {
  checkEventStillCurrent,
  ctaPathFor,
  isEmailEventType,
  isExpired,
  MAX_ATTEMPTS,
  parsePayload,
  recipientRoleFor,
  retryDelayMs,
  type CurrentBookingState,
  type OutboxRow,
} from "./events";
import type { SendEmailInput, SendEmailResult } from "./resend";
import { renderBookingEmail } from "./templates/booking-emails";

export type DispatchDeps = {
  config: EmailConfig;
  now: () => Date;
  /** Fresh state of the row's booking items and request; null when they no longer exist. Throws on read errors. */
  loadCurrentState: (row: OutboxRow) => Promise<CurrentBookingState | null>;
  /** The recipient's current email address; null when the account or its address no longer exists. Throws on lookup errors. */
  getRecipientEmail: (userId: string) => Promise<string | null>;
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  log: (message: string, details: Record<string, unknown>) => void;
  markSent: (row: OutboxRow, providerMessageId: string) => Promise<void>;
  markRetry: (row: OutboxRow, error: string, nextAttemptAt: Date) => Promise<void>;
  markFailed: (row: OutboxRow, error: string) => Promise<void>;
  markSkipped: (row: OutboxRow, reason: string) => Promise<void>;
};

export type DispatchOutcome = "sent" | "logged" | "retry" | "failed" | "skipped";

/** Stable per event: a retry of the same row reuses it, so Resend never delivers it twice. */
export function idempotencyKeyFor(row: OutboxRow): string {
  return `felyn-email-${row.id}`;
}

/** "ni***@gmail.com" — enough to recognise a test inbox in logs, not a full address. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function retryOrFail(row: OutboxRow, deps: DispatchDeps, error: string): Promise<DispatchOutcome> {
  if (row.attempts >= MAX_ATTEMPTS) {
    await deps.markFailed(row, error);
    return "failed";
  }
  await deps.markRetry(row, error, new Date(deps.now().getTime() + retryDelayMs(row.attempts)));
  return "retry";
}

export async function processClaimedRow(row: OutboxRow, deps: DispatchDeps): Promise<DispatchOutcome> {
  try {
    if (row.attempts > MAX_ATTEMPTS) {
      await deps.markFailed(row, "max_attempts_exceeded");
      return "failed";
    }
    if (isExpired(row.created_at, deps.now())) {
      await deps.markSkipped(row, "expired");
      return "skipped";
    }

    const type = row.event_type;
    const payload = parsePayload(row.payload);
    if (!isEmailEventType(type) || recipientRoleFor(type) !== row.recipient_role || !payload) {
      await deps.markFailed(row, "invalid_event_row");
      return "failed";
    }
    if (!row.recipient_user_id) {
      await deps.markSkipped(row, "no_recipient_account");
      return "skipped";
    }

    const state = await deps.loadCurrentState(row);
    if (!state) {
      await deps.markSkipped(row, "booking_missing");
      return "skipped";
    }
    const check = checkEventStillCurrent(type, state);
    if (!check.current) {
      await deps.markSkipped(row, check.reason);
      return "skipped";
    }

    const to = await deps.getRecipientEmail(row.recipient_user_id);
    if (!to) {
      await deps.markSkipped(row, "recipient_missing");
      return "skipped";
    }
    if (deps.config.allowlist && !deps.config.allowlist.has(to.toLowerCase())) {
      await deps.markSkipped(row, "not_allowlisted");
      return "skipped";
    }

    const ctaUrl = `${deps.config.appUrl}${ctaPathFor(type, row.booking_request_item_ids)}`;
    const email = await renderBookingEmail(type, payload, ctaUrl);

    if (deps.config.mode === "log") {
      deps.log("email (log only, not sent)", { event: type, to: maskEmail(to), subject: email.subject, cta: ctaUrl });
      await deps.markSkipped(row, "log_only");
      return "logged";
    }

    if (!deps.config.resendApiKey) {
      await deps.markFailed(row, "resend_not_configured");
      return "failed";
    }
    const result = await deps.send({
      apiKey: deps.config.resendApiKey,
      from: deps.config.from,
      to,
      replyTo: deps.config.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: idempotencyKeyFor(row),
    });
    if (result.ok) {
      await deps.markSent(row, result.id);
      return "sent";
    }
    if (!result.retryable) {
      await deps.markFailed(row, result.error);
      return "failed";
    }
    return await retryOrFail(row, deps, result.error);
  } catch (error) {
    // A read, lookup or update failed — try again later (bounded by MAX_ATTEMPTS).
    try {
      return await retryOrFail(row, deps, errorText(error));
    } catch (finishError) {
      // Could not even record the failure. The row stays 'sending' and is
      // re-claimed after the 10-minute lease (0028), with the same idempotency key.
      deps.log("email outbox: could not record a delivery result", { id: row.id, error: errorText(finishError) });
      return "retry";
    }
  }
}
