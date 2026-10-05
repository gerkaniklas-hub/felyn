/**
 * Email delivery configuration, read from server-only environment variables.
 * Pure (takes the env as an argument) so it can be unit-tested.
 *
 *   EMAIL_DELIVERY_MODE        off (default) | log | send
 *                              off:  the sender does nothing; outbox rows wait (and expire after 23 h)
 *                              log:  rows are processed and rendered, logged, and marked skipped ("log_only") — nothing is sent
 *                              send: rows are delivered through Resend
 *   RESEND_API_KEY             required for send
 *   EMAIL_FROM                 required for send, e.g. "Felyn <bookings@felyn.eu>"
 *   EMAIL_REPLY_TO             optional, a plain address
 *   EMAIL_APP_URL              base for every email link; required for send and must be https
 *                              (production: https://app.felyn.eu). log mode falls back to NEXT_PUBLIC_SITE_URL.
 *   EMAIL_RECIPIENT_ALLOWLIST  optional, comma-separated addresses; when set, every other recipient is skipped
 */
export type EmailDeliveryMode = "off" | "log" | "send";

export type EmailConfig = {
  mode: EmailDeliveryMode;
  from: string;
  replyTo: string | null;
  /** Origin only, no trailing slash. */
  appUrl: string;
  resendApiKey: string | null;
  /** Lower-cased addresses, or null for no restriction. */
  allowlist: Set<string> | null;
};

export type EmailConfigResult =
  | { ok: true; config: EmailConfig }
  | { ok: true; config: null } // delivery is off
  | { ok: false; error: string };

type Env = Record<string, string | undefined>;

const EMAIL_PATTERN = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;
/** "Name <address>" or a bare address; no line breaks (header injection). */
const FROM_PATTERN = /^(?:[^\r\n<>"]{1,80} )?<?[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+>?$/;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** An http(s) origin with no path, query or credentials. */
function normalizeOrigin(value: string, requireHttps: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && !requireHttps) return url.origin;
  return null;
}

export function readEmailConfig(env: Env): EmailConfigResult {
  const rawMode = clean(env.EMAIL_DELIVERY_MODE)?.toLowerCase() ?? "off";
  if (rawMode === "off") return { ok: true, config: null };
  if (rawMode !== "log" && rawMode !== "send") {
    return { ok: false, error: `EMAIL_DELIVERY_MODE must be off, log or send (got "${rawMode}")` };
  }
  const mode: EmailDeliveryMode = rawMode;

  const from = clean(env.EMAIL_FROM);
  if (mode === "send" && !from) return { ok: false, error: "EMAIL_FROM is required when EMAIL_DELIVERY_MODE=send" };
  if (from && !FROM_PATTERN.test(from)) return { ok: false, error: "EMAIL_FROM is not a valid sender" };

  const replyTo = clean(env.EMAIL_REPLY_TO);
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) return { ok: false, error: "EMAIL_REPLY_TO is not a valid address" };

  const resendApiKey = clean(env.RESEND_API_KEY);
  if (mode === "send" && !resendApiKey) return { ok: false, error: "RESEND_API_KEY is required when EMAIL_DELIVERY_MODE=send" };

  const rawAppUrl = clean(env.EMAIL_APP_URL) ?? (mode === "log" ? (clean(env.NEXT_PUBLIC_SITE_URL) ?? "http://localhost:3000") : null);
  if (!rawAppUrl) return { ok: false, error: "EMAIL_APP_URL is required when EMAIL_DELIVERY_MODE=send" };
  const appUrl = normalizeOrigin(rawAppUrl, mode === "send");
  if (!appUrl) {
    return {
      ok: false,
      error: mode === "send" ? "EMAIL_APP_URL must be an https origin, e.g. https://app.felyn.eu" : "EMAIL_APP_URL is not a valid origin",
    };
  }

  const allowlistEntries = (clean(env.EMAIL_RECIPIENT_ALLOWLIST) ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowlistEntries.some((entry) => !EMAIL_PATTERN.test(entry))) {
    return { ok: false, error: "EMAIL_RECIPIENT_ALLOWLIST contains an invalid address" };
  }

  return {
    ok: true,
    config: {
      mode,
      from: from ?? "Felyn <bookings@felyn.eu>",
      replyTo,
      appUrl,
      resendApiKey,
      allowlist: allowlistEntries.length > 0 ? new Set(allowlistEntries) : null,
    },
  };
}
