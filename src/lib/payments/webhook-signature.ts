/**
 * Stripe webhook signatures, the route's own check (the database checks again
 * in public.stripe_apply_event, 0037 — docs/payments/webhook-signature-verification.md).
 *
 * Stripe's v1 scheme: header `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]`;
 * signed payload = `<t>` + "." + the EXACT raw request body bytes; signature =
 * HMAC-SHA256(payload, whole whsec_ secret), lowercase hex. Only v1 counts (v0 is
 * ignored). Any v1 matching any given secret is accepted (secret rotation). The
 * timestamp must be within `toleranceSeconds` of now, either way.
 *
 * The body is never parsed here, and nothing about the secret or the body ever
 * appears in a result. Pure apart from node:crypto, so it runs under `npm test`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const MAX_SIGNATURE_HEADER_LENGTH = 2048;
const MAX_V1_SIGNATURES = 4;

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; error: "malformed" | "stale_timestamp" | "invalid_signature" };

export function verifyStripeSignature(
  rawBody: Uint8Array,
  header: string | null,
  secrets: readonly string[],
  nowSeconds: number,
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): SignatureCheck {
  if (!header || header.length > MAX_SIGNATURE_HEADER_LENGTH) return { ok: false, error: "malformed" };
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(",")) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== null) return { ok: false, error: "malformed" };
      timestamp = value;
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return { ok: false, error: "malformed" };
      signatures.push(value);
    }
  }
  if (timestamp === null || !/^[0-9]{1,12}$/.test(timestamp) || signatures.length < 1 || signatures.length > MAX_V1_SIGNATURES) {
    return { ok: false, error: "malformed" };
  }
  const t = Number(timestamp);
  if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, error: "stale_timestamp" };

  const payload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(rawBody)]);
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(payload).digest();
    for (const signature of signatures) {
      if (timingSafeEqual(expected, Buffer.from(signature, "hex"))) return { ok: true, timestamp: t };
    }
  }
  return { ok: false, error: "invalid_signature" };
}

/** Builds a valid header for a body — used by tests and local tooling only, never by the route. */
export function signStripePayloadForTest(rawBody: Uint8Array, secret: string, timestamp: number): string {
  const signature = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(rawBody)]))
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
