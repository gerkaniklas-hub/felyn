# Stripe webhook signatures, verified twice

Status: **implemented, test mode only, not applied or deployed** (2026-10-13).
- Route check: `src/lib/payments/webhook-signature.ts` + `webhook.ts`. It uses no
  Stripe SDK; the same v1 scheme is implemented with `node:crypto`.
- Database check: `0037_stripe_test_mode.sql`. The secrets are in the `felyn_private`
  schema, as approved below.
- Procedure: `docs/payments/stripe-test-mode-runbook.md`.

Where this document still says Vault, read `felyn_private.stripe_webhook_secrets`.
Where it says `constructEvent`, read `verifyStripeSignature`. The original design
follows.

> **Superseded (2026-10-09): secret storage.** Section 3 below stores the webhook
> secrets in Supabase Vault. That is **no longer the plan**. A read-only check of
> the Felyn project showed that `service_role` has USAGE on `vault`, SELECT on
> `vault.decrypted_secrets` and `vault.secrets`, and EXECUTE on Vault decryption
> and secret-management functions. Those grants belong to Supabase, not to us, so
> Vault can't keep the secret away from a leaked `service_role` key.
>
> **Approved instead:** a private schema, `felyn_private`, owned by `postgres`:
> - not exposed to the Data API;
> - no grants to `anon`, `authenticated` or `service_role`, checked by migration
>   postconditions;
> - read only by the SECURITY DEFINER verification function.
>
> **This design has not been implemented or validated yet.** No migration, test or
> runbook exists for it.
>
> **Known limitation:** the secret is plaintext at rest in that table. It is
> readable by anyone with database-owner or dashboard access, or from a restored
> backup.
>
> The rest of this note (raw-body handling, tolerance, replay, rotation with
> current and previous secrets, ownership, grants, error handling) still applies.
> This document will be revised when the `felyn_private` design is implemented.

## Why verify in the database too

