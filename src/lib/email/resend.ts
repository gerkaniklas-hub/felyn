/**
 * Minimal Resend client: one documented HTTP call (POST /emails), so no SDK
 * dependency is needed. `fetchImpl` is injectable for tests.
 *
 * Idempotency: Resend's documented `Idempotency-Key` header (1-256
 * characters, kept for 24 hours). Retrying with the same key and the same
 * payload returns the original response without sending again; the same key
 * with a different payload is rejected with 409 `invalid_idempotent_request`,
 * and a request while another with the same key is still in progress gets
 * 409 `concurrent_idempotent_requests`.
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";

export type SendEmailInput = {
  apiKey: string;
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; retryable: boolean; error: string };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

function describe(status: number, body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "error";
  const message = typeof record.message === "string" ? record.message : "";
  return `resend ${status} ${name}${message ? `: ${message}` : ""}`.slice(0, 500);
}

export async function sendWithResend(input: SendEmailInput, fetchImpl: FetchLike = fetch): Promise<SendEmailResult> {
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256) {
    return { ok: false, retryable: false, error: "idempotency key must be 1-256 characters" };
  }

  let response: Response;
  try {
    response = await fetchImpl(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure or timeout: the email may or may not have been accepted.
    // Retrying is safe because the retry carries the same idempotency key.
    return { ok: false, retryable: true, error: `resend request failed: ${error instanceof Error ? error.name : "unknown"}` };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok) {
    const id = body && typeof body === "object" ? (body as Record<string, unknown>).id : null;
    return typeof id === "string" && id.length > 0
      ? { ok: true, id: id.slice(0, 200) }
      : { ok: false, retryable: true, error: `resend ${response.status}: response without an id` };
  }

  const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : null;
  if (response.status === 409) {
    // In progress elsewhere -> try again later. Different payload under the same key -> never resend.
    return { ok: false, retryable: name === "concurrent_idempotent_requests", error: describe(response.status, body) };
  }
  const retryable = response.status === 429 || response.status >= 500;
  return { ok: false, retryable, error: describe(response.status, body) };
}
