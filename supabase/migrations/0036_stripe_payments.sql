-- 0036: Stripe payment foundation — payment attempts, host payout accounts, Stripe event
-- deduplication, the 60-minute acceptance rule and the €5 minimum price
--
-- ONE SQL statement (a single DO block), same form as 0023-0035: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state.
--
-- RELEASE NOTE: apply only together with 0035 and the Stripe phase (0035 first, then
-- this, in the same maintenance window). Nothing here talks to Stripe; this is the
-- database side only. No application code writes these tables yet.
--
-- Why: a later stage records Stripe payments. The booking itself keeps 0035's state
-- machine (REQUESTED -> AWAITING_PAYMENT -> CONFIRMED | PAYMENT_EXPIRED), and only
-- 0035's owner-only payment step can confirm a booking. This migration adds the
-- records around it, with the rules enforced by the database itself:
--
--   * public.host_payout_accounts — one Stripe connected account per host
--     (provider). Readiness (payouts_ready) is a GENERATED column computed from the
--     synchronized Stripe fields, so nothing can simply "mark a host ready"; the
--     account id and test/live mode never change; a sync may never move backwards
--     in time (out-of-order Stripe events).
--   * public.booking_payments — one row per payment attempt on a booking item
--     (separate charges and transfers: Felyn charges the guest; the host's share is
--     transferred only after the experience). Integer euro cents; EUR only;
--     price per person >= €5; gross = price x guests; fee = 10% rounded half up
--     (= (gross + 5) / 10 in integer arithmetic, as in src/lib/payments/money.ts);
--     host share = gross - fee. Amounts, booking, mode and destination never change
--     after insert; Stripe ids are set once; refunds and transfer reversals only
--     grow. A new attempt must match the booking's own price snapshot and guest count
--     (nothing is taken on trust), the booking must be AWAITING_PAYMENT with at least
--     41 minutes until payment_due_at (FB005), and the host's payout account must be
--     ready and in the same mode (FB006). At most ONE live attempt per booking item
--     (creating, open, authorized, captured, confirmed or unconfirmable), so never two
--     open attempts and never two successful payments; retries after an expired,
--     failed or released attempt get the next attempt number.
--       Attempt status (each transition checked by a trigger):
--         creating -> open | failed                      (Checkout session being created)
--         open -> expired | failed | authorized          (guest in Checkout)
--         authorized -> captured | released              (manual capture)
--         captured -> confirmed | unconfirmable          (booking confirmed, or it could not be:
--                                                         money captured, refund needed)
--       "confirmed" requires the booking to already be CONFIRMED (in the same
--       transaction, through 0035's owner-only payment step).
--       Host transfer status (a captured payment with a pending transfer is possible):
--         none -> pending (when the payment is confirmed) | blocked (unconfirmable)
--         pending -> released | blocked;   released -> transferred | blocked
--         transferred -> reversed | blocked;   blocked -> pending | reversed
--       A refund or dispute forces the transfer out of pending/released/transferred
--       (to blocked), so it needs Felyn support to reconcile it.
--   * the host-transfer release gate (docs/payments/host-transfer-release-gate.md),
--     enforced by booking_payments' update guard for every caller, owner included:
--       pending -> released needs the booking CONFIRMED and completed, at least seven
--       full days (168 hours) after the scheduled end in the acceptance snapshot
--       (confirmed_start_at + duration_minutes, 0033), no refund and no dispute, and
--         - automatic release: no OPEN support case — a thread linked to the booking,
--           or a booking/cancellation/payment/experience thread of its guest or host
--           active since acceptance (FB008);
--         - staff release: may clear an open case, only by a signed-in Felyn admin
--           (staff_members role 'admin') acting as themselves (released_by = auth.uid(),
--           and the session's role is 'authenticated', so the database owner's
--           scheduled jobs can't impersonate staff), with a note (42501 otherwise);
--           through public.support_staff_release_host_transfer(payment, note).
--       released -> transferred re-checks all of it just before the transfer: an
--       automatic release needs no OPEN case; a staff release needs no case that was
--       opened, reopened or got a new message after the release (FB008).
--       The release time is stamped by the database (clock_timestamp()), and each
--       release is recorded in public.booking_payment_transfer_releases (append-only).
--       Concurrency: every support-thread write takes a SHARED per-user advisory lock
--       (support_threads.case_activity_at records when, after the lock); release and
--       transfer take the guest's and host's locks EXCLUSIVELY (in a fixed order)
--       before checking, so a release never misses a case being opened at that moment.
--       blocked -> pending clears the release, so support can release it again later.
--       No release or transfer job exists yet (later stages).
--   * public.stripe_events — one row per Stripe event id (deduplication): type, mode,
--     Stripe's creation time, a SHA-256 of the payload (no payload, no personal or
--     card data), delivery count, processing status and outcome. The identity of an
--     event never changes; a "redelivery" with a different payload hash is refused.
--   * public.booking_payment_transfer_blocker(payment): why a host transfer may not be
--     created now (null = it may). Owner-only; nothing calls it yet.
--   * acceptance (booking_item_confirm, otherwise exactly 0035's): the guest must
--     have at least 60 minutes to pay (was 30; FB001), and a booking priced below
--     €5 per person can't be accepted (FB004).
--   * €5 minimum price: a new experience, or a price change, must be at least €5
--     per person; an experience under €5 can't be (re)published; a new booking
--     request for an experience under €5 is refused (FB004). Existing experience
--     prices and booking snapshots are NOT changed.
--   * stay/request deletion (booking_request_is_deletable): a request with any
--     payment record is never deletable (financial records are kept).
--
--   * service_role keeps SELECT on booking_requests and booking_request_items (the
--     email sender reads them) but loses INSERT/UPDATE/DELETE/TRUNCATE there: the app
--     never writes them with the secret key, and a leaked key must not be able to.
--
-- Not changed: 0035's update guard, booking_item_mark_paid, expiry and its schedule,
-- decline/withdraw/cancel/completion, messaging, notifications, the email outbox, RLS
-- on the booking tables. No client or service_role privileges are granted on any new
-- table or function (later stages add narrow functions for them).
--
-- Error codes: FB001 too late to accept (under 60 minutes to pay) · FB004 price below
-- the €5 minimum · FB005 too late to start a payment attempt (under 41 minutes) ·
-- FB006 the host can't receive payouts · FB007 a host transfer's release conditions
-- aren't met (not confirmed/completed, review period, refund/dispute) · FB008 an open
-- or changed support case blocks the host transfer. (FB002 is 0035's payment deadline; FB003 is
-- reserved for requiring payout onboarding before acceptance, a later stage.)
--
-- Run as role `postgres` (the owner of booking_request_items), the whole file, in one
-- run, after 0035.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.booking_request_items'::regclass)
     is distinct from (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '0036 ABORTED: run this as the owner of public.booking_request_items (postgres)';
  end if;
  if to_regprocedure('public.booking_item_mark_paid(uuid)') is null
     or to_regprocedure('public.expire_due_booking_payments()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'booking_request_items' and column_name = 'payment_due_at') then
    raise exception '0036 ABORTED: 0035 (payment reservation states) is not applied';
  end if;
  if position('interval ''30 minutes''' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('FB001' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('PAYMENT_EXPIRED' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_is_deletable(uuid)'::regprocedure)) = 0 then
    raise exception '0036 ABORTED: booking_item_confirm or booking_request_is_deletable is not 0035''s version';
  end if;
  for r in select unnest(array['public.host_payout_accounts', 'public.booking_payments', 'public.stripe_events']) as t loop
    if to_regclass(r.t) is not null then
      raise exception '0036 ABORTED: % already exists', r.t;
    end if;
  end loop;
  if to_regprocedure('public.booking_payment_transfer_blocker(uuid)') is not null
     or to_regclass('public.booking_payment_transfer_releases') is not null
     or to_regprocedure('public.support_staff_release_host_transfer(uuid, text)') is not null then
    raise exception '0036 ABORTED: a 0036 payment object already exists';
  end if;
  -- 0029's support schema, as the release gate reads it.
  if to_regclass('public.staff_members') is null or to_regprocedure('public.is_felyn_staff()') is null
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'support_threads'
          and column_name in ('user_id', 'booking_request_item_id', 'category', 'status', 'last_message_at')) <> 5
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'support_threads'
                and column_name = 'case_activity_at')
     or to_regprocedure('public.support_messages_touch_thread()') is null then
    raise exception '0036 ABORTED: 0029''s support schema is not as expected';
  end if;
  if to_regprocedure('public.booking_request_items_before_insert()') is null
     or to_regprocedure('public.booking_host_lock(uuid)') is null
     or to_regprocedure('public.booking_expire_host_payments(uuid)') is null
     or to_regprocedure('public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)') is null then
    raise exception '0036 ABORTED: a 0031-0035 booking function is missing';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  -- ── host payout accounts ──
  create table public.host_payout_accounts (
    provider_id uuid primary key references public.providers(id) on delete restrict,
    stripe_account_id text not null,
    livemode boolean not null,
    country text,
    default_currency text,
    details_submitted boolean not null default false,
    charges_enabled boolean not null default false,
    payouts_enabled boolean not null default false,
    transfers_capability text not null default 'inactive',
    requirements_currently_due text[] not null default '{}',
    requirements_past_due text[] not null default '{}',
    disabled_reason text,
    -- When Stripe's state below was read (an API fetch, or the event's creation time).
    stripe_synced_at timestamptz,
    -- Never written directly: derived from Stripe's own fields.
    payouts_ready boolean generated always as (
      details_submitted and payouts_enabled and transfers_capability = 'active'
      and disabled_reason is null and cardinality(requirements_past_due) = 0
    ) stored,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint host_payout_accounts_stripe_account_id_key unique (stripe_account_id),
    constraint host_payout_accounts_account_id_check check (stripe_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'),
    constraint host_payout_accounts_country_check check (country is null or country ~ '^[A-Z]{2}$'),
    constraint host_payout_accounts_currency_check check (default_currency is null or default_currency ~ '^[a-z]{3}$'),
    constraint host_payout_accounts_transfers_check check (transfers_capability in ('active', 'inactive', 'pending', 'unrequested')),
    constraint host_payout_accounts_requirements_check check (
      cardinality(requirements_currently_due) <= 200 and cardinality(requirements_past_due) <= 200),
    constraint host_payout_accounts_disabled_reason_check check (disabled_reason is null or char_length(disabled_reason) between 1 and 200),
    -- Any state beyond the defaults must come from a recorded Stripe sync.
    constraint host_payout_accounts_synced_check check (
      stripe_synced_at is not null
      or not (details_submitted or charges_enabled or payouts_enabled or transfers_capability <> 'inactive'
              or cardinality(requirements_currently_due) > 0 or cardinality(requirements_past_due) > 0
              or disabled_reason is not null))
  );

  create function public.host_payout_accounts_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.provider_id is distinct from old.provider_id
       or new.stripe_account_id is distinct from old.stripe_account_id
       or new.livemode is distinct from old.livemode
       or new.created_at is distinct from old.created_at then
      raise exception 'A host payout account''s host, Stripe account and mode never change' using errcode = '23514';
    end if;
    -- Out-of-order Stripe events: an older reading never overwrites a newer one.
    if old.stripe_synced_at is not null
       and (new.stripe_synced_at is null or new.stripe_synced_at < old.stripe_synced_at) then
      raise exception 'A host payout account sync can''t move backwards in time' using errcode = '23514';
    end if;
    new.updated_at := now();
    return new;
  end $fn$;
  create trigger host_payout_accounts_before_update
    before update on public.host_payout_accounts
    for each row execute function public.host_payout_accounts_before_update();

  -- ── payment attempts ──
  create table public.booking_payments (
    id uuid primary key default gen_random_uuid(),
    booking_request_item_id uuid not null references public.booking_request_items(id) on delete restrict,
    attempt_no integer not null,
    status text not null default 'creating',
    livemode boolean not null,
    currency text not null default 'EUR',
    price_per_person_cents integer not null,
    guest_count integer not null,
    gross_cents integer not null,
    platform_fee_cents integer not null,
    host_share_cents integer not null,
    -- The host's connected account at the time of payment (the later transfer's destination).
    destination_account_id text not null references public.host_payout_accounts(stripe_account_id) on delete restrict,
    -- Set on the PaymentIntent, its charge and the host transfer, to tie them together in Stripe.
    transfer_group text generated always as ('felyn_payment_' || id::text) stored,
    checkout_session_id text,
    checkout_expires_at timestamptz,
    payment_intent_id text,
    charge_id text,
    failure_reason text,
    refunded_cents integer not null default 0,
    dispute_id text,
    dispute_status text,
    disputed_at timestamptz,
    host_transfer_status text not null default 'none',
    transfer_released_at timestamptz,
    transfer_release_kind text,
    transfer_released_by uuid references auth.users(id) on delete restrict,
    transfer_release_note text,
    stripe_transfer_id text,
    transferred_at timestamptz,
    transfer_reversed_cents integer not null default 0,
    created_at timestamptz not null default now(),
    session_opened_at timestamptz,
    authorized_at timestamptz,
    captured_at timestamptz,
    confirmed_at timestamptz,
    closed_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint booking_payments_attempt_key unique (booking_request_item_id, attempt_no),
    constraint booking_payments_checkout_session_id_key unique (checkout_session_id),
    constraint booking_payments_payment_intent_id_key unique (payment_intent_id),
    constraint booking_payments_charge_id_key unique (charge_id),
    constraint booking_payments_dispute_id_key unique (dispute_id),
    constraint booking_payments_stripe_transfer_id_key unique (stripe_transfer_id),
    constraint booking_payments_attempt_no_check check (attempt_no >= 1),
    constraint booking_payments_status_check check (status in (
      'creating', 'open', 'expired', 'failed', 'authorized', 'released', 'captured', 'confirmed', 'unconfirmable')),
    -- ── money: integer cents, EUR only, €5 minimum, exact split ──
    constraint booking_payments_currency_check check (currency = 'EUR'),
    constraint booking_payments_price_check check (price_per_person_cents >= 500),
    constraint booking_payments_guest_count_check check (guest_count >= 1),
    constraint booking_payments_gross_check check (
      gross_cents between 1 and 99999999
      and gross_cents::bigint = price_per_person_cents::bigint * guest_count),
    constraint booking_payments_fee_check check (platform_fee_cents = (gross_cents + 5) / 10),
    constraint booking_payments_host_share_check check (
      host_share_cents > 0 and platform_fee_cents + host_share_cents = gross_cents),
    -- ── Stripe ids: shape, and the session's test/live prefix matches the mode ──
    constraint booking_payments_checkout_session_id_check check (
      checkout_session_id is null
      or (checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'
          and (checkout_session_id like 'cs\_live\_%') = livemode)),
    constraint booking_payments_payment_intent_id_check check (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'),
    constraint booking_payments_charge_id_check check (charge_id is null or charge_id ~ '^(ch|py)_[A-Za-z0-9]{1,250}$'),
    constraint booking_payments_dispute_id_check check (dispute_id is null or dispute_id ~ '^(dp|du)_[A-Za-z0-9]{1,250}$'),
    constraint booking_payments_stripe_transfer_id_check check (stripe_transfer_id is null or stripe_transfer_id ~ '^tr_[A-Za-z0-9]{1,250}$'),
    constraint booking_payments_failure_reason_check check (failure_reason is null or char_length(failure_reason) between 1 and 500),
    constraint booking_payments_dispute_status_check check (dispute_status is null or char_length(dispute_status) between 1 and 50),
    -- ── what each status requires ──
    constraint booking_payments_session_check check (
      status not in ('open', 'expired', 'authorized', 'released', 'captured', 'confirmed', 'unconfirmable')
      or (checkout_session_id is not null and checkout_expires_at is not null and session_opened_at is not null)),
    constraint booking_payments_authorized_check check (
      status not in ('authorized', 'released', 'captured', 'confirmed', 'unconfirmable')
      or (payment_intent_id is not null and authorized_at is not null)),
    constraint booking_payments_captured_check check (
      (status in ('captured', 'confirmed', 'unconfirmable')) = (captured_at is not null)
      and (status not in ('captured', 'confirmed', 'unconfirmable') or charge_id is not null)),
    constraint booking_payments_confirmed_check check ((status = 'confirmed') = (confirmed_at is not null)),
    constraint booking_payments_closed_check check (
      (status in ('expired', 'failed', 'released', 'unconfirmable')) = (closed_at is not null)),
    -- ── refunds and disputes (only on captured money) ──
    constraint booking_payments_refund_check check (
      refunded_cents between 0 and gross_cents
      and (refunded_cents = 0 or status in ('captured', 'confirmed', 'unconfirmable'))),
    constraint booking_payments_dispute_check check (
      (dispute_id is null) = (disputed_at is null)
      and (dispute_id is not null or dispute_status is null)
      and (dispute_id is null or status in ('captured', 'confirmed', 'unconfirmable'))),
    -- ── the host transfer ──
    constraint booking_payments_transfer_status_check check (host_transfer_status in (
      'none', 'pending', 'released', 'transferred', 'blocked', 'reversed')),
    constraint booking_payments_transfer_stage_check check (
      (host_transfer_status = 'none') = (status not in ('confirmed', 'unconfirmable'))
      and (status <> 'unconfirmable' or host_transfer_status = 'blocked')),
    -- A refund or a dispute stops the transfer: it must be blocked for support to reconcile.
    constraint booking_payments_transfer_clean_check check (
      host_transfer_status not in ('pending', 'released', 'transferred')
      or (refunded_cents = 0 and dispute_id is null)),
    -- The release record: present exactly while released (or later); staff releases
    -- carry the admin and a note, automatic ones neither.
    constraint booking_payments_transfer_release_check check (
      (host_transfer_status not in ('released', 'transferred', 'reversed') or transfer_released_at is not null)
      and (host_transfer_status not in ('none', 'pending') or transfer_released_at is null)
      and ((transfer_release_kind is null) = (transfer_released_at is null))
      and (transfer_release_kind is null or transfer_release_kind in ('automatic', 'staff'))
      and (coalesce(transfer_release_kind, '') <> 'staff'
           or (transfer_released_by is not null and transfer_release_note is not null
               and char_length(btrim(transfer_release_note)) between 1 and 1000))
      and (coalesce(transfer_release_kind, '') = 'staff'
           or (transfer_released_by is null and transfer_release_note is null))),
    constraint booking_payments_transfer_id_check check (
      (host_transfer_status not in ('transferred', 'reversed') or (stripe_transfer_id is not null and transferred_at is not null))
      and ((stripe_transfer_id is null) = (transferred_at is null))),
    constraint booking_payments_transfer_reversal_check check (
      transfer_reversed_cents between 0 and host_share_cents
      and (transfer_reversed_cents = 0 or stripe_transfer_id is not null)
      and (host_transfer_status <> 'reversed' or transfer_reversed_cents > 0))
  );
  -- At most one live attempt per booking item: never two open attempts, never two
  -- successful payments. Expired, failed and released attempts don't count (retries).
  create unique index booking_payments_one_live_attempt
    on public.booking_payments (booking_request_item_id)
    where status in ('creating', 'open', 'authorized', 'captured', 'confirmed', 'unconfirmable');
  create index booking_payments_transfer_queue_idx
    on public.booking_payments (host_transfer_status)
    where host_transfer_status in ('pending', 'released', 'blocked');

  -- A new attempt: checked against the booking itself (never trusted from the caller).
  create function public.booking_payments_before_insert()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare
    v_item record;
    v_account record;
  begin
    if new.status <> 'creating'
       or new.checkout_session_id is not null or new.checkout_expires_at is not null
       or new.payment_intent_id is not null or new.charge_id is not null or new.failure_reason is not null
       or new.refunded_cents <> 0 or new.dispute_id is not null or new.dispute_status is not null
       or new.disputed_at is not null or new.host_transfer_status <> 'none' or new.transfer_released_at is not null
       or new.transfer_release_kind is not null or new.transfer_released_by is not null or new.transfer_release_note is not null
       or new.stripe_transfer_id is not null or new.transferred_at is not null or new.transfer_reversed_cents <> 0
       or new.session_opened_at is not null or new.authorized_at is not null or new.captured_at is not null
       or new.confirmed_at is not null or new.closed_at is not null then
      raise exception 'A new payment attempt must start as creating, with nothing recorded yet' using errcode = '23514';
    end if;
    -- Lock the booking item: attempts on one item are created one at a time.
    select bri.status, bri.payment_due_at, bri.price_per_person, bri.guest_count, e.currency, e.provider_id
      into v_item
      from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
     where bri.id = new.booking_request_item_id
       for update of bri;
    if not found then
      raise exception 'Unknown booking item' using errcode = '23503';
    end if;
    if v_item.status <> 'AWAITING_PAYMENT' then
      raise exception 'This booking is not awaiting payment' using errcode = '23514';
    end if;
    -- 41 minutes: Stripe's 30-minute minimum Checkout lifetime + the 10-minute buffer
    -- before payment_due_at + 1 minute of margin (src/lib/payments/timing.ts).
    if v_item.payment_due_at - now() < interval '41 minutes' then
      raise exception 'It is too close to the payment deadline to start a new payment' using errcode = 'FB005';
    end if;
    if v_item.price_per_person < 5 then
      raise exception 'This booking is priced below the €5 per person minimum' using errcode = 'FB004';
    end if;
    if v_item.currency is distinct from 'EUR' then
      raise exception 'Only euro prices can be paid' using errcode = '23514';
    end if;
    if new.price_per_person_cents is distinct from (v_item.price_per_person * 100)::integer
       or new.guest_count is distinct from v_item.guest_count then
      raise exception 'A payment attempt must match the booking''s own price and guest count' using errcode = '23514';
    end if;
    select hpa.stripe_account_id, hpa.livemode, hpa.payouts_ready into v_account
      from public.host_payout_accounts hpa
     where hpa.provider_id = v_item.provider_id;
    if not found or not v_account.payouts_ready or v_account.livemode is distinct from new.livemode then
      raise exception 'This host can''t receive payouts' using errcode = 'FB006';
    end if;
    if new.destination_account_id is distinct from v_account.stripe_account_id then
      raise exception 'A payment''s destination must be this host''s own payout account' using errcode = '23514';
    end if;
    -- The next attempt number (the item lock above serializes this).
    select coalesce(max(bp.attempt_no), 0) + 1 into new.attempt_no
      from public.booking_payments bp where bp.booking_request_item_id = new.booking_request_item_id;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end $fn$;
  create trigger booking_payments_before_insert
    before insert on public.booking_payments
    for each row execute function public.booking_payments_before_insert();

  -- ── the support-case side of the release gate ──
  -- One advisory-lock key per user: support-thread writes take it SHARED, a host
  -- transfer's release/transfer takes the guest's and host's keys EXCLUSIVELY.
  create function public.booking_support_case_key(p_user_id uuid)
  returns bigint language sql immutable set search_path = '' as $fn$
    select pg_catalog.hashtextextended('felyn.support_case:' || p_user_id::text, 0)
  $fn$;

  -- Exclusive locks on the booking's guest and host, in a fixed order (no deadlocks).
  -- Held to the end of the transaction.
  create function public.booking_support_case_lock(p_item_id uuid)
  returns void language plpgsql volatile set search_path = '' as $fn$
  declare
    v_user uuid;
  begin
    for v_user in
      select distinct x.u
        from (select br.user_id as u
                from public.booking_request_items bri
                join public.booking_requests br on br.id = bri.booking_request_id
               where bri.id = p_item_id
              union all
              select p.user_id
                from public.booking_request_items bri
                join public.experiences e on e.id = bri.experience_id
                join public.providers p on p.id = e.provider_id
               where bri.id = p_item_id) x
       where x.u is not null
       order by x.u
    loop
      perform pg_catalog.pg_advisory_xact_lock(public.booking_support_case_key(v_user));
    end loop;
  end $fn$;

  -- When a support thread last changed, stamped after its lock (set by the trigger below).
  alter table public.support_threads add column case_activity_at timestamptz;

  -- Is there an OPEN support case about this booking? A thread linked to it, or a
  -- booking-related thread (booking, cancellation, payment, experience) of its guest or
  -- host that has been active since the host accepted. With p_after: only cases with
  -- activity (opened, reopened, new message) after that moment. VOLATILE: called after
  -- the locks above, it reads with a fresh snapshot.
  create function public.booking_payment_open_support_case(p_item_id uuid, p_after timestamptz)
  returns boolean language sql volatile set search_path = '' as $fn$
    select exists (
      select 1
        from public.booking_request_items bri
        join public.booking_requests br on br.id = bri.booking_request_id
        join public.experiences e on e.id = bri.experience_id
        join public.providers p on p.id = e.provider_id
        join public.support_threads t
          on t.booking_request_item_id = bri.id
          or (t.booking_request_item_id is null
              and t.user_id in (br.user_id, p.user_id)
              and t.category in ('booking', 'cancellation', 'payment', 'experience')
              and coalesce(t.case_activity_at, t.last_message_at) >= bri.accepted_at)
       where bri.id = p_item_id
         and t.status = 'OPEN'
         and (p_after is null or coalesce(t.case_activity_at, t.last_message_at) > p_after))
  $fn$;

  -- Every write to a support thread (opening, reopening, a status change, and every
  -- new message, through 0029's support_messages_touch_thread) takes its owner's lock
  -- SHARED and records when, after the lock, it happened.
  create function public.support_threads_case_activity()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    perform pg_catalog.pg_advisory_xact_lock_shared(public.booking_support_case_key(new.user_id));
    new.case_activity_at := pg_catalog.clock_timestamp();
    return new;
  end $fn$;
  create trigger support_threads_case_activity
    before insert or update on public.support_threads
    for each row execute function public.support_threads_case_activity();

  -- Every release, as recorded (append-only).
  create table public.booking_payment_transfer_releases (
    id uuid primary key default gen_random_uuid(),
    booking_payment_id uuid not null references public.booking_payments(id) on delete restrict,
    release_kind text not null,
    released_by uuid references auth.users(id) on delete restrict,
    release_note text,
    released_at timestamptz not null,
    recorded_at timestamptz not null default now(),
    constraint booking_payment_transfer_releases_kind_check check (release_kind in ('automatic', 'staff')),
    constraint booking_payment_transfer_releases_staff_check check (
      (release_kind = 'staff') = (released_by is not null and release_note is not null))
  );
  create index booking_payment_transfer_releases_payment_idx on public.booking_payment_transfer_releases (booking_payment_id);
  create function public.booking_payment_transfer_releases_append_only()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    raise exception 'Host transfer releases are an append-only record' using errcode = '23514';
  end $fn$;
  create trigger booking_payment_transfer_releases_append_only
    before update or delete on public.booking_payment_transfer_releases
    for each row execute function public.booking_payment_transfer_releases_append_only();
  create trigger booking_payment_transfer_releases_no_truncate
    before truncate on public.booking_payment_transfer_releases
    for each statement execute function public.booking_payment_transfer_releases_append_only();

  create function public.booking_payments_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare
    v_item record;
    v_releasing boolean;
  begin
    if new.id is distinct from old.id
       or new.booking_request_item_id is distinct from old.booking_request_item_id
       or new.attempt_no is distinct from old.attempt_no
       or new.livemode is distinct from old.livemode
       or new.currency is distinct from old.currency
       or new.price_per_person_cents is distinct from old.price_per_person_cents
       or new.guest_count is distinct from old.guest_count
       or new.gross_cents is distinct from old.gross_cents
       or new.platform_fee_cents is distinct from old.platform_fee_cents
       or new.host_share_cents is distinct from old.host_share_cents
       or new.destination_account_id is distinct from old.destination_account_id
       or new.created_at is distinct from old.created_at then
      raise exception 'A payment attempt''s booking, mode and amounts never change' using errcode = '23514';
    end if;
    -- Stripe ids and milestones are written once.
    if (old.checkout_session_id is not null and new.checkout_session_id is distinct from old.checkout_session_id)
       or (old.checkout_expires_at is not null and new.checkout_expires_at is distinct from old.checkout_expires_at)
       or (old.payment_intent_id is not null and new.payment_intent_id is distinct from old.payment_intent_id)
       or (old.charge_id is not null and new.charge_id is distinct from old.charge_id)
       or (old.dispute_id is not null and new.dispute_id is distinct from old.dispute_id)
       or (old.disputed_at is not null and new.disputed_at is distinct from old.disputed_at)
       or (old.stripe_transfer_id is not null and new.stripe_transfer_id is distinct from old.stripe_transfer_id)
       or (old.transferred_at is not null and new.transferred_at is distinct from old.transferred_at)
       or (old.session_opened_at is not null and new.session_opened_at is distinct from old.session_opened_at)
       or (old.authorized_at is not null and new.authorized_at is distinct from old.authorized_at)
       or (old.captured_at is not null and new.captured_at is distinct from old.captured_at)
       or (old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at)
       or (old.closed_at is not null and new.closed_at is distinct from old.closed_at) then
      raise exception 'Stripe ids and payment milestones can only be recorded once' using errcode = '23514';
    end if;
    -- The release record is written only on pending -> released (by the gate below) and
    -- cleared only on blocked -> pending (so support can have it released again).
    if (new.transfer_released_at, new.transfer_release_kind, new.transfer_released_by, new.transfer_release_note)
       is distinct from (old.transfer_released_at, old.transfer_release_kind, old.transfer_released_by, old.transfer_release_note)
       and not (old.host_transfer_status = 'pending' and new.host_transfer_status = 'released')
       and not (old.host_transfer_status = 'blocked' and new.host_transfer_status = 'pending'
                and new.transfer_released_at is null and new.transfer_release_kind is null
                and new.transfer_released_by is null and new.transfer_release_note is null) then
      raise exception 'A host transfer release is recorded only by the release gate' using errcode = '23514';
    end if;
    if old.host_transfer_status = 'blocked' and new.host_transfer_status = 'pending' and old.stripe_transfer_id is not null then
      raise exception 'A transferred payment can''t go back to pending; reverse the transfer instead' using errcode = '23514';
    end if;
    if new.refunded_cents < old.refunded_cents or new.transfer_reversed_cents < old.transfer_reversed_cents then
      raise exception 'Refunded and reversed amounts can only grow' using errcode = '23514';
    end if;
    if new.status is distinct from old.status
       and not ((old.status = 'creating' and new.status in ('open', 'failed'))
                or (old.status = 'open' and new.status in ('expired', 'failed', 'authorized'))
                or (old.status = 'authorized' and new.status in ('captured', 'released'))
                or (old.status = 'captured' and new.status in ('confirmed', 'unconfirmable'))) then
      raise exception 'Payment attempt status cannot change from % to %', old.status, new.status using errcode = '23514';
    end if;
    if new.host_transfer_status is distinct from old.host_transfer_status
       and not ((old.host_transfer_status = 'none' and new.host_transfer_status in ('pending', 'blocked'))
                or (old.host_transfer_status = 'pending' and new.host_transfer_status in ('released', 'blocked'))
                or (old.host_transfer_status = 'released' and new.host_transfer_status in ('transferred', 'blocked'))
                or (old.host_transfer_status = 'transferred' and new.host_transfer_status in ('reversed', 'blocked'))
                or (old.host_transfer_status = 'blocked' and new.host_transfer_status in ('pending', 'reversed'))) then
      raise exception 'Host transfer status cannot change from % to %', old.host_transfer_status, new.host_transfer_status
        using errcode = '23514';
    end if;
    -- A payment is "confirmed" only once 0035's payment step has confirmed the booking.
    if new.status = 'confirmed' and old.status <> 'confirmed'
       and (select bri.status from public.booking_request_items bri where bri.id = new.booking_request_item_id)
           is distinct from 'CONFIRMED' then
      raise exception 'A payment can only be confirmed once its booking is CONFIRMED' using errcode = '23514';
    end if;
    -- The release gate: on release, and again just before the transfer is recorded.
    if (old.host_transfer_status = 'pending' and new.host_transfer_status = 'released')
       or (old.host_transfer_status = 'released' and new.host_transfer_status = 'transferred') then
      v_releasing := new.host_transfer_status = 'released';
      -- Wait for any support-thread write of this guest or host in progress, and keep new
      -- ones waiting until this transaction ends; everything below sees them.
      perform public.booking_support_case_lock(new.booking_request_item_id);
      if v_releasing then
        new.transfer_released_at := pg_catalog.clock_timestamp();  -- never the caller's
      end if;
      select bri.status, bri.completed_at, bri.confirmed_start_at, bri.duration_minutes into v_item
        from public.booking_request_items bri where bri.id = new.booking_request_item_id;
      if v_item.status is distinct from 'CONFIRMED' or v_item.completed_at is null then
        raise exception 'A host transfer needs a CONFIRMED, completed experience' using errcode = 'FB007';
      end if;
      if v_item.confirmed_start_at is null or v_item.duration_minutes is null
         or pg_catalog.clock_timestamp()
            < v_item.confirmed_start_at + v_item.duration_minutes * interval '1 minute' + interval '168 hours' then
        raise exception 'A host transfer needs seven full days after the experience''s scheduled end' using errcode = 'FB007';
      end if;
      if new.refunded_cents <> 0 or new.dispute_id is not null then
        raise exception 'A refunded or disputed payment is never transferred automatically' using errcode = 'FB007';
      end if;
      if new.transfer_release_kind = 'staff' then
        -- Only a signed-in admin, as themselves: a session without the 'authenticated'
        -- role (the owner's scheduled jobs) can't stand in for one.
        if v_releasing
           and (coalesce(pg_catalog.current_setting('role', true), '') <> 'authenticated'
                or auth.uid() is null
                or new.transfer_released_by is distinct from auth.uid()
                or not exists (select 1 from public.staff_members s where s.user_id = auth.uid() and s.role = 'admin')) then
          raise exception 'Only a signed-in Felyn admin can release a host transfer under review' using errcode = '42501';
        end if;
        if not v_releasing and public.booking_payment_open_support_case(new.booking_request_item_id, new.transfer_released_at) then
          raise exception 'A support case was opened, reopened or answered after the staff release' using errcode = 'FB008';
        end if;
      elsif public.booking_payment_open_support_case(new.booking_request_item_id, null) then
        raise exception 'This booking has an open support case' using errcode = 'FB008';
      end if;
    end if;
    new.updated_at := now();
    return new;
  end $fn$;
  create trigger booking_payments_before_update
    before update on public.booking_payments
    for each row execute function public.booking_payments_before_update();

  create function public.booking_payments_record_release()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    insert into public.booking_payment_transfer_releases
      (booking_payment_id, release_kind, released_by, release_note, released_at)
    values (new.id, new.transfer_release_kind, new.transfer_released_by, new.transfer_release_note, new.transfer_released_at);
    return null;
  end $fn$;
  create trigger booking_payments_record_release
    after update of host_transfer_status on public.booking_payments
    for each row when (old.host_transfer_status = 'pending' and new.host_transfer_status = 'released')
    execute function public.booking_payments_record_release();

  -- The admin path for a payment whose support case needed review. Everything is
  -- checked again by the update guard; a payment that isn't pending returns false.
  create function public.support_staff_release_host_transfer(p_payment_id uuid, p_note text)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
    v_note text := btrim(coalesce(p_note, ''));
  begin
    if v_uid is null
       or not exists (select 1 from public.staff_members s where s.user_id = v_uid and s.role = 'admin') then
      raise exception 'Only a Felyn admin can release a host transfer' using errcode = '42501';
    end if;
    if char_length(v_note) not between 1 and 1000 then
      raise exception 'A release needs a note (1-1000 characters)' using errcode = '22023';
    end if;
    update public.booking_payments bp
       set host_transfer_status = 'released',
           transfer_release_kind = 'staff',
           transfer_released_by = v_uid,
           transfer_release_note = v_note
     where bp.id = p_payment_id
       and bp.host_transfer_status = 'pending';
    return found;
  end $fn$;

  -- Why a host transfer may not be created now (null = it may). Mirrors
  -- getHostTransferEligibility (src/lib/payments/lifecycle.ts) plus the release gate.
  create function public.booking_payment_transfer_blocker(p_payment_id uuid)
  returns text language sql volatile security definer set search_path = '' as $fn$
    select case
      when bp.id is null then 'unknown_payment'
      when bp.host_transfer_status in ('transferred', 'reversed') then 'already_transferred'
      when bp.status <> 'confirmed' then 'payment_not_confirmed'
      when bri.status <> 'CONFIRMED' then 'booking_not_confirmed'
      when bri.completed_at is null then 'not_completed'
      when bp.dispute_id is not null then 'disputed'
      when bp.refunded_cents <> 0 then 'refunded'
      when bp.host_transfer_status = 'blocked' then 'blocked'
      when bp.host_transfer_status <> 'released' then 'awaiting_release'
      when pg_catalog.clock_timestamp()
           < bri.confirmed_start_at + bri.duration_minutes * interval '1 minute' + interval '168 hours' then 'review_period'
      when bp.transfer_release_kind = 'staff'
           and public.booking_payment_open_support_case(bri.id, bp.transfer_released_at) then 'support_case'
      when bp.transfer_release_kind is distinct from 'staff'
           and public.booking_payment_open_support_case(bri.id, null) then 'support_case'
      else null
    end
    from (select 1) one
    left join public.booking_payments bp on bp.id = p_payment_id
    left join public.booking_request_items bri on bri.id = bp.booking_request_item_id
  $fn$;

  -- ── Stripe event deduplication ──
  create table public.stripe_events (
    event_id text primary key,
    event_type text not null,
    livemode boolean not null,
    stripe_created_at timestamptz not null,
    payload_sha256 text not null,
    received_at timestamptz not null default now(),
    last_received_at timestamptz not null default now(),
    delivery_count integer not null default 1,
    processing_status text not null default 'received',
    processed_at timestamptz,
    outcome text,
    last_error text,
    booking_payment_id uuid references public.booking_payments(id) on delete restrict,
    connected_account_id text,
    constraint stripe_events_event_id_check check (event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
    constraint stripe_events_event_type_check check (char_length(event_type) <= 100 and event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
    constraint stripe_events_payload_sha256_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
    constraint stripe_events_delivery_count_check check (delivery_count >= 1),
    constraint stripe_events_processing_status_check check (processing_status in ('received', 'processed', 'ignored', 'failed')),
    constraint stripe_events_processed_check check ((processing_status in ('processed', 'ignored')) = (processed_at is not null)),
    constraint stripe_events_outcome_check check (outcome is null or char_length(outcome) between 1 and 200),
    constraint stripe_events_last_error_check check (last_error is null or char_length(last_error) between 1 and 1000),
    constraint stripe_events_account_check check (connected_account_id is null or connected_account_id ~ '^acct_[A-Za-z0-9]{1,250}$')
  );
  create index stripe_events_booking_payment_id_idx on public.stripe_events (booking_payment_id);
  create index stripe_events_unfinished_idx on public.stripe_events (received_at)
    where processing_status in ('received', 'failed');

  create function public.stripe_events_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.event_id is distinct from old.event_id
       or new.event_type is distinct from old.event_type
       or new.livemode is distinct from old.livemode
       or new.stripe_created_at is distinct from old.stripe_created_at
       or new.payload_sha256 is distinct from old.payload_sha256
       or new.received_at is distinct from old.received_at then
      raise exception 'A Stripe event''s identity and payload never change' using errcode = '23514';
    end if;
    if new.delivery_count < old.delivery_count then
      raise exception 'A Stripe event''s delivery count can only grow' using errcode = '23514';
    end if;
    -- Simultaneous redeliveries commit in any order (now() is each transaction's start):
    -- keep the latest time rather than refusing one.
    new.last_received_at := greatest(old.last_received_at, new.last_received_at);
    -- Processed or ignored is final (a redelivery only counts the delivery).
    if old.processing_status in ('processed', 'ignored')
       and (new.processing_status is distinct from old.processing_status
            or new.processed_at is distinct from old.processed_at
            or new.outcome is distinct from old.outcome) then
      raise exception 'A processed Stripe event is final' using errcode = '23514';
    end if;
    if old.booking_payment_id is not null and new.booking_payment_id is distinct from old.booking_payment_id then
      raise exception 'A Stripe event''s payment is recorded once' using errcode = '23514';
    end if;
    return new;
  end $fn$;
  create trigger stripe_events_before_update
    before update on public.stripe_events
    for each row execute function public.stripe_events_before_update();

  -- ── the €5 minimum price ──
  -- New prices only: an existing experience under €5 keeps its price (and stays
  -- editable), but can't be published again and can't receive new requests.
  create function public.experiences_enforce_min_price()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.price_per_person < 5
       and (tg_op = 'INSERT'
            or new.price_per_person is distinct from old.price_per_person
            or (new.published and not old.published)) then
      raise exception 'An experience must cost at least €5 per person' using errcode = '23514';
    end if;
    return new;
  end $fn$;
  create trigger experiences_min_price
    before insert or update of price_per_person, published on public.experiences
    for each row execute function public.experiences_enforce_min_price();

  -- Reads the experience's price itself, so it holds whatever order the insert triggers run in.
  create function public.booking_request_items_min_price()
  returns trigger language plpgsql security definer set search_path = '' as $fn$
  begin
    if exists (select 1 from public.experiences e where e.id = new.experience_id and e.price_per_person < 5) then
      raise exception 'This experience is priced below the €5 per person minimum' using errcode = 'FB004';
    end if;
    return new;
  end $fn$;
  create trigger booking_request_items_min_price
    before insert on public.booking_request_items
    for each row execute function public.booking_request_items_min_price();

  -- ── host acceptance (0035's, with 60 minutes to pay and the €5 minimum) ──
  create or replace function public.booking_item_confirm(p_item_id uuid)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
    v_provider uuid;
    v_item record;
    v_start timestamptz;
    v_due timestamptz;
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    -- Same authorization as 0031: the caller hosts this item's experience, the item is
    -- still REQUESTED and its request still active. Resolves the host whose time it takes.
    select e.provider_id into v_provider
      from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
     where bri.id = p_item_id
       and bri.status = 'REQUESTED'
       and p.user_id = v_uid
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.status in ('REQUESTED', 'CONFIRMED'));
    if not found then
      return false;
    end if;
    -- 0034: one acceptance at a time for this host (released when the transaction ends).
    perform public.booking_host_lock(v_provider);
    -- Re-read and lock the item now that this host's acceptances are serialized: another
    -- acceptance may have finished while this one waited.
    select bri.id, bri.planned_date, bri.preferred_time, bri.price_per_person, e.duration_minutes into v_item
      from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
     where bri.id = p_item_id
       and bri.status = 'REQUESTED'
       and p.user_id = v_uid
       and e.provider_id = v_provider
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.status in ('REQUESTED', 'CONFIRMED'))
       for update of bri;
    if not found then
      return false;
    end if;
    if v_item.preferred_time is null then
      raise exception 'This request has no requested start time' using errcode = '22023';
    end if;
    if v_item.duration_minutes is null or v_item.duration_minutes <= 0 then
      raise exception 'This experience has no valid duration' using errcode = '22023';
    end if;
    -- 0036: a booking under the €5 minimum can't be paid, so it can't be accepted.
    if v_item.price_per_person < 5 then
      raise exception 'This booking is priced below the €5 per person minimum' using errcode = 'FB004';
    end if;
    v_start := (v_item.planned_date + v_item.preferred_time) at time zone 'Atlantic/Canary';
    -- 0035: the guest pays by the earlier of 24 hours from now and 2 hours before the
    -- start; 0036: and must get at least 60 minutes to do so.
    v_due := least(now() + interval '24 hours', v_start - interval '2 hours');
    if v_due < now() + interval '60 minutes' then
      raise exception 'This request starts too soon to accept: the guest would have less than 60 minutes to pay'
        using errcode = 'FB001';
    end if;
    -- 0035: this host's reservations whose payment deadline has passed are released
    -- first (under the host lock), so they never block this acceptance.
    perform public.booking_expire_host_payments(v_provider);
    if public.booking_host_overlap_exists(v_provider, v_item.id, v_start,
         v_start + v_item.duration_minutes * interval '1 minute') then
      raise exception 'This experience overlaps another confirmed booking' using errcode = '23P01';
    end if;
    update public.booking_request_items bri
       set status = 'AWAITING_PAYMENT',
           accepted_at = now(),
           confirmed_start_at = v_start,
           duration_minutes = v_item.duration_minutes,
           payment_due_at = v_due
     where bri.id = v_item.id
       and bri.status = 'REQUESTED';
    return found;
  end $fn$;

  -- ── stay/request deletion (0035's, and never with a payment record) ──
  create or replace function public.booking_request_is_deletable(p_request_id uuid)
  returns boolean language sql stable security definer set search_path = '' as $fn$
    select exists (select 1 from public.booking_requests br
                    where br.id = p_request_id and br.user_id = auth.uid())
       and not exists (select 1 from public.booking_request_items bri
                        where bri.booking_request_id = p_request_id
                          and bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED', 'DECLINED', 'PAYMENT_EXPIRED'))
       and not exists (select 1 from public.booking_payments bp
                         join public.booking_request_items bri on bri.id = bp.booking_request_item_id
                        where bri.booking_request_id = p_request_id)
  $fn$;

  -- ── privileges: nothing for clients or service_role (later stages add narrow functions) ──
  -- service_role (the server's secret key) keeps reading the booking tables (the email
  -- sender does) but can no longer write them directly: every booking change goes
  -- through the definer functions, so a leaked key can't decline, cancel or delete
  -- bookings (deleting a request would cascade to its items).
  revoke insert, update, delete, truncate on table public.booking_requests from service_role;
  revoke insert, update, delete, truncate on table public.booking_request_items from service_role;
  revoke all on table public.host_payout_accounts from public, anon, authenticated, service_role;
  revoke all on table public.booking_payments from public, anon, authenticated, service_role;
  revoke all on table public.stripe_events from public, anon, authenticated, service_role;
  revoke all on table public.booking_payment_transfer_releases from public, anon, authenticated, service_role;
  alter table public.booking_payment_transfer_releases enable row level security;
  alter table public.host_payout_accounts enable row level security;
  alter table public.booking_payments enable row level security;
  alter table public.stripe_events enable row level security;
  revoke execute on function public.host_payout_accounts_before_update() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payments_before_insert() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payments_before_update() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payment_transfer_blocker(uuid) from public, anon, authenticated, service_role;
  revoke execute on function public.booking_support_case_key(uuid) from public, anon, authenticated, service_role;
  revoke execute on function public.booking_support_case_lock(uuid) from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payment_open_support_case(uuid, timestamptz) from public, anon, authenticated, service_role;
  revoke execute on function public.support_threads_case_activity() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payment_transfer_releases_append_only() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_payments_record_release() from public, anon, authenticated, service_role;
  revoke execute on function public.support_staff_release_host_transfer(uuid, text) from public, anon, service_role;
  grant execute on function public.support_staff_release_host_transfer(uuid, text) to authenticated;
  revoke execute on function public.stripe_events_before_update() from public, anon, authenticated, service_role;
  revoke execute on function public.experiences_enforce_min_price() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_request_items_min_price() from public, anon, authenticated, service_role;

  -- ═════════ 3. POSTCONDITIONS ═════════
  for r in select t, rl from unnest(array['public.host_payout_accounts', 'public.booking_payments', 'public.stripe_events',
                                          'public.booking_payment_transfer_releases']) t,
                             unnest(array['anon', 'authenticated', 'service_role']) rl loop
    if has_table_privilege(r.rl, r.t, 'SELECT') or has_table_privilege(r.rl, r.t, 'INSERT')
       or has_table_privilege(r.rl, r.t, 'UPDATE') or has_table_privilege(r.rl, r.t, 'DELETE')
       or has_table_privilege(r.rl, r.t, 'TRUNCATE') then
      raise exception '0036 VERIFY FAILED: % has a privilege on %', r.rl, r.t;
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = r.t::regclass) then
      raise exception '0036 VERIFY FAILED: RLS is off on %', r.t;
    end if;
  end loop;
  for r in select fn, rl from unnest(array['public.booking_payment_transfer_blocker(uuid)', 'public.booking_item_mark_paid(uuid)',
                                           'public.expire_due_booking_payments()', 'public.booking_payments_before_insert()',
                                           'public.booking_payments_before_update()', 'public.booking_request_items_min_price()',
                                           'public.experiences_enforce_min_price()', 'public.host_payout_accounts_before_update()',
                                           'public.stripe_events_before_update()', 'public.booking_support_case_key(uuid)',
                                           'public.booking_support_case_lock(uuid)',
                                           'public.booking_payment_open_support_case(uuid, timestamptz)',
                                           'public.support_threads_case_activity()',
                                           'public.booking_payment_transfer_releases_append_only()',
                                           'public.booking_payments_record_release()']) fn,
                              unnest(array['anon', 'authenticated', 'service_role']) rl loop
    if has_function_privilege(r.rl, r.fn, 'EXECUTE') then
      raise exception '0036 VERIFY FAILED: % can execute %', r.rl, r.fn;
    end if;
  end loop;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in (
        'host_payout_accounts_before_update', 'booking_payments_before_insert', 'booking_payments_before_update',
        'stripe_events_before_update', 'experiences_min_price', 'booking_request_items_min_price',
        'support_threads_case_activity', 'booking_payments_record_release',
        'booking_payment_transfer_releases_append_only', 'booking_payment_transfer_releases_no_truncate')) <> 10
     or to_regclass('public.booking_payments_one_live_attempt') is null
     or not (select i.indisunique from pg_index i where i.indexrelid = 'public.booking_payments_one_live_attempt'::regclass) then
    raise exception '0036 VERIFY FAILED: a trigger or the one-live-attempt index is missing';
  end if;
  if position('interval ''60 minutes''' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('interval ''30 minutes''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) > 0
     or position('FB004' in (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.booking_item_confirm(uuid)', 'EXECUTE')
     or position('booking_payments' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_is_deletable(uuid)'::regprocedure)) = 0
     or not has_function_privilege('authenticated', 'public.booking_request_is_deletable(uuid)', 'EXECUTE') then
    raise exception '0036 VERIFY FAILED: booking_item_confirm or booking_request_is_deletable is not the 0036 version';
  end if;
  for r in select t, p from unnest(array['public.booking_requests', 'public.booking_request_items']) t,
                            unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p loop
    if has_table_privilege('service_role', r.t, r.p) then
      raise exception '0036 VERIFY FAILED: service_role can still % on %', r.p, r.t;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.booking_request_items', 'SELECT')
     or not has_table_privilege('service_role', 'public.booking_requests', 'SELECT') then
    raise exception '0036 VERIFY FAILED: service_role lost SELECT on the booking tables (the email sender needs it)';
  end if;
  if not has_function_privilege('authenticated', 'public.support_staff_release_host_transfer(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_staff_release_host_transfer(uuid, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.support_staff_release_host_transfer(uuid, text)', 'EXECUTE')
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.support_staff_release_host_transfer(uuid, text)'::regprocedure)
     or position('pg_advisory_xact_lock_shared' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.support_threads_case_activity()'::regprocedure)) = 0
     or position('public.booking_support_case_lock(new.booking_request_item_id)' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_payments_before_update()'::regprocedure)) = 0
     or position('interval ''168 hours''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_payments_before_update()'::regprocedure)) = 0 then
    raise exception '0036 VERIFY FAILED: the host-transfer release gate is not in place';
  end if;
  -- 0035's payment and expiry protections are untouched.
  if position('Only the payment step can confirm a booking' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('Only payment expiry can expire a booking' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0 then
    raise exception '0036 VERIFY FAILED: 0035''s update guard changed';
  end if;
end
$migration$;