0035 lets only the owner of `booking_request_items` confirm a payment, and 0036
gives `service_role` (the server's secret key) no rights on the payment tables.
The Stage 3 webhook still needs one narrow, `service_role`-callable database
function that records Stripe events and, for a captured payment, calls 0035's
payment step. If that function trusted its arguments, a leaked `service_role` key
could call it with made-up data and confirm a booking that has an open payment
attempt. If the function re-checks Stripe's signature itself, a caller needs
**both** the secret key **and** the endpoint's signing secret. The Next.js route
keeps its own check too, so bad requests are refused early and cheaply.

## Stripe's signing scheme (checked against docs.stripe.com, 2026-10-09)

- Header: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=<hex>]`.
- Signed payload: `<t>` + `.` + the **exact raw request body** (UTF-8 bytes as
  sent). "The request body must be the exact UTF-8 string Stripe sent, without
  any modifications."
- Signature: HMAC-SHA256 of the signed payload, keyed with the endpoint secret
  (`whsec_…`), as lowercase hex. Only `v1` counts (`v0` is a test-mode legacy
  scheme and is ignored).
- Rotation ("Roll secret"): the old secret can stay valid for up to 24 hours;
  meanwhile "Stripe generates one signature per secret", so the header carries
  several `v1` values. Any match is accepted.
- Retries for up to three days. Stripe's libraries use a 300-second timestamp
  tolerance, which implies each delivery attempt is signed when it is sent. To
  confirm in test mode: compare `t` across retries of one event.

## Design

### 1. Raw body: bytes in, bytes hashed

- Route (Stage 3, Node runtime): `const raw = Buffer.from(await request.arrayBuffer())`.
  The route never parses JSON before both checks pass. It verifies with the
  official SDK (`stripe.webhooks.constructEvent(raw, header, secret)`), then
  calls the database function with `p_body_base64 = raw.toString("base64")`
  and `p_signature = header`.
- Database: `v_body := decode(p_body_base64, 'base64')` (bytea, byte-exact). The
  HMAC is computed over `convert_to(t, 'UTF8') || '\x2e'::bytea || v_body`. Only
  after verification: `v_event := convert_from(v_body, 'UTF8')::jsonb`.
- Why base64 and not `text`: a JSON string through PostgREST round-trips
  correctly for valid UTF-8, but bytes are bytes. Base64 removes any doubt
  about encoding, escaping or normalization.
- Limits, checked before any HMAC: header at most 2,048 characters; body at
  most 512 KiB (Stripe events are far smaller); `t` must be 1-12 digits; each
  `v1` must be exactly 64 hex characters; at most 4 `v1` values.

### 2. Timestamp tolerance and replay

- Refuse when `abs(extract(epoch from now()) - t) > 300` (5 minutes, Stripe's
  default), in either direction. A future timestamp means clock skew or
  forgery.
- **Replay inside the window:** a captured request can be replayed for up to 5
  minutes. It has the same `event.id`, so `stripe_events` (primary key
  `event_id`, 0036) turns it into a counted redelivery: no second effect. A
  payment is acted on only through its attempt row, and each transition happens
  once (0036 guards).
- **Replay after the window:** refused by the timestamp check.
- **Mode:** refuse when `event.livemode` differs from the database's expected
  mode. A one-row, owner-only config set when the project is set up: staging
  expects test mode, production expects live mode.
- **Endpoint:** the function takes `p_endpoint in ('platform', 'connect')`.
  Each endpoint has its own secret, and each event type is accepted only from
  its expected endpoint (e.g. `account.updated` only from `connect`).

### 3. Secrets in Supabase Vault

- Vault secrets, created in the Vault UI (not with `vault.create_secret()` in
  the SQL editor, which keeps the value in query history; same practice as
  `email_sweep_secret`):
  `stripe_webhook_secret_platform`, `stripe_webhook_secret_connect`, plus the
  optional rotation slots `…_platform_previous` and `…_connect_previous`.
- Read only inside the definer function:
  `select decrypted_secret from vault.decrypted_secrets where name = …`.
  Never returned, logged or included in an error message.
- **Precondition to check on staging before relying on this design:**
  `service_role` must not be able to read the Vault itself, or the second check
  adds nothing:
  `select has_schema_privilege('service_role', 'vault', 'usage'), has_table_privilege('service_role', 'vault.decrypted_secrets', 'select');`
  If either is `true` and can't be revoked (the Vault objects belong to
  Supabase's own role), the fallback is a private schema owned by `postgres`
  with no grants to any API role. That keeps the secret out of reach of every
  API key, but it is no longer encrypted with the Vault key.
- `pgcrypto` lives in Supabase's `extensions` schema. With `search_path = ''`,
  call `extensions.hmac(data bytea, key bytea, 'sha256')` fully qualified. The
  key is `convert_to(secret, 'UTF8')`, the whole `whsec_…` string, as Stripe's
  libraries use it. Precondition check:
  `select to_regprocedure('extensions.hmac(bytea, bytea, text)') is not null;`

### 4. Key rotation runbook

1. In Stripe, "Roll secret" for the endpoint, with a delay of up to 24 hours.
2. Copy the old value into `…_previous` (Vault UI). Put the new value in the
   main Vault secret and in Vercel (`STRIPE_WEBHOOK_SECRET` /
   `STRIPE_CONNECT_WEBHOOK_SECRET`), then redeploy. Both checks accept a match
   against either secret; the route's SDK check is given both secrets during
   the overlap.
3. After the old secret expires at Stripe, delete `…_previous` and the old
   Vercel value.

If the two checks ever disagree (the route verified but the database didn't),
the secrets are out of sync. See section 6.

### 5. Ownership and grants

- `public.stripe_apply_event(p_endpoint text, p_body_base64 text, p_signature text) returns jsonb`
  - `language plpgsql security definer set search_path = ''`, owned by
    `postgres`, the owner of `booking_request_items`. As the owner, its call to
    0035's payment step passes the update guard's owner check. Nothing else
    can.
  - `revoke execute … from public, anon, authenticated;`
    `grant execute … to service_role;`. The migration's postconditions check
    exactly that, as 0035/0036 do.
- One transaction per call:
  1. Validate the inputs.
  2. Verify the signature and timestamp.
  3. Check the mode and endpoint.
  4. Upsert `stripe_events`: a redelivery is counted; a different payload hash
     under the same id is refused.
  5. If the event was already processed, return its stored outcome.
  6. Otherwise apply it under the 0036 guards and record the outcome.

  Any error rolls the whole call back, so a failed attempt leaves no partial
  state and Stripe's retry starts clean.
- It writes **nothing** for an unverified request. Unverified data never
  reaches a table.
- Return value (never a secret or a raw error):
  `{"result": "invalid_signature" | "stale_timestamp" | "wrong_mode" | "wrong_endpoint" | "duplicate" | "processed" | "ignored", "action": null | "capture" | "cancel_authorization", "payment_intent_id": …}`.
  Under manual capture, the route uses `action` to make the Stripe call after
  the database has committed. Stage 3 will specify the exact sequencing between
  capture and confirmation.

### 6. How the route handles each outcome (Stage 3)

| Situation | Response | Why |
|---|---|---|
| Missing/invalid signature at the route (SDK check) | `400`, logged without the body | Not from Stripe (or the wrong secret); Stripe retries a misconfigured endpoint, and the logs show it |
| Route verified, database says `invalid_signature` | `500` + alert "webhook secrets out of sync" | Vercel and Vault disagree; Stripe retries for up to 3 days while it's fixed |
| `stale_timestamp` | `400` | Replay or bad clock; a genuine retry is re-signed |
| `wrong_mode` / `wrong_endpoint` | `400` + alert | Test event at live (or vice versa), or a misrouted endpoint |
| `duplicate` / `ignored` / `processed` | `200` (after any `action` succeeded) | Stops Stripe's retries |
| Database error or unreachable | `500` | Stripe retries; nothing was kept |

Responses never echo the body, the header or a secret.

## Decision needed

Recommended: adopt this design (verify at the route **and** in the database) in
Stage 3, provided both staging preconditions pass: no Vault access for
`service_role`, and `extensions.hmac` available. If the Vault check fails, use
the private-schema fallback, or decide to accept route-only verification, with
the risk that a leaked `service_role` key can confirm bookings that have open
attempts.
