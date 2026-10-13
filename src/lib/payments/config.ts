/**
 * Stripe payment configuration, read from server-only environment variables.
 * Pure (takes the env as an argument, never reads or changes process.env
 * itself) so it can be unit-tested, like ../email/config.ts. The server reads
 * it through ./server.ts.
 *
 *   PAYMENTS_ENABLED               true | false (default false: no payment is offered)
 *   STRIPE_MODE                    test — required when enabled. THIS BUILD IS TEST MODE ONLY:
 *                                  "live" is refused (and the database, 0037, refuses live
 *                                  events and attempts too). Going live needs a reviewed change.
 *   STRIPE_SECRET_KEY              sk_test_ / rk_test_ (a restricted rk_ key is preferred);
 *                                  any live key is refused
 *   STRIPE_WEBHOOK_SECRET          whsec_... for the platform webhook endpoint
 *   STRIPE_CONNECT_WEBHOOK_SECRET  whsec_... for the Connect (connected accounts) endpoint
 *   PAYMENTS_APP_URL               origin for Checkout/onboarding return links (http allowed in
 *                                  test mode, e.g. http://localhost:3000)
 *
 * None of these may ever be NEXT_PUBLIC_. Error messages name the variable,
 * never its value.
 */
export type StripeMode = "test" | "live";

export type PaymentsConfig = {
  /** Always "test" in this build (live is refused above and by the database). */
  mode: "test";
  secretKey: string;
  webhookSecret: string;
  connectWebhookSecret: string;
  /** Origin only, no trailing slash. */
  appUrl: string;
};

export type PaymentsConfigResult =
  | { ok: true; config: PaymentsConfig }
  | { ok: true; config: null } // payments are off
  | { ok: false; error: string };

type Env = Record<string, string | undefined>;

const SECRET_KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9]{10,}$/;

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

export function readPaymentsConfig(env: Env): PaymentsConfigResult {
  const enabled = clean(env.PAYMENTS_ENABLED)?.toLowerCase() ?? "false";
  if (enabled === "false") return { ok: true, config: null };
  if (enabled !== "true") return { ok: false, error: "PAYMENTS_ENABLED must be true or false" };

  const mode = clean(env.STRIPE_MODE)?.toLowerCase();
  if (mode === "live") {
    return { ok: false, error: "STRIPE_MODE=live is not supported: this build accepts Stripe test mode only" };
  }
  if (mode !== "test") return { ok: false, error: "STRIPE_MODE must be test when PAYMENTS_ENABLED=true" };

  const secretKey = clean(env.STRIPE_SECRET_KEY);
  if (!secretKey) return { ok: false, error: "STRIPE_SECRET_KEY is required when PAYMENTS_ENABLED=true" };
  const keyMatch = SECRET_KEY_PATTERN.exec(secretKey);
  if (!keyMatch) return { ok: false, error: "STRIPE_SECRET_KEY is not a Stripe secret or restricted key" };
  if (keyMatch[2] !== "test") return { ok: false, error: "STRIPE_SECRET_KEY is a live-mode key; this build accepts test-mode keys only" };

  const webhookSecret = clean(env.STRIPE_WEBHOOK_SECRET);
  if (!webhookSecret) return { ok: false, error: "STRIPE_WEBHOOK_SECRET is required when PAYMENTS_ENABLED=true" };
  if (!WEBHOOK_SECRET_PATTERN.test(webhookSecret)) return { ok: false, error: "STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret" };

  const connectWebhookSecret = clean(env.STRIPE_CONNECT_WEBHOOK_SECRET);
  if (!connectWebhookSecret) return { ok: false, error: "STRIPE_CONNECT_WEBHOOK_SECRET is required when PAYMENTS_ENABLED=true" };
  if (!WEBHOOK_SECRET_PATTERN.test(connectWebhookSecret)) {
    return { ok: false, error: "STRIPE_CONNECT_WEBHOOK_SECRET is not a Stripe webhook signing secret" };
  }
  if (connectWebhookSecret === webhookSecret) {
    return { ok: false, error: "STRIPE_CONNECT_WEBHOOK_SECRET must differ from STRIPE_WEBHOOK_SECRET (one per endpoint)" };
  }

  const rawAppUrl = clean(env.PAYMENTS_APP_URL);
  if (!rawAppUrl) return { ok: false, error: "PAYMENTS_APP_URL is required when PAYMENTS_ENABLED=true" };
  const appUrl = normalizeOrigin(rawAppUrl, false);
  if (!appUrl) return { ok: false, error: "PAYMENTS_APP_URL is not a valid origin" };

  return { ok: true, config: { mode: "test", secretKey, webhookSecret, connectWebhookSecret, appUrl } };
}
