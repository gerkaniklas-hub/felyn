-- 0037: Stripe test mode — Checkout payment attempts, Connect payout accounts and
-- webhook events verified inside the database
--
-- ONE SQL statement (a single DO block), same form as 0023-0036: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state.
--
-- RELEASE NOTE: apply after 0035 and 0036 (in that order), together with the app
-- version that calls these functions. TEST MODE ONLY: this migration pins the database
-- to Stripe test mode (felyn_private.stripe_settings.livemode = false). Live events,
-- live sessions and live payment attempts are refused by the database itself; going
-- live needs a later, reviewed migration.
--
-- What it adds (nothing existing is redefined; 0035's payment step and 0036's guards
-- are used as they are):
--
--   * felyn_private — a schema owned by postgres with NO privileges for anon,
--     authenticated or service_role (not exposed to the Data API either):
--       - stripe_settings: one row, the Stripe mode the database accepts (test).
--       - stripe_webhook_secrets: the endpoints' signing secrets (whsec_...), one
--         'current' and an optional 'previous' (rotation) per endpoint. EMPTY after this
--         migration: the owner adds them by hand (see the README). Known limitation:
--         plaintext at rest, readable by the database owner, the dashboard and backups.
--       - stripe_signature_check(): Stripe's v1 scheme (HMAC-SHA256 of "<t>.<raw body>"
--         with pgcrypto), 300-second timestamp tolerance, any current/previous secret.
--       - stripe_process_event() / stripe_payment_action(): what each verified event
--         does (below).
--   * public.stripe_apply_event(endpoint, body_base64, signature) — the ONLY way a
--     Stripe event changes anything. service_role only. It re-verifies Stripe's
--     signature over the exact raw body (so a leaked service_role key alone can't forge
--     a payment), refuses live events, refuses event types sent to the wrong endpoint,
--     deduplicates by event id (stripe_events, 0036: a redelivery is counted, never
--     applied twice) and applies the event in the same transaction:
--       checkout.session.completed  open -> authorized (manual capture: money held, not
--                                   taken); answers action "capture" while the booking is
--                                   still AWAITING_PAYMENT and more than 2 minutes before
--                                   payment_due_at, otherwise releases the attempt and
--                                   answers "cancel_authorization". A session that matches
--                                   no open attempt (or a different amount) is never kept:
--                                   "cancel_authorization".
--       checkout.session.expired    open -> expired
--       payment_intent.succeeded    authorized -> captured, then 0035's owner-only payment
--                                   step (booking_item_mark_paid): booking CONFIRMED and
--                                   attempt confirmed, host transfer pending. If the booking
--                                   can no longer be confirmed (deadline passed, FB002):
--                                   unconfirmable, transfer blocked, refund via support.
--       payment_intent.canceled     authorized -> released
--       charge.refunded             refunded amount recorded; the host transfer is blocked
--       charge.dispute.*            dispute recorded; the host transfer is blocked
--       account.updated (Connect)   host payout account synced (out-of-order safe)
--     No event creates a host transfer or a payout: nothing in this migration does.
--     No event sends an email: payment confirmation only changes the booking status,
--     which (0035) creates an in-app notice and no email.
--   * public.booking_payment_start(item) — authenticated (the guest): starts a payment
--     attempt for their own AWAITING_PAYMENT booking with the amounts computed here
--     from the booking's own snapshot (never from the client); 0036's insert guard
--     re-checks everything (FB004 €5, FB005 41 minutes, FB006 host not ready). Returns
--     an existing open Checkout session instead of a second attempt; abandons attempts
--     stuck in 'creating' for 15 minutes.
--   * public.booking_payment_guest_status(item) — authenticated: the guest's latest
--     attempt status for their own booking (to show "processing" honestly).
--   * public.host_payout_account_status() — authenticated: the calling host's own payout
--     account state.
--   * public.stripe_record_checkout_session / stripe_record_checkout_failure /
--     stripe_register_host_account — service_role only: record what the server got back
--     from Stripe's API (a session for an attempt still 'creating', expiring at least
--     10 minutes before the deadline; or a failure; or a host's new connected account).
--     None of them can make a payment authorized, captured or confirmed, or a host ready
--     for payouts: only verified events can.
--
-- Error codes reused: FB004 / FB005 / FB006 (0036) from the attempt insert guard.
--
-- Run as role `postgres` (the owner of booking_request_items), the whole file, in one
-- run, after 0036.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.booking_request_items'::regclass)
     is distinct from (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '0037 ABORTED: run this as the owner of public.booking_request_items (postgres)';
  end if;
  if to_regclass('public.booking_payments') is null or to_regclass('public.stripe_events') is null
     or to_regclass('public.host_payout_accounts') is null
     or to_regprocedure('public.support_staff_release_host_transfer(uuid, text)') is null
     or to_regprocedure('public.booking_item_mark_paid(uuid)') is null
     or position('interval ''60 minutes''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0 then
    raise exception '0037 ABORTED: 0035 and 0036 (payment states, Stripe payment foundation) are not applied';
  end if;
  if to_regprocedure('extensions.hmac(bytea, bytea, text)') is null then
    raise exception '0037 ABORTED: pgcrypto''s extensions.hmac(bytea, bytea, text) is not available';
  end if;
  if to_regnamespace('felyn_private') is not null then
    raise exception '0037 ABORTED: schema felyn_private already exists';
  end if;
  for r in select unnest(array['public.stripe_apply_event(text, text, text)', 'public.booking_payment_start(uuid)',
                               'public.booking_payment_guest_status(uuid)', 'public.host_payout_account_status()',
                               'public.stripe_record_checkout_session(uuid, text, timestamp with time zone)',
                               'public.stripe_record_checkout_failure(uuid, text)',
                               'public.stripe_register_host_account(uuid, text)']) as fn loop
    if to_regprocedure(r.fn) is not null then
      raise exception '0037 ABORTED: % already exists', r.fn;
    end if;
  end loop;

  -- ═════════ 2. MIGRATION ═════════
  -- ── the private schema: owner only ──
  create schema felyn_private;
  revoke all on schema felyn_private from public, anon, authenticated, service_role;

  -- The Stripe mode this database accepts. One row; TEST MODE (livemode = false).
  create table felyn_private.stripe_settings (
    id boolean primary key default true,
    livemode boolean not null,
    updated_at timestamptz not null default now(),
    constraint stripe_settings_single_row check (id)
  );
  insert into felyn_private.stripe_settings (id, livemode) values (true, false);

  -- The webhook endpoints' signing secrets, added by hand by the owner (README).
  create table felyn_private.stripe_webhook_secrets (
    endpoint text not null,
    slot text not null,
    secret text not null,
    created_at timestamptz not null default now(),
    primary key (endpoint, slot),
    constraint stripe_webhook_secrets_endpoint_check check (endpoint in ('platform', 'connect')),
    constraint stripe_webhook_secrets_slot_check check (slot in ('current', 'previous')),
    constraint stripe_webhook_secrets_secret_check check (secret ~ '^whsec_[A-Za-z0-9]{10,}$')
  );
  revoke all on table felyn_private.stripe_settings from public, anon, authenticated, service_role;
  revoke all on table felyn_private.stripe_webhook_secrets from public, anon, authenticated, service_role;

  -- Stripe's v1 webhook signature: header "t=<unix seconds>,v1=<hex>[,v1=<hex>...]",
  -- signed payload "<t>" || "." || <raw body bytes>, HMAC-SHA256 keyed with the whole
  -- whsec_ string, lowercase hex. Any v1 matching any configured secret counts (secret
  -- rotation). 300 seconds of tolerance either way. Never returns or logs a secret.
  create function felyn_private.stripe_signature_check(p_endpoint text, p_body bytea, p_header text)
  returns text language plpgsql stable security definer set search_path = '' as $fn$
  declare
    v_part text;
    v_key text;
    v_value text;
    v_t text;
    v_signatures text[] := '{}';
    v_payload bytea;
    v_secret text;
    v_expected bytea;
    v_signature text;
  begin
    if p_header is null or char_length(p_header) > 2048 or p_body is null then
      return 'malformed';
    end if;
    foreach v_part in array string_to_array(p_header, ',') loop
      v_part := btrim(v_part);
      v_key := split_part(v_part, '=', 1);
      v_value := substr(v_part, char_length(v_key) + 2);
      if v_key = 't' then
        if v_t is not null then
          return 'malformed';
        end if;
        v_t := v_value;
      elsif v_key = 'v1' then
        if v_value !~ '^[0-9a-f]{64}$' then
          return 'malformed';
        end if;
        v_signatures := v_signatures || v_value;
      end if;
    end loop;
    if v_t is null or v_t !~ '^[0-9]{1,12}$' or cardinality(v_signatures) not between 1 and 4 then
      return 'malformed';
    end if;
    if abs(extract(epoch from now()) - v_t::numeric) > 300 then
      return 'stale_timestamp';
    end if;
    if not exists (select 1 from felyn_private.stripe_webhook_secrets s where s.endpoint = p_endpoint) then
      return 'not_configured';
    end if;
    v_payload := convert_to(v_t || '.', 'UTF8') || p_body;
    for v_secret in select s.secret from felyn_private.stripe_webhook_secrets s where s.endpoint = p_endpoint loop
      -- Compare digests of the two values, never the raw strings (no early-exit timing on the HMAC).
      v_expected := pg_catalog.sha256(convert_to(encode(extensions.hmac(v_payload, convert_to(v_secret, 'UTF8'), 'sha256'), 'hex'), 'UTF8'));
      foreach v_signature in array v_signatures loop
        if pg_catalog.sha256(convert_to(v_signature, 'UTF8')) = v_expected then
          return 'ok';
        end if;
      end loop;
    end loop;
    return 'invalid_signature';
  end $fn$;

  -- What to do with an authorized (held, not captured) payment now, decided by the
  -- database at the moment of the call: capture it while the booking can still be
  -- confirmed with a margin, otherwise release the attempt and cancel the authorization.
  create function felyn_private.stripe_payment_action(p_payment_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $fn$
  declare
    v record;
  begin
    select bp.id, bp.status, bp.payment_intent_id, bri.status as item_status, bri.payment_due_at into v
      from public.booking_payments bp
      join public.booking_request_items bri on bri.id = bp.booking_request_item_id
     where bp.id = p_payment_id
       for update of bp;
    if not found then
      return '{}'::jsonb;
    end if;
    if v.status = 'authorized' then
      if v.item_status = 'AWAITING_PAYMENT' and v.payment_due_at > now() + interval '2 minutes' then
        return jsonb_build_object('action', 'capture', 'payment_intent_id', v.payment_intent_id);
      end if;
      update public.booking_payments bp
         set status = 'released', closed_at = now(),
             failure_reason = 'Authorization released: the booking could no longer be paid'
       where bp.id = v.id;
      return jsonb_build_object('action', 'cancel_authorization', 'payment_intent_id', v.payment_intent_id);
    elsif v.status = 'released' then
      return jsonb_build_object('action', 'cancel_authorization', 'payment_intent_id', v.payment_intent_id);
    end if;
    return '{}'::jsonb;
  end $fn$;

  -- Applies ONE verified, new event. Returns {status: processed|ignored, outcome,
  -- payment_id?, action?, payment_intent_id?}. Runs inside stripe_apply_event's
  -- transaction: any error rolls back the event row too, and Stripe retries.
  create function felyn_private.stripe_process_event(p_type text, p_event jsonb)
  returns jsonb language plpgsql security definer set search_path = '' as $fn$
  declare
    v_obj jsonb := p_event -> 'data' -> 'object';
    v_bp public.booking_payments;
    v_acct public.host_payout_accounts;
    v_session text;
    v_meta text;
    v_pi text;
    v_charge text;
    v_dispute text;
    v_amount numeric;
    v_paid boolean;
    v_synced timestamptz;
  begin
    -- ── Checkout ──
    if p_type in ('checkout.session.completed', 'checkout.session.expired') then
      v_session := v_obj ->> 'id';
      v_meta := v_obj -> 'metadata' ->> 'felyn_payment_id';
      if coalesce(v_obj ->> 'mode', '') <> 'payment' then
        return jsonb_build_object('status', 'ignored', 'outcome', 'not a payment session');
      end if;
      select * into v_bp from public.booking_payments bp where bp.checkout_session_id = v_session for update;
      if v_bp.id is null and v_meta ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        -- The server may have failed to record the session (the attempt is still 'creating').
        select * into v_bp from public.booking_payments bp
         where bp.id = v_meta::uuid and bp.checkout_session_id is null for update;
      end if;

      if p_type = 'checkout.session.expired' then
        if v_bp.id is null then
          return jsonb_build_object('status', 'ignored', 'outcome', 'unmatched session');
        end if;
        if v_bp.status = 'creating' and jsonb_typeof(v_obj -> 'expires_at') = 'number' then
          update public.booking_payments bp
             set status = 'open', checkout_session_id = v_session,
                 checkout_expires_at = to_timestamp((v_obj ->> 'expires_at')::double precision), session_opened_at = now()
           where bp.id = v_bp.id;
          v_bp.status := 'open';
        end if;
        if v_bp.status <> 'open' then
          return jsonb_build_object('status', 'ignored', 'outcome', 'attempt already closed', 'payment_id', v_bp.id);
        end if;
        update public.booking_payments bp set status = 'expired', closed_at = now() where bp.id = v_bp.id;
        return jsonb_build_object('status', 'processed', 'outcome', 'expired', 'payment_id', v_bp.id);
      end if;

      -- checkout.session.completed (manual capture: the money is authorized, not taken)
      v_pi := case when jsonb_typeof(v_obj -> 'payment_intent') = 'string' then v_obj ->> 'payment_intent' end;
      if v_pi is not null and v_pi !~ '^pi_[A-Za-z0-9]{1,250}$' then
        v_pi := null;
      end if;
      if v_bp.id is null then
        if v_pi is not null then
          return jsonb_build_object('status', 'processed', 'outcome', 'cancel_authorization:' || v_pi,
                                    'action', 'cancel_authorization', 'payment_intent_id', v_pi);
        end if;
        return jsonb_build_object('status', 'ignored', 'outcome', 'unmatched session');
      end if;
      if v_bp.status in ('creating', 'open') then
        if v_pi is null
           or coalesce(v_obj ->> 'status', '') <> 'complete'
           or jsonb_typeof(v_obj -> 'amount_total') is distinct from 'number'
           or (v_obj ->> 'amount_total')::numeric <> v_bp.gross_cents
           or lower(coalesce(v_obj ->> 'currency', '')) <> 'eur'
           or (v_meta is not null and v_meta <> v_bp.id::text) then
          update public.booking_payments bp
             set status = 'failed', closed_at = now(),
                 failure_reason = 'The completed Checkout session did not match this payment attempt'
           where bp.id = v_bp.id;
          if v_pi is not null then
            return jsonb_build_object('status', 'processed', 'outcome', 'cancel_authorization:' || v_pi, 'payment_id', v_bp.id,
                                      'action', 'cancel_authorization', 'payment_intent_id', v_pi);
          end if;
          return jsonb_build_object('status', 'processed', 'outcome', 'mismatched session', 'payment_id', v_bp.id);
        end if;
        if v_bp.status = 'creating' then
          update public.booking_payments bp
             set status = 'open', checkout_session_id = v_session,
                 checkout_expires_at = to_timestamp((v_obj ->> 'expires_at')::double precision), session_opened_at = now()
           where bp.id = v_bp.id;
        end if;
        update public.booking_payments bp
           set status = 'authorized', payment_intent_id = v_pi, authorized_at = now()
         where bp.id = v_bp.id;
        return jsonb_build_object('status', 'processed', 'outcome', 'authorized', 'payment_id', v_bp.id)
               || felyn_private.stripe_payment_action(v_bp.id);
      end if;
      if v_pi is not null and v_bp.payment_intent_id = v_pi then
        return jsonb_build_object('status', 'processed', 'outcome', 'already authorized', 'payment_id', v_bp.id)
               || felyn_private.stripe_payment_action(v_bp.id);
      end if;
      -- The attempt was closed (abandoned, expired) but the guest paid: never keep it.
      if v_pi is not null then
        return jsonb_build_object('status', 'processed', 'outcome', 'cancel_authorization:' || v_pi, 'payment_id', v_bp.id,
                                  'action', 'cancel_authorization', 'payment_intent_id', v_pi);
      end if;
      return jsonb_build_object('status', 'ignored', 'outcome', 'attempt already closed', 'payment_id', v_bp.id);
    end if;

    -- ── PaymentIntent: captured (after the server's capture call) or cancelled ──
    if p_type in ('payment_intent.succeeded', 'payment_intent.canceled') then
      v_pi := v_obj ->> 'id';
      select * into v_bp from public.booking_payments bp where bp.payment_intent_id = v_pi for update;
      if v_bp.id is null then
        return jsonb_build_object('status', 'ignored', 'outcome', 'unmatched payment intent');
      end if;
      if p_type = 'payment_intent.canceled' then
        if v_bp.status <> 'authorized' then
          return jsonb_build_object('status', 'ignored', 'outcome', 'not authorized', 'payment_id', v_bp.id);
        end if;
        update public.booking_payments bp
           set status = 'released', closed_at = now(), failure_reason = 'The authorization was cancelled at Stripe'
         where bp.id = v_bp.id;
        return jsonb_build_object('status', 'processed', 'outcome', 'released', 'payment_id', v_bp.id);
      end if;
      if v_bp.status in ('captured', 'confirmed', 'unconfirmable') then
        return jsonb_build_object('status', 'ignored', 'outcome', 'already captured', 'payment_id', v_bp.id);
      end if;
      if v_bp.status <> 'authorized' then
        -- Captured although the attempt was released or closed: only Felyn support can resolve it.
        return jsonb_build_object('status', 'processed', 'outcome', 'captured on a closed attempt: refund needed',
                                  'payment_id', v_bp.id);
      end if;
      v_charge := coalesce(case when jsonb_typeof(v_obj -> 'latest_charge') = 'string' then v_obj ->> 'latest_charge' end,
                           v_obj -> 'charges' -> 'data' -> 0 ->> 'id');
      if v_charge is null or v_charge !~ '^(ch|py)_[A-Za-z0-9]{1,250}$' then
        raise exception 'payment_intent.succeeded carries no charge id' using errcode = '22023';
      end if;
      update public.booking_payments bp
         set status = 'captured', charge_id = v_charge, captured_at = now()
       where bp.id = v_bp.id;
      v_amount := case when jsonb_typeof(v_obj -> 'amount_received') = 'number' then (v_obj ->> 'amount_received')::numeric end;
      if v_amount is distinct from v_bp.gross_cents or lower(coalesce(v_obj ->> 'currency', '')) <> 'eur' then
        update public.booking_payments bp
           set status = 'unconfirmable', closed_at = now(), host_transfer_status = 'blocked',
               failure_reason = 'The captured amount differs from the booking amount: refund needed'
         where bp.id = v_bp.id;
        return jsonb_build_object('status', 'processed', 'outcome', 'unconfirmable: amount mismatch', 'payment_id', v_bp.id);
      end if;
      -- 0035's owner-only payment step: AWAITING_PAYMENT -> CONFIRMED under the host lock,
      -- refused at or after payment_due_at (FB002).
      begin
        v_paid := public.booking_item_mark_paid(v_bp.booking_request_item_id);
      exception when sqlstate 'FB002' then
        v_paid := false;
      end;
      if v_paid then
        update public.booking_payments bp
           set status = 'confirmed', confirmed_at = now(), host_transfer_status = 'pending'
         where bp.id = v_bp.id;
        return jsonb_build_object('status', 'processed', 'outcome', 'confirmed', 'payment_id', v_bp.id);
      end if;
      update public.booking_payments bp
         set status = 'unconfirmable', closed_at = now(), host_transfer_status = 'blocked',
             failure_reason = 'Captured after the booking could no longer be confirmed: refund needed'
       where bp.id = v_bp.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'unconfirmable: refund needed', 'payment_id', v_bp.id);
    end if;

    -- ── refunds and disputes: recorded; the host transfer is blocked for support ──
    if p_type = 'charge.refunded' then
      v_charge := v_obj ->> 'id';
      v_pi := v_obj ->> 'payment_intent';
      select * into v_bp from public.booking_payments bp
       where bp.charge_id = v_charge or (v_pi is not null and bp.payment_intent_id = v_pi)
       limit 1 for update;
      if v_bp.id is null or v_bp.status not in ('captured', 'confirmed', 'unconfirmable')
         or jsonb_typeof(v_obj -> 'amount_refunded') is distinct from 'number' then
        return jsonb_build_object('status', 'ignored', 'outcome', 'no captured payment for this charge');
      end if;
      v_amount := least((v_obj ->> 'amount_refunded')::numeric, v_bp.gross_cents);
      if v_amount <= v_bp.refunded_cents then
        return jsonb_build_object('status', 'ignored', 'outcome', 'refund already recorded', 'payment_id', v_bp.id);
      end if;
      update public.booking_payments bp
         set refunded_cents = v_amount::integer,
             host_transfer_status = case when bp.host_transfer_status in ('pending', 'released', 'transferred') then 'blocked'
                                         else bp.host_transfer_status end
       where bp.id = v_bp.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'refund recorded', 'payment_id', v_bp.id);
    end if;

    if p_type in ('charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed') then
      v_dispute := v_obj ->> 'id';
      v_charge := v_obj ->> 'charge';
      if v_dispute !~ '^(dp|du)_[A-Za-z0-9]{1,250}$' then
        return jsonb_build_object('status', 'ignored', 'outcome', 'malformed dispute');
      end if;
      select * into v_bp from public.booking_payments bp where bp.charge_id = v_charge for update;
      if v_bp.id is null or v_bp.status not in ('captured', 'confirmed', 'unconfirmable') then
        return jsonb_build_object('status', 'ignored', 'outcome', 'no captured payment for this charge');
      end if;
      if v_bp.dispute_id is not null and v_bp.dispute_id <> v_dispute then
        return jsonb_build_object('status', 'processed', 'outcome', 'another dispute on this payment: support', 'payment_id', v_bp.id);
      end if;
      update public.booking_payments bp
         set dispute_id = v_dispute,
             disputed_at = coalesce(bp.disputed_at, now()),
             dispute_status = left(coalesce(nullif(v_obj ->> 'status', ''), 'unknown'), 50),
             host_transfer_status = case when bp.host_transfer_status in ('pending', 'released', 'transferred') then 'blocked'
                                         else bp.host_transfer_status end
       where bp.id = v_bp.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'dispute recorded', 'payment_id', v_bp.id);
    end if;

    -- ── Connect: a host's payout account (readiness is derived by 0036) ──
    if p_type = 'account.updated' then
      if p_event ? 'account' and p_event ->> 'account' is distinct from v_obj ->> 'id' then
        return jsonb_build_object('status', 'ignored', 'outcome', 'account mismatch');
      end if;
      select * into v_acct from public.host_payout_accounts h where h.stripe_account_id = v_obj ->> 'id' for update;
      if v_acct.provider_id is null then
        return jsonb_build_object('status', 'ignored', 'outcome', 'unknown account');
      end if;
      v_synced := to_timestamp((p_event ->> 'created')::double precision);
      if v_acct.stripe_synced_at is not null and v_acct.stripe_synced_at > v_synced then
        return jsonb_build_object('status', 'ignored', 'outcome', 'older than the last sync');
      end if;
      update public.host_payout_accounts h
         set details_submitted = coalesce(v_obj -> 'details_submitted' = 'true'::jsonb, false),
             charges_enabled = coalesce(v_obj -> 'charges_enabled' = 'true'::jsonb, false),
             payouts_enabled = coalesce(v_obj -> 'payouts_enabled' = 'true'::jsonb, false),
             transfers_capability = case when v_obj -> 'capabilities' ->> 'transfers' in ('active', 'inactive', 'pending')
                                         then v_obj -> 'capabilities' ->> 'transfers' else 'inactive' end,
             requirements_currently_due = coalesce((select array_agg(x.v) from (
               select jsonb_array_elements_text(case when jsonb_typeof(v_obj -> 'requirements' -> 'currently_due') = 'array'
                                                     then v_obj -> 'requirements' -> 'currently_due' else '[]'::jsonb end) as v
               limit 200) x), '{}'),
             requirements_past_due = coalesce((select array_agg(x.v) from (
               select jsonb_array_elements_text(case when jsonb_typeof(v_obj -> 'requirements' -> 'past_due') = 'array'
                                                     then v_obj -> 'requirements' -> 'past_due' else '[]'::jsonb end) as v
               limit 200) x), '{}'),
             disabled_reason = nullif(left(v_obj -> 'requirements' ->> 'disabled_reason', 200), ''),
             country = case when v_obj ->> 'country' ~ '^[A-Z]{2}$' then v_obj ->> 'country' end,
             default_currency = case when v_obj ->> 'default_currency' ~ '^[a-z]{3}$' then v_obj ->> 'default_currency' end,
             stripe_synced_at = v_synced
       where h.provider_id = v_acct.provider_id;
      return jsonb_build_object('status', 'processed', 'outcome', 'account synced');
    end if;

    return jsonb_build_object('status', 'ignored', 'outcome', 'event type not used');
  end $fn$;

  -- ── the webhook entry point (service_role only) ──
  create function public.stripe_apply_event(p_endpoint text, p_body_base64 text, p_signature text)
  returns jsonb language plpgsql security definer set search_path = '' as $fn$
  declare
    v_body bytea;
    v_check text;
    v_event jsonb;
    v_type text;
    v_id text;
    v_livemode boolean;
    v_expected_endpoint text;
    v_hash text;
    v_existing public.stripe_events;
    v_result jsonb;
    v_reply jsonb;
  begin
    if p_endpoint is null or p_endpoint not in ('platform', 'connect') then
      return jsonb_build_object('result', 'wrong_endpoint');
    end if;
    if p_body_base64 is null or char_length(p_body_base64) > 700000 then
      return jsonb_build_object('result', 'malformed');
    end if;
    begin
      v_body := decode(p_body_base64, 'base64');
    exception when others then
      return jsonb_build_object('result', 'malformed');
    end;
    if octet_length(v_body) not between 2 and 524288 then
      return jsonb_build_object('result', 'malformed');
    end if;

    -- Nothing is read or written for an unverified request.
    v_check := felyn_private.stripe_signature_check(p_endpoint, v_body, p_signature);
    if v_check <> 'ok' then
      return jsonb_build_object('result', v_check);
    end if;

    begin
      v_event := convert_from(v_body, 'UTF8')::jsonb;
    exception when others then
      return jsonb_build_object('result', 'malformed');
    end;
    if jsonb_typeof(v_event) is distinct from 'object'
       or jsonb_typeof(v_event -> 'data' -> 'object') is distinct from 'object'
       or jsonb_typeof(v_event -> 'livemode') is distinct from 'boolean'
       or jsonb_typeof(v_event -> 'created') is distinct from 'number' then
      return jsonb_build_object('result', 'malformed');
    end if;
    v_id := v_event ->> 'id';
    v_type := v_event ->> 'type';
    if v_id is null or v_id !~ '^evt_[A-Za-z0-9]{1,250}$'
       or v_type is null or char_length(v_type) > 100 or v_type !~ '^[a-z_]+(\.[a-z_]+)+$' then
      return jsonb_build_object('result', 'malformed');
    end if;

    -- Test mode only (felyn_private.stripe_settings).
    v_livemode := (v_event ->> 'livemode')::boolean;
    if v_livemode is distinct from (select s.livemode from felyn_private.stripe_settings s where s.id) then
      return jsonb_build_object('result', 'wrong_mode');
    end if;
    v_expected_endpoint := case
      when v_type = 'account.updated' then 'connect'
      when v_type in ('checkout.session.completed', 'checkout.session.expired', 'payment_intent.succeeded',
                      'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created',
                      'charge.dispute.updated', 'charge.dispute.closed') then 'platform'
    end;
    if v_expected_endpoint is not null and v_expected_endpoint <> p_endpoint then
      return jsonb_build_object('result', 'wrong_endpoint');
    end if;

    -- Deduplication (0036's stripe_events). pending_webhooks changes between deliveries,
    -- so it is left out of the identity hash.
    v_hash := encode(pg_catalog.sha256(convert_to((v_event - 'pending_webhooks')::text, 'UTF8')), 'hex');
    insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256, connected_account_id)
    values (v_id, v_type, v_livemode, to_timestamp((v_event ->> 'created')::double precision), v_hash,
            case when v_event ->> 'account' ~ '^acct_[A-Za-z0-9]{1,250}$' then v_event ->> 'account' end)
    on conflict (event_id) do nothing;
    if not found then
      -- Seen before (possibly a delivery that is committing right now: this waits for it).
      select * into v_existing from public.stripe_events e where e.event_id = v_id for update;
      if v_existing.payload_sha256 <> v_hash then
        return jsonb_build_object('result', 'payload_mismatch');
      end if;
      update public.stripe_events e
         set delivery_count = e.delivery_count + 1, last_received_at = now()
       where e.event_id = v_id;
      if v_existing.processing_status in ('processed', 'ignored') then
        v_reply := jsonb_build_object('result', 'duplicate');
        -- A redelivered Checkout completion repeats its action (the route's Stripe call may
        -- have failed): decided again from the attempt's current state.
        if v_existing.event_type = 'checkout.session.completed' then
          if v_existing.outcome like 'cancel\_authorization:%' then
            v_reply := v_reply || jsonb_build_object('action', 'cancel_authorization',
                                                     'payment_intent_id', substr(v_existing.outcome, 22));
          elsif v_existing.booking_payment_id is not null then
            v_reply := v_reply || felyn_private.stripe_payment_action(v_existing.booking_payment_id);
          end if;
        end if;
        return v_reply;
      end if;
    end if;

    v_result := felyn_private.stripe_process_event(v_type, v_event);
    update public.stripe_events e
       set processing_status = v_result ->> 'status',
           processed_at = now(),
           outcome = left(v_result ->> 'outcome', 200),
           last_error = null,
           booking_payment_id = coalesce(e.booking_payment_id, (v_result ->> 'payment_id')::uuid)
     where e.event_id = v_id;
    return jsonb_strip_nulls(jsonb_build_object('result', v_result ->> 'status', 'action', v_result -> 'action',
                                                'payment_intent_id', v_result -> 'payment_intent_id'));
  end $fn$;

  -- ── the guest starts (or resumes) paying for their own accepted booking ──
  create function public.booking_payment_start(p_item_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
    v_item record;
    v_live record;
    v_livemode boolean;
    v_account text;
    v_price integer;
    v_gross integer;
    v_fee integer;
    v_id uuid;
  begin
    if v_uid is null then
      raise exception 'Not signed in' using errcode = '42501';
    end if;
    select bri.id, bri.status, bri.payment_due_at, bri.price_per_person, bri.guest_count, e.title, e.provider_id
      into v_item
      from public.booking_request_items bri
      join public.booking_requests br on br.id = bri.booking_request_id
      join public.experiences e on e.id = bri.experience_id
     where bri.id = p_item_id and br.user_id = v_uid;
    if not found then
      return jsonb_build_object('result', 'not_found');
    end if;
    if v_item.status <> 'AWAITING_PAYMENT' then
      return jsonb_build_object('result', 'not_payable', 'status', v_item.status);
    end if;
    -- Attempts stuck before Stripe answered, or whose session ended without an event yet.
    update public.booking_payments bp
       set status = 'failed', closed_at = now(), failure_reason = 'Abandoned before its Checkout session was recorded'
     where bp.booking_request_item_id = v_item.id and bp.status = 'creating'
       and bp.created_at < now() - interval '15 minutes';
    update public.booking_payments bp
       set status = 'expired', closed_at = now()
     where bp.booking_request_item_id = v_item.id and bp.status = 'open'
       and bp.checkout_expires_at < now() - interval '5 minutes';
    select bp.id, bp.status, bp.checkout_session_id, bp.checkout_expires_at into v_live
      from public.booking_payments bp
     where bp.booking_request_item_id = v_item.id
       and bp.status in ('creating', 'open', 'authorized', 'captured', 'confirmed', 'unconfirmable');
    if found then
      if v_live.status = 'open' and v_live.checkout_expires_at > now() + interval '1 minute' then
        return jsonb_build_object('result', 'existing', 'payment_id', v_live.id, 'checkout_session_id', v_live.checkout_session_id);
      elsif v_live.status in ('creating', 'open') then
        return jsonb_build_object('result', 'in_progress');
      elsif v_live.status = 'unconfirmable' then
        return jsonb_build_object('result', 'needs_support');
      end if;
      return jsonb_build_object('result', 'processing');
    end if;

    select s.livemode into v_livemode from felyn_private.stripe_settings s where s.id;
    select h.stripe_account_id into v_account from public.host_payout_accounts h where h.provider_id = v_item.provider_id;
    if v_account is null then
      raise exception 'This host can''t receive payouts' using errcode = 'FB006';
    end if;
    -- The booking's own snapshot, in cents; 0036's insert guard checks it all again.
    v_price := (v_item.price_per_person * 100)::integer;
    v_gross := v_price * v_item.guest_count;
    v_fee := (v_gross + 5) / 10;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values (v_item.id, 1, v_livemode, v_price, v_item.guest_count, v_gross, v_fee, v_gross - v_fee, v_account)
      returning id into v_id;
    exception when unique_violation then
      -- Another attempt was started at the same moment.
      return jsonb_build_object('result', 'in_progress');
    end;
    return jsonb_build_object(
      'result', 'created',
      'payment_id', v_id,
      'livemode', v_livemode,
      'currency', 'EUR',
      'price_per_person_cents', v_price,
      'guest_count', v_item.guest_count,
      'gross_cents', v_gross,
      'platform_fee_cents', v_fee,
      'payment_due_at', v_item.payment_due_at,
      'experience_title', v_item.title,
      'transfer_group', 'felyn_payment_' || v_id::text);
  end $fn$;

  create function public.booking_payment_guest_status(p_item_id uuid)
  returns text language sql stable security definer set search_path = '' as $fn$
    select bp.status
      from public.booking_payments bp
      join public.booking_request_items bri on bri.id = bp.booking_request_item_id
      join public.booking_requests br on br.id = bri.booking_request_id
     where bp.booking_request_item_id = p_item_id and br.user_id = auth.uid()
     order by bp.attempt_no desc
     limit 1
  $fn$;

  -- ── what the server records from Stripe's API (service_role only) ──
  create function public.stripe_record_checkout_session(p_payment_id uuid, p_session_id text, p_expires_at timestamptz)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_due timestamptz;
  begin
    select bri.payment_due_at into v_due
      from public.booking_payments bp
      join public.booking_request_items bri on bri.id = bp.booking_request_item_id
     where bp.id = p_payment_id and bp.status = 'creating'
       for update of bp;
    if not found then
      return false;
    end if;
    if p_expires_at is null or p_expires_at > v_due - interval '10 minutes' then
      raise exception 'A Checkout session must expire at least 10 minutes before the payment deadline' using errcode = '22023';
    end if;
    -- The session id's shape and its test/live prefix are checked by 0036's constraints.
    update public.booking_payments bp
       set status = 'open', checkout_session_id = p_session_id, checkout_expires_at = p_expires_at, session_opened_at = now()
     where bp.id = p_payment_id and bp.status = 'creating';
    return found;
  end $fn$;

  create function public.stripe_record_checkout_failure(p_payment_id uuid, p_reason text)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  begin
    update public.booking_payments bp
       set status = 'failed', closed_at = now(),
           failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'The Checkout session could not be created'), 500)
     where bp.id = p_payment_id and bp.status = 'creating';
    return found;
  end $fn$;

  -- A host's new connected account (created by the server). Never marks it ready:
  -- readiness only comes from verified account.updated events. Returns the host's
  -- account id (an existing one wins).
  create function public.stripe_register_host_account(p_provider_id uuid, p_account_id text)
  returns text language plpgsql security definer set search_path = '' as $fn$
  declare
    v_account text;
  begin
    if p_account_id is null or p_account_id !~ '^acct_[A-Za-z0-9]{1,250}$' then
      raise exception 'Not a Stripe account id' using errcode = '22023';
    end if;
    if not exists (select 1 from public.providers p
                    where p.id = p_provider_id and p.user_id is not null and p.verification_status = 'verified') then
      raise exception 'Unknown host' using errcode = '22023';
    end if;
    insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode)
    values (p_provider_id, p_account_id, (select s.livemode from felyn_private.stripe_settings s where s.id))
    on conflict (provider_id) do nothing;
    select h.stripe_account_id into v_account from public.host_payout_accounts h where h.provider_id = p_provider_id;
    return v_account;
  end $fn$;

  -- The calling host's own payout account (no row: not a verified host).
  create function public.host_payout_account_status()
  returns table (provider_id uuid, stripe_account_id text, livemode boolean, details_submitted boolean,
                 payouts_enabled boolean, transfers_capability text, payouts_ready boolean,
                 requirements_due integer, disabled_reason text, stripe_synced_at timestamptz)
  language sql stable security definer set search_path = '' as $fn$
    select p.id, h.stripe_account_id, h.livemode, h.details_submitted, h.payouts_enabled, h.transfers_capability,
           h.payouts_ready,
           case when h.provider_id is null then null
                else cardinality(h.requirements_currently_due) + cardinality(h.requirements_past_due) end,
           h.disabled_reason, h.stripe_synced_at
      from public.providers p
      left join public.host_payout_accounts h on h.provider_id = p.id
     where p.user_id = auth.uid() and p.verification_status = 'verified'
  $fn$;

  -- ── privileges ──
  revoke execute on function felyn_private.stripe_signature_check(text, bytea, text) from public, anon, authenticated, service_role;
  revoke execute on function felyn_private.stripe_payment_action(uuid) from public, anon, authenticated, service_role;
  revoke execute on function felyn_private.stripe_process_event(text, jsonb) from public, anon, authenticated, service_role;
  revoke execute on function public.stripe_apply_event(text, text, text) from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payment_start(uuid) from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payment_guest_status(uuid) from public, anon, authenticated, service_role;
  revoke execute on function public.host_payout_account_status() from public, anon, authenticated, service_role;
  revoke execute on function public.stripe_record_checkout_session(uuid, text, timestamptz) from public, anon, authenticated, service_role;
  revoke execute on function public.stripe_record_checkout_failure(uuid, text) from public, anon, authenticated, service_role;
  revoke execute on function public.stripe_register_host_account(uuid, text) from public, anon, authenticated, service_role;
  grant execute on function public.booking_payment_start(uuid) to authenticated;
  grant execute on function public.booking_payment_guest_status(uuid) to authenticated;
  grant execute on function public.host_payout_account_status() to authenticated;
  grant execute on function public.stripe_apply_event(text, text, text) to service_role;
  grant execute on function public.stripe_record_checkout_session(uuid, text, timestamptz) to service_role;
  grant execute on function public.stripe_record_checkout_failure(uuid, text) to service_role;
  grant execute on function public.stripe_register_host_account(uuid, text) to service_role;

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select s.livemode from felyn_private.stripe_settings s where s.id) is distinct from false
     or (select count(*) from felyn_private.stripe_settings) <> 1 then
    raise exception '0037 VERIFY FAILED: the database is not pinned to Stripe test mode';
  end if;
  for r in select unnest(array['anon', 'authenticated', 'service_role']) as rl loop
    if has_schema_privilege(r.rl, 'felyn_private', 'USAGE') or has_schema_privilege(r.rl, 'felyn_private', 'CREATE')
       or has_table_privilege(r.rl, 'felyn_private.stripe_settings', 'SELECT')
       or has_table_privilege(r.rl, 'felyn_private.stripe_settings', 'UPDATE')
       or has_table_privilege(r.rl, 'felyn_private.stripe_webhook_secrets', 'SELECT')
       or has_table_privilege(r.rl, 'felyn_private.stripe_webhook_secrets', 'INSERT')
       or has_table_privilege(r.rl, 'felyn_private.stripe_webhook_secrets', 'UPDATE')
       or has_function_privilege(r.rl, 'felyn_private.stripe_signature_check(text, bytea, text)', 'EXECUTE')
       or has_function_privilege(r.rl, 'felyn_private.stripe_payment_action(uuid)', 'EXECUTE')
       or has_function_privilege(r.rl, 'felyn_private.stripe_process_event(text, jsonb)', 'EXECUTE') then
      raise exception '0037 VERIFY FAILED: % can reach felyn_private', r.rl;
    end if;
  end loop;
  for r in select fn, rl, allowed from (values
             ('public.stripe_apply_event(text, text, text)', 'service_role'),
             ('public.stripe_record_checkout_session(uuid, text, timestamptz)', 'service_role'),
             ('public.stripe_record_checkout_failure(uuid, text)', 'service_role'),
             ('public.stripe_register_host_account(uuid, text)', 'service_role'),
             ('public.booking_payment_start(uuid)', 'authenticated'),
             ('public.booking_payment_guest_status(uuid)', 'authenticated'),
             ('public.host_payout_account_status()', 'authenticated')) f(fn, allowed),
           unnest(array['anon', 'authenticated', 'service_role']) rl loop
    if has_function_privilege(r.rl, r.fn, 'EXECUTE') <> (r.rl = r.allowed) then
      raise exception '0037 VERIFY FAILED: EXECUTE on % for % is not as intended', r.fn, r.rl;
    end if;
    if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
              from pg_proc p where p.oid = r.fn::regprocedure) then
      raise exception '0037 VERIFY FAILED: % is not SECURITY DEFINER with an empty search_path', r.fn;
    end if;
  end loop;
  -- 0036's tables keep no client or service_role access; 0035's payment step stays owner-only.
  for r in select t, rl from unnest(array['public.host_payout_accounts', 'public.booking_payments', 'public.stripe_events',
                                          'public.booking_payment_transfer_releases']) t,
                             unnest(array['anon', 'authenticated', 'service_role']) rl loop
    if has_table_privilege(r.rl, r.t, 'SELECT') or has_table_privilege(r.rl, r.t, 'INSERT')
       or has_table_privilege(r.rl, r.t, 'UPDATE') or has_table_privilege(r.rl, r.t, 'DELETE') then
      raise exception '0037 VERIFY FAILED: % has a privilege on %', r.rl, r.t;
    end if;
  end loop;
  if has_function_privilege('service_role', 'public.booking_item_mark_paid(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.booking_item_mark_paid(uuid)', 'EXECUTE') then
    raise exception '0037 VERIFY FAILED: booking_item_mark_paid is callable by a client role';
  end if;
  if exists (select 1 from felyn_private.stripe_webhook_secrets) then
    raise exception '0037 VERIFY FAILED: webhook secrets must be added by hand after the migration';
  end if;
end
$migration$;
