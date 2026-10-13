-- NOT A MIGRATION. Fail-closed isolated test for 0037_stripe_test_mode.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0037's schema, tables, functions and grants, the
-- temporary webhook secret, and every test row, notification and payment row),
-- releases every lock, and leaves the session idle. There is no code path that
-- finishes normally.
--
-- Run it AFTER 0036 and BEFORE 0037 (it applies 0037's body itself, then throws it
-- away; once 0037 is applied it fails during setup, changing nothing, and should not
-- be re-run). Run as `postgres`.
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It signs its own test webhook events with a throwaway secret (never a real one)
-- using pgcrypto, exactly as Stripe does, and calls the real functions as the real
-- roles. It needs three accounts in auth.users (A = host, B = another account,
-- G = guest). Test dates are in 2027.
--
-- What it checks:
--   I1  test mode pinned; felyn_private unreachable for anon/authenticated/service_role
--   H1  no payout account -> a guest can't start a payment (FB006)
--   H2  service_role registers a host account; it is not ready
--   H3  a signed account.updated (Connect) makes it ready; W1 the platform endpoint refuses it
--   A1  the guest starts a payment: amounts from the snapshot, 10% half up (8010 -> 801)
--   A2  another account can't start it
--   A3  a session expiring later than 10 minutes before the deadline is refused; then open
--   S1  wrong secret, stale timestamp and live events are refused and change nothing
--   C1  checkout.session.completed -> authorized, action capture, booking still unpaid
--   C2  redelivery -> duplicate, counted, the capture action repeated
--   C3  payment_intent.succeeded -> booking CONFIRMED through 0035's payment step,
--       payment confirmed, host transfer pending, no email from the payment
--   R1  charge.refunded -> refunded amount recorded, host transfer blocked
--   P1  clients can't apply events; service_role can't start payments or read payments

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid; v_exp uuid; v_req uuid; v_item uuid; v_pay uuid;
  v_due timestamptz;
  v_secret constant text := 'whsec_isolatedTEST000000000000';
  v_r jsonb;
  v_session text := 'cs_test_isolated0037';
  v_pi text := 'pi_isolated0037';
  v_body text;
  v_emails int;
  v_text text;
  n int;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS AND AN EXPERIENCE ═════════
    v_stage := 'accounts';
    select u.id into v_a from auth.users u order by u.created_at limit 1;
    select u.id into v_b from auth.users u where u.id <> v_a order by u.created_at limit 1;
    select u.id into v_g from auth.users u where u.id not in (v_a, v_b) order by u.created_at limit 1;
    if v_a is null or v_b is null or v_g is null then
      raise exception 'SETUP: need three accounts in auth.users';
    end if;
    select p.id into v_a_provider from public.providers p where p.user_id = v_a;
    if v_a_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_a, 'STRIPE TEST-MODE HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    if exists (select 1 from public.host_payout_accounts h where h.provider_id = v_a_provider) then
      raise exception 'SETUP: host A already has a payout account';
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'STRIPE TEST-MODE EXPERIENCE (rolled back)', 'food', 40.05, 1, 6, 120, true) returning id into v_exp;
    insert into public.experience_availability (experience_id, available_from, available_until) values (v_exp, '2026-01-01', '2030-12-31');

    -- ═════════ 1. 0037 BODY (verbatim from 0037_stripe_test_mode.sql, section 2) ═════════
    v_stage := 'migration';
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

    -- A throwaway signing helper (temporary, rolled back): signs a body as Stripe would
    -- with the test secret and calls the real entry point as service_role.
    create function pg_temp.iso_apply(p_endpoint text, p_body text, p_secret text, p_offset integer)
    returns jsonb language plpgsql as $f$
    declare
      v_t text := (extract(epoch from now())::bigint + p_offset)::text;
      v_header text;
      v_out jsonb;
    begin
      v_header := 't=' || v_t || ',v1=' || encode(extensions.hmac(convert_to(v_t || '.' || p_body, 'UTF8'), convert_to(p_secret, 'UTF8'), 'sha256'), 'hex');
      set local role service_role;
      v_out := public.stripe_apply_event(p_endpoint, encode(convert_to(p_body, 'UTF8'), 'base64'), v_header);
      reset role;
      return v_out;
    end $f$;

    -- ═════════ 2. SETUP: SECRET, REQUEST, ACCEPTANCE ═════════
    v_stage := 'setup';
    insert into felyn_private.stripe_webhook_secrets (endpoint, slot, secret) values ('platform', 'current', v_secret), ('connect', 'current', v_secret || 'c');
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-11-17', 'evening', 2, '19:00') returning id into v_item;
    reset role;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_item) then raise exception 'SETUP: host A could not accept'; end if;
    reset role;
    select bri.payment_due_at into v_due from public.booking_request_items bri where bri.id = v_item and bri.status = 'AWAITING_PAYMENT';
    if v_due is null then raise exception 'SETUP: the booking is not AWAITING_PAYMENT'; end if;

    -- ═════════ 3. CHECKS ═════════
    v_stage := 'I1 test mode and felyn_private';
    if (select s.livemode from felyn_private.stripe_settings s) is distinct from false then
      raise exception 'I1 FAILED: not pinned to test mode';
    end if;
    if has_schema_privilege('anon', 'felyn_private', 'USAGE') or has_schema_privilege('authenticated', 'felyn_private', 'USAGE')
       or has_schema_privilege('service_role', 'felyn_private', 'USAGE') then
      raise exception 'I1 FAILED: an API role can use felyn_private';
    end if;

    v_stage := 'H1 no payout account';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_payment_start(v_item);
      raise exception 'H1 FAILED: a payment started for a host without a payout account';
    exception when sqlstate 'FB006' then null;
    end;
    reset role;

    v_stage := 'H2 register';
    set local role service_role;
    if public.stripe_register_host_account(v_a_provider, 'acct_isolated0037') is distinct from 'acct_isolated0037' then
      raise exception 'H2 FAILED: registration did not return the account';
    end if;
    reset role;
    if (select h.payouts_ready from public.host_payout_accounts h where h.provider_id = v_a_provider) then
      raise exception 'H2 FAILED: a registered account is ready without Stripe';
    end if;

    v_stage := 'H3 account.updated';
    v_body := jsonb_build_object('id', 'evt_isoacct1', 'object', 'event', 'type', 'account.updated', 'livemode', false,
      'created', extract(epoch from now())::bigint, 'account', 'acct_isolated0037', 'pending_webhooks', 1,
      'data', jsonb_build_object('object', jsonb_build_object('id', 'acct_isolated0037', 'object', 'account',
        'details_submitted', true, 'charges_enabled', true, 'payouts_enabled', true, 'country', 'ES', 'default_currency', 'eur',
        'capabilities', jsonb_build_object('transfers', 'active'),
        'requirements', jsonb_build_object('currently_due', '[]'::jsonb, 'past_due', '[]'::jsonb, 'disabled_reason', null))))::text;
    v_r := pg_temp.iso_apply('platform', v_body, v_secret, 0);
    if v_r ->> 'result' is distinct from 'wrong_endpoint' then raise exception 'W1 FAILED: %', v_r; end if;
    v_r := pg_temp.iso_apply('connect', v_body, v_secret || 'c', 0);
    if v_r ->> 'result' is distinct from 'processed' then raise exception 'H3 FAILED: %', v_r; end if;
    if not (select h.payouts_ready from public.host_payout_accounts h where h.provider_id = v_a_provider) then
      raise exception 'H3 FAILED: the account is not ready after a verified sync';
    end if;

    v_stage := 'A1-A2 start';
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.booking_payment_start(v_item) ->> 'result' is distinct from 'not_found' then
      raise exception 'A2 FAILED: another account started the payment';
    end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_r := public.booking_payment_start(v_item);
    reset role;
    if v_r ->> 'result' is distinct from 'created' or (v_r ->> 'gross_cents')::int <> 8010
       or (v_r ->> 'platform_fee_cents')::int <> 801 or (v_r ->> 'livemode')::boolean then
      raise exception 'A1 FAILED: %', v_r;
    end if;
    v_pay := (v_r ->> 'payment_id')::uuid;

    v_stage := 'A3 record the session';
    set local role service_role;
    begin
      perform public.stripe_record_checkout_session(v_pay, v_session, v_due - interval '9 minutes');
      raise exception 'A3 FAILED: a session expiring 9 minutes before the deadline was accepted';
    exception when sqlstate '22023' then null;
    end;
    if not public.stripe_record_checkout_session(v_pay, v_session, v_due - interval '30 minutes') then
      raise exception 'A3 FAILED: the session was not recorded';
    end if;
    reset role;

    v_stage := 'S1 refused events';
    v_body := jsonb_build_object('id', 'evt_isocomplete1', 'object', 'event', 'type', 'checkout.session.completed', 'livemode', false,
      'created', extract(epoch from now())::bigint, 'pending_webhooks', 1,
      'data', jsonb_build_object('object', jsonb_build_object('id', v_session, 'object', 'checkout.session', 'mode', 'payment',
        'status', 'complete', 'payment_status', 'unpaid', 'amount_total', 8010, 'currency', 'eur', 'payment_intent', v_pi,
        'expires_at', extract(epoch from v_due - interval '30 minutes')::bigint,
        'metadata', jsonb_build_object('felyn_payment_id', v_pay))))::text;
    if pg_temp.iso_apply('platform', v_body, 'whsec_wrongWRONGwrong000000', 0) ->> 'result' is distinct from 'invalid_signature'
       or pg_temp.iso_apply('platform', v_body, v_secret, -301) ->> 'result' is distinct from 'stale_timestamp'
       or pg_temp.iso_apply('platform', replace(v_body, '"livemode": false', '"livemode": true'), v_secret, 0) ->> 'result' is distinct from 'wrong_mode' then
      raise exception 'S1 FAILED: a forged, stale or live event was not refused';
    end if;
    if exists (select 1 from public.stripe_events e where e.event_id = 'evt_isocomplete1')
       or (select bp.status from public.booking_payments bp where bp.id = v_pay) <> 'open' then
      raise exception 'S1 FAILED: a refused event changed something';
    end if;

    v_stage := 'C1 completed';
    v_r := pg_temp.iso_apply('platform', v_body, v_secret, 0);
    if v_r is distinct from jsonb_build_object('result', 'processed', 'action', 'capture', 'payment_intent_id', v_pi) then
      raise exception 'C1 FAILED: %', v_r;
    end if;
    if (select bp.status from public.booking_payments bp where bp.id = v_pay) <> 'authorized'
       or (select bri.status from public.booking_request_items bri where bri.id = v_item) <> 'AWAITING_PAYMENT' then
      raise exception 'C1 FAILED: not authorized, or the booking was confirmed by an authorization';
    end if;

    v_stage := 'C2 redelivery';
    v_r := pg_temp.iso_apply('platform', replace(v_body, '"pending_webhooks": 1', '"pending_webhooks": 0'), v_secret, 0);
    if v_r is distinct from jsonb_build_object('result', 'duplicate', 'action', 'capture', 'payment_intent_id', v_pi) then
      raise exception 'C2 FAILED: %', v_r;
    end if;
    if (select e.delivery_count from public.stripe_events e where e.event_id = 'evt_isocomplete1') <> 2 then
      raise exception 'C2 FAILED: the redelivery was not counted';
    end if;

    v_stage := 'C3 captured';
    select count(*) into v_emails from public.email_outbox;
    v_body := jsonb_build_object('id', 'evt_isosucceeded1', 'object', 'event', 'type', 'payment_intent.succeeded', 'livemode', false,
      'created', extract(epoch from now())::bigint, 'pending_webhooks', 1,
      'data', jsonb_build_object('object', jsonb_build_object('id', v_pi, 'object', 'payment_intent', 'status', 'succeeded',
        'amount_received', 8010, 'currency', 'eur', 'latest_charge', 'ch_isolated0037')))::text;
    v_r := pg_temp.iso_apply('platform', v_body, v_secret, 0);
    if v_r ->> 'result' is distinct from 'processed' then raise exception 'C3 FAILED: %', v_r; end if;
    if (select bri.status from public.booking_request_items bri where bri.id = v_item) <> 'CONFIRMED'
       or (select bp.status || '/' || bp.host_transfer_status from public.booking_payments bp where bp.id = v_pay) <> 'confirmed/pending' then
      raise exception 'C3 FAILED: the booking or payment was not confirmed';
    end if;
    if (select count(*) from public.email_outbox) <> v_emails then
      raise exception 'C3 FAILED: a payment created an email';
    end if;

    v_stage := 'R1 refund';
    v_body := jsonb_build_object('id', 'evt_isorefund1', 'object', 'event', 'type', 'charge.refunded', 'livemode', false,
      'created', extract(epoch from now())::bigint, 'pending_webhooks', 1,
      'data', jsonb_build_object('object', jsonb_build_object('id', 'ch_isolated0037', 'object', 'charge',
        'payment_intent', v_pi, 'amount_refunded', 8010)))::text;
    v_r := pg_temp.iso_apply('platform', v_body, v_secret, 0);
    if (select bp.refunded_cents || '/' || bp.host_transfer_status from public.booking_payments bp where bp.id = v_pay) <> '8010/blocked' then
      raise exception 'R1 FAILED: the refund was not recorded or the transfer not blocked (%)', v_r;
    end if;

    v_stage := 'P1 privileges';
    set local role authenticated;
    begin
      perform public.stripe_apply_event('platform', 'e30=', 't=1,v1=' || repeat('0', 64));
      raise exception 'P1 FAILED: a signed-in user called stripe_apply_event';
    exception when insufficient_privilege then null;
    end;
    reset role;
    set local role service_role;
    begin
      perform public.booking_payment_start(v_item);
      raise exception 'P1 FAILED: service_role started a payment';
    exception when insufficient_privilege then null;
    end;
    begin
      select count(*) into n from public.booking_payments;
      raise exception 'P1 FAILED: service_role read the payments table';
    exception when insufficient_privilege then null;
    end;
    begin
      select count(*) into n from felyn_private.stripe_webhook_secrets;
      raise exception 'P1 FAILED: service_role read the webhook secrets';
    exception when insufficient_privilege then null;
    end;
    reset role;

    v_text := 'ok';
    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
