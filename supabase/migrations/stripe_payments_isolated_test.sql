-- NOT A MIGRATION. Fail-closed isolated test for 0036_stripe_payments.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0036's tables, functions, triggers and grants, and
-- every test row, notification and email-outbox row), releases every lock, and
-- leaves the session idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0036 and AFTER 0035 (it applies 0036's body itself, then throws it
-- away; once 0036 is applied it fails during setup, changing nothing, and should not be
-- re-run). It expects 0028 (email outbox) to be applied, as in production.
-- Run it on a test or staging database, never on production.
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- now() is fixed for a whole transaction, so two things are simulated: bookings that
-- start soon (inserted relative to now(), past the 0032 rule on purpose) and the
-- passing of a payment deadline (payment_due_at moved, past the guard on purpose).
-- Everything else runs through the real functions and triggers. Concurrency is tested
-- separately with real parallel connections.
--
-- It needs three accounts in auth.users (A, B = hosts, G = guest).
--
-- What it checks:
--   privileges    P1-P5  no client or service_role access to the new tables or helpers;
--                 service_role can read but no longer write the booking tables
--   €5 minimum    M1-M6  existing prices and snapshots untouched; new or changed prices,
--                 republishing, new requests and acceptance under €5 refused
--   acceptance    T1-T5  exactly 60 minutes to pay accepted; 1 second less, 0035's old
--                 30-minute case and a past start refused (FB001); more time accepted
--   payout accts  H1-H6  readiness derived, never written; sync needed for any state;
--                 account id and mode fixed; no sync backwards; id shape; uniqueness
--   attempts      A1-A12 creation rules, amounts and split, EUR, snapshot match,
--                 destination and readiness, deadline window (41 minutes), one live
--                 attempt, retries, status transitions, set-once ids, captured but not
--                 yet confirmed, confirmation only after the booking is CONFIRMED
--   transfers     X1-X7  pending until completed AND released; completion alone
--                 releases nothing; refunds and disputes block; reversal; unconfirmable
--   release gate  R1-R12 seven full days after the scheduled end (1 second short is
--                 refused); the release time is the database's; open linked and
--                 booking-related unlinked support threads block automatic release;
--                 unrelated threads don't; non-admin staff, non-staff, a missing note,
--                 an owner session posing as an admin and a released_by mismatch are
--                 refused; the admin release is audited; repeated calls change
--                 nothing; refunds and disputes block; transfer re-checks: a new,
--                 reopened or answered case after the release blocks it; blocked ->
--                 pending -> released again; the audit record is append-only
--   events        E1-E6  one row per event id; redelivery counted; identity fixed;
--                 processed is final; shapes
--   compatibility C1-C6  acceptance notice + email, payment notice, messaging, decline,
--                 deletion with payment records, direct client writes still refused

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid; v_b_provider uuid;
  v_ea uuid; v_ea60 uuid; v_eb uuid; v_cheap uuid; v_new uuid;
  v_req uuid; v_req_p1 uuid;
  v_ids jsonb := '{}'::jsonb;
  v_pay jsonb := '{}'::jsonb;
  v_id uuid;
  v_prices_before jsonb; v_snapshots_before jsonb;
  v_text text;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t6 uuid;
  v_ok boolean;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, EXPERIENCES AND LEGACY ROWS (before 0036) ═════════
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
      values (v_a, 'STRIPE TEST HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'STRIPE TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'STRIPE TEST A120 (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_ea;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'STRIPE TEST A60 (rolled back)', 'food', 30, 1, 6, 60, true) returning id into v_ea60;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_b_provider, 'STRIPE TEST B120 (rolled back)', 'drink', 40, 1, 6, 120, true) returning id into v_eb;
    -- An experience priced under €5, created before 0036 (allowed then).
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'STRIPE TEST CHEAP (rolled back)', 'food', 3, 1, 6, 60, true) returning id into v_cheap;
    insert into public.experience_availability (experience_id, available_from, available_until)
    select id, '2026-01-01', '2030-12-31' from public.experiences where id in (v_ea, v_ea60, v_eb, v_cheap);
    -- A request for it made before 0036: stays REQUESTED with its €3 snapshot.
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_cheap, '2027-06-09', 'evening', 2, '19:00') returning id into v_id;
    v_ids := v_ids || jsonb_build_object('cheapold', v_id);
    reset role;
    select jsonb_object_agg(e.id, e.price_per_person) into v_prices_before from public.experiences e;
    select jsonb_object_agg(bri.id, bri.price_per_person) into v_snapshots_before from public.booking_request_items bri;

    -- ═════════ 1. 0036 BODY (verbatim from 0036_stripe_payments.sql, section 2) ═════════
    v_stage := 'migration';
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

    -- ═════════ 2. SETUP: REQUESTS, ACCEPTANCES, PAYOUT ACCOUNTS ═════════
    v_stage := 'setup';
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'STRIPE TEST ODD (rolled back)', 'food', 33.35, 1, 6, 60, true) returning id into v_new;
    insert into public.experience_availability (experience_id, available_from, available_until) values (v_new, '2026-01-01', '2030-12-31');
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req_p1;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req_p1, v_ea, '2027-06-01', 'evening', 2, '19:00') returning id into v_id;
    v_ids := v_ids || jsonb_build_object('p1', v_id);
    for r in select * from (values
      ('p3', 'A', '2027-06-03'),   -- amount checks
      ('p4', 'A', '2027-06-04'),   -- retries
      ('p5', 'A', '2027-06-05'),   -- captured, then the deadline passes (unconfirmable)
      ('p6', 'A', '2027-06-06'),   -- stays REQUESTED
      ('p7', 'A', '2027-06-07'),   -- the 41-minute window
      ('dec', 'A', '2027-06-08'),  -- declined
      ('pb', 'B', '2027-06-01'),   -- host B (not ready for payouts)
      ('r1', 'A', '2027-07-01'),   -- release gate: seven-day boundary, automatic
      ('r2', 'A', '2027-07-02'),   -- release gate: open linked case, staff release
      ('r3', 'A', '2027-07-03'),   -- release gate: host's unlinked payment case; re-release
      ('r4', 'A', '2027-07-04'),   -- release gate: refund
      ('r5', 'A', '2027-07-05'),   -- release gate: dispute
      ('r6', 'A', '2027-07-06')    -- release gate: case reopened after a staff release
    ) as t(k, host, d) loop
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, case r.host when 'A' then v_ea else v_eb end, r.d::date, 'evening', 2, '19:00')
      returning id into v_id;
      v_ids := v_ids || jsonb_build_object(r.k, v_id);
    end loop;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_new, '2027-06-12', 'evening', 3, '19:00') returning id into v_id;
    v_ids := v_ids || jsonb_build_object('odd', v_id);
    reset role;
    -- Starts relative to now() (past the 0032 four-hour rule on purpose; 0036's €5
    -- trigger still runs).
    for r in select * from (values
      ('at60', interval '3 hours', 'A'),                           -- exactly 60 minutes to pay
      ('below60', interval '3 hours' - interval '1 second', 'B'),  -- 1 second less
      ('late230', interval '2 hours 30 minutes', 'B'),             -- 0035 accepted this (30 minutes)
      ('above', interval '5 hours', 'A'),                          -- 3 hours to pay
      ('past', interval '-1 hour', 'A')                            -- already started
    ) as t(k, ahead, host) loop
      alter table public.booking_request_items disable trigger booking_request_items_before_insert;
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time)
      values (v_req, case r.host when 'A' then v_ea60 else v_eb end, ((now() + r.ahead) at time zone 'Atlantic/Canary')::date, 'evening', 2, 30,
              ((now() + r.ahead) at time zone 'Atlantic/Canary')::time)
      returning id into v_id;
      alter table public.booking_request_items enable trigger booking_request_items_before_insert;
      v_ids := v_ids || jsonb_build_object(r.k, v_id);
    end loop;

    -- ═════════ 3. PRIVILEGES (P1-P5) ═════════
    v_stage := 'P1 authenticated';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    for r in select unnest(array['host_payout_accounts', 'booking_payments', 'stripe_events', 'booking_payment_transfer_releases']) as t loop
      begin
        execute format('select count(*) from public.%I', r.t) into n;
        raise exception 'P1 FAILED: authenticated can read %', r.t;
      exception when insufficient_privilege then null;
      end;
    end loop;
    begin
      insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256)
      values ('evt_client', 'checkout.session.completed', false, now(), repeat('a', 64));
      raise exception 'P1 FAILED: authenticated can insert a Stripe event';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.booking_payment_transfer_blocker(gen_random_uuid());
      raise exception 'P1 FAILED: authenticated can call booking_payment_transfer_blocker';
    exception when insufficient_privilege then null;
    end;
    reset role;

    v_stage := 'P2-P4 service_role';
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    set local role service_role;
    for r in select unnest(array['host_payout_accounts', 'booking_payments', 'stripe_events', 'booking_payment_transfer_releases']) as t loop
      begin
        execute format('select count(*) from public.%I', r.t) into n;
        raise exception 'P2 FAILED: service_role can read %', r.t;
      exception when insufficient_privilege then null;
      end;
      begin
        execute format('delete from public.%I', r.t);
        raise exception 'P2 FAILED: service_role can delete from %', r.t;
      exception when insufficient_privilege then null;
      end;
    end loop;
    begin
      insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode) values (v_a_provider, 'acct_svc', false);
      raise exception 'P2 FAILED: service_role can create a payout account';
    exception when insufficient_privilege then null;
    end;
    -- P3: reads the booking tables (the email sender), writes nothing.
    select count(*) into n from public.booking_request_items where id = (v_ids->>'p6')::uuid;
    if n <> 1 then raise exception 'P3 FAILED: service_role cannot read booking_request_items'; end if;
    begin
      update public.booking_request_items set status = 'DECLINED' where id = (v_ids->>'p6')::uuid;
      raise exception 'P3 FAILED: service_role can update a booking item';
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.booking_request_items where id = (v_ids->>'p6')::uuid;
      raise exception 'P3 FAILED: service_role can delete a booking item';
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.booking_requests where id = v_req;
      raise exception 'P3 FAILED: service_role can delete a booking request (cascading to its items)';
    exception when insufficient_privilege then null;
    end;
    -- P4: none of the owner-only helpers.
    for r in select unnest(array['select public.booking_item_mark_paid($1)', 'select public.booking_payment_transfer_blocker($1)',
                                 'select public.expire_due_booking_payments()',
                                 'select public.support_staff_release_host_transfer($1, ''x'')',
                                 'select public.booking_support_case_lock($1)']) as q loop
      begin
        execute r.q using (v_ids->>'p6')::uuid;
        raise exception 'P4 FAILED: service_role can run %', r.q;
      exception when insufficient_privilege then null;
      end;
    end loop;
    reset role;
    v_stage := 'P5 anon';
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    set local role anon;
    begin
      select count(*) into n from public.booking_payments;
      raise exception 'P5 FAILED: anon can read booking_payments';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.support_staff_release_host_transfer(gen_random_uuid(), 'x');
      raise exception 'P5 FAILED: anon can call the staff release';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 4. THE €5 MINIMUM (M1-M6) ═════════
    v_stage := 'M1 nothing rewritten';
    if (select jsonb_object_agg(e.id, e.price_per_person) from public.experiences e where e.id in (select (jsonb_object_keys(v_prices_before))::uuid))
       is distinct from v_prices_before then
      raise exception 'M1 FAILED: 0036 changed an existing experience price';
    end if;
    if (select jsonb_object_agg(bri.id, bri.price_per_person) from public.booking_request_items bri
         where bri.id in (select (jsonb_object_keys(v_snapshots_before))::uuid)) is distinct from v_snapshots_before then
      raise exception 'M1 FAILED: 0036 changed an existing booking price snapshot';
    end if;
    if (select price_per_person from public.experiences where id = v_cheap) <> 3 then raise exception 'M1 FAILED: cheap price changed'; end if;

    v_stage := 'M2 new prices';
    begin
      insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
      values (v_a_provider, 'STRIPE TEST 4.99', 'food', 4.99, 1, 6, 60);
      raise exception 'M2 FAILED: a new experience at €4.99 was created';
    exception when check_violation then null;
    end;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
    values (v_a_provider, 'STRIPE TEST 5.00', 'food', 5.00, 1, 6, 60) returning id into v_new;
    begin
      update public.experiences set price_per_person = 4 where id = v_new;
      raise exception 'M2 FAILED: a price was lowered below €5';
    exception when check_violation then null;
    end;

    v_stage := 'M3 legacy cheap experience';
    update public.experiences set title = 'STRIPE TEST CHEAP renamed (rolled back)', price_per_person = 3 where id = v_cheap;  -- unchanged price: allowed
    begin
      update public.experiences set price_per_person = 4 where id = v_cheap;
      raise exception 'M3 FAILED: a sub-€5 price was changed to another sub-€5 price';
    exception when check_violation then null;
    end;
    update public.experiences set published = false where id = v_cheap;
    begin
      update public.experiences set published = true where id = v_cheap;
      raise exception 'M3 FAILED: a sub-€5 experience was republished';
    exception when check_violation then null;
    end;
    update public.experiences set published = true where id = v_ea;  -- already published, €40: fine

    v_stage := 'M4 new requests';
    alter table public.experiences disable trigger experiences_min_price;
    update public.experiences set published = true where id = v_cheap;  -- as it was before 0036
    alter table public.experiences enable trigger experiences_min_price;
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_cheap, '2027-06-10', 'evening', 2, '19:00');
      raise exception 'M4 FAILED: a new request for a sub-€5 experience was accepted';
    exception when sqlstate 'FB004' then null;
    end;
    -- M6 (control): a request for a €40 experience still works.
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_ea, '2027-06-11', 'evening', 2, '19:00') returning id into v_id;
    v_ids := v_ids || jsonb_build_object('ok40', v_id);
    reset role;

    v_stage := 'M5 acceptance under €5';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_item_confirm((v_ids->>'cheapold')::uuid);
      raise exception 'M5 FAILED: a €3 booking was accepted';
    exception when sqlstate 'FB004' then null;
    end;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'cheapold')::uuid and status = 'REQUESTED' and accepted_at is null and payment_due_at is null and price_per_person = 3;
    if n <> 1 then raise exception 'M5 FAILED: the refused €3 booking was changed'; end if;

    -- ═════════ 5. ACCEPTANCE: 60 MINUTES TO PAY (T1-T5) ═════════
    v_stage := 'T acceptance';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'at60')::uuid) then raise exception 'T1 FAILED: exactly 60 minutes to pay was refused'; end if;
    if not public.booking_item_confirm((v_ids->>'above')::uuid) then raise exception 'T4 FAILED: 3 hours to pay was refused'; end if;
    begin
      perform public.booking_item_confirm((v_ids->>'past')::uuid);
      raise exception 'T5 FAILED: a start in the past was accepted';
    exception when sqlstate 'FB001' then null;
    end;
    for r in select unnest(array['p1', 'p3', 'p4', 'p5', 'p7', 'odd', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']) as k loop
      if not public.booking_item_confirm((v_ids->>r.k)::uuid) then raise exception 'SETUP: host A cannot accept %', r.k; end if;
    end loop;
    if not public.booking_item_decline((v_ids->>'dec')::uuid, 'other', null) then raise exception 'C4 FAILED: decline no longer works'; end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_item_confirm((v_ids->>'below60')::uuid);
      raise exception 'T2 FAILED: 59 minutes 59 seconds to pay was accepted';
    exception when sqlstate 'FB001' then null;
    end;
    begin
      perform public.booking_item_confirm((v_ids->>'late230')::uuid);
      raise exception 'T3 FAILED: 30 minutes to pay (0035''s old minimum) was accepted';
    exception when sqlstate 'FB001' then null;
    end;
    if not public.booking_item_confirm((v_ids->>'pb')::uuid) then raise exception 'SETUP: host B cannot accept pb'; end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'at60')::uuid and status = 'AWAITING_PAYMENT' and payment_due_at = now() + interval '60 minutes';
    if n <> 1 then raise exception 'T1 FAILED: at60 is not AWAITING_PAYMENT with payment_due_at = now() + 60 minutes'; end if;
    select count(*) into n from public.booking_request_items
     where id in ((v_ids->>'below60')::uuid, (v_ids->>'late230')::uuid, (v_ids->>'past')::uuid)
       and status = 'REQUESTED' and accepted_at is null and confirmed_start_at is null and duration_minutes is null and payment_due_at is null;
    if n <> 3 then raise exception 'T2/T3/T5 FAILED: a refused acceptance changed the item'; end if;

    v_stage := 'C1 acceptance notice and email';
    select count(*) into n from public.notifications
     where booking_request_item_id = (v_ids->>'at60')::uuid and type = 'booking_item_accepted' and user_id = v_g;
    if n <> 1 then raise exception 'C1 FAILED: no booking_item_accepted notice'; end if;
    select count(*) into n from public.email_outbox
     where event_type = 'request_confirmed_guest' and (v_ids->>'at60')::uuid = any (booking_request_item_ids);
    if n <> 1 then raise exception 'C1 FAILED: no acceptance email queued'; end if;

    -- ═════════ 6. HOST PAYOUT ACCOUNTS (H1-H6) ═════════
    v_stage := 'H1 readiness';
    insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode, country, default_currency, details_submitted,
                                             payouts_enabled, transfers_capability, stripe_synced_at)
    values (v_a_provider, 'acct_TestHostA', false, 'ES', 'eur', true, true, 'active', now() - interval '1 hour');
    insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode) values (v_b_provider, 'acct_TestHostB', false);
    if not (select payouts_ready from public.host_payout_accounts where provider_id = v_a_provider)
       or (select payouts_ready from public.host_payout_accounts where provider_id = v_b_provider) then
      raise exception 'H1 FAILED: payouts_ready is not derived from the synced Stripe fields';
    end if;
    v_stage := 'H2 readiness is never written';
    begin
      update public.host_payout_accounts set payouts_ready = true where provider_id = v_b_provider;
      raise exception 'H2 FAILED: payouts_ready was written directly';
    exception when sqlstate '428C9' then null;
    end;
    v_stage := 'H3 state needs a sync';
    begin
      update public.host_payout_accounts set payouts_enabled = true where provider_id = v_b_provider;
      raise exception 'H3 FAILED: Stripe state recorded without a sync time';
    exception when check_violation then null;
    end;
    v_stage := 'H1 each readiness condition';
    -- Every readiness condition counts on its own (B stays not ready afterwards).
    update public.host_payout_accounts set details_submitted = true, payouts_enabled = true, transfers_capability = 'pending',
           stripe_synced_at = now() - interval '30 minutes' where provider_id = v_b_provider;
    if (select payouts_ready from public.host_payout_accounts where provider_id = v_b_provider) then
      raise exception 'H1 FAILED: ready while the transfers capability is still pending';
    end if;
    update public.host_payout_accounts set transfers_capability = 'active', disabled_reason = 'requirements.past_due',
           stripe_synced_at = now() - interval '20 minutes' where provider_id = v_b_provider;
    if (select payouts_ready from public.host_payout_accounts where provider_id = v_b_provider) then
      raise exception 'H1 FAILED: ready while Stripe reports a disabled reason';
    end if;
    update public.host_payout_accounts set disabled_reason = null, requirements_past_due = array['individual.verification.document'],
           stripe_synced_at = now() - interval '10 minutes' where provider_id = v_b_provider;
    if (select payouts_ready from public.host_payout_accounts where provider_id = v_b_provider) then
      raise exception 'H1 FAILED: ready with past-due requirements';
    end if;
    update public.host_payout_accounts set requirements_past_due = '{}', payouts_enabled = false,
           stripe_synced_at = now() - interval '5 minutes' where provider_id = v_b_provider;
    if (select payouts_ready from public.host_payout_accounts where provider_id = v_b_provider) then
      raise exception 'H1 FAILED: ready while payouts are disabled';
    end if;
    v_stage := 'H4 fixed identity';
    begin
      update public.host_payout_accounts set stripe_account_id = 'acct_Other' where provider_id = v_a_provider;
      raise exception 'H4 FAILED: the Stripe account id changed';
    exception when check_violation then null;
    end;
    begin
      update public.host_payout_accounts set livemode = true where provider_id = v_a_provider;
      raise exception 'H4 FAILED: the mode changed';
    exception when check_violation then null;
    end;
    v_stage := 'H5 out-of-order syncs';
    begin
      update public.host_payout_accounts set payouts_enabled = false, stripe_synced_at = now() - interval '2 hours'
       where provider_id = v_a_provider;
      raise exception 'H5 FAILED: an older Stripe reading overwrote a newer one';
    exception when check_violation then null;
    end;
    update public.host_payout_accounts set requirements_currently_due = array['external_account'], stripe_synced_at = now()
     where provider_id = v_a_provider;
    if not (select payouts_ready from public.host_payout_accounts where provider_id = v_a_provider) then
      raise exception 'H5 FAILED: an eventually-due requirement made the host not ready';
    end if;
    v_stage := 'H6 shape and uniqueness';
    begin
      update public.host_payout_accounts set disabled_reason = '' where provider_id = v_a_provider;
      raise exception 'H6 FAILED: an empty disabled_reason was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode)
      values ((select p.id from public.providers p where p.id not in (v_a_provider, v_b_provider) limit 1), 'acct_TestHostA', false);
      raise exception 'H6 FAILED: one Stripe account linked to two hosts';
    exception when unique_violation or not_null_violation then null;
    end;
    begin
      insert into public.host_payout_accounts (provider_id, stripe_account_id, livemode) values (v_a_provider, 'acct_Second', false);
      raise exception 'H6 FAILED: a host got a second payout account';
    exception when unique_violation then null;
    end;
    begin
      update public.host_payout_accounts set stripe_account_id = 'acct_bad-id' where provider_id = v_b_provider;
      raise exception 'H6 FAILED: a malformed account id was accepted';
    exception when check_violation then null;
    end;

    -- ═════════ 7. PAYMENT ATTEMPTS (A1-A12) ═════════
    -- G's items: 2 guests x €40 = 8000 cents; fee 800; host share 7200.
    v_stage := 'A1 a valid attempt';
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'p1')::uuid, 99, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v_id;
    v_pay := v_pay || jsonb_build_object('p1', v_id);
    select count(*) into n from public.booking_payments
     where id = v_id and attempt_no = 1 and status = 'creating' and currency = 'EUR' and host_transfer_status = 'none'
       and transfer_group = 'felyn_payment_' || v_id::text;
    if n <> 1 then raise exception 'A1 FAILED: the new attempt is not attempt 1, creating, EUR, with its transfer group'; end if;

    v_stage := 'A2 one live attempt';
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p1')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A2 FAILED: a second live attempt was created';
    exception when unique_violation then null;
    end;

    v_stage := 'A3 amounts';
    for r in select * from (values
      ('gross != price x guests', 4000, 2, 8001, 800, 7201, 'EUR'),
      ('fee not 10% half up', 4000, 2, 8000, 801, 7199, 'EUR'),
      ('fee + share != gross', 4000, 2, 8000, 800, 7100, 'EUR'),
      ('zero amounts', 0, 2, 0, 0, 0, 'EUR'),
      ('negative share', 4000, 2, 8000, 8100, -100, 'EUR'),
      ('USD', 4000, 2, 8000, 800, 7200, 'USD'),
      ('under €5 per person', 499, 2, 998, 100, 898, 'EUR')
    ) as t(label, price, guests, gross, fee, share, cur) loop
      begin
        insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, currency, price_per_person_cents, guest_count,
                                             gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
        values ((v_ids->>'p3')::uuid, 1, false, r.cur, r.price, r.guests, r.gross, r.fee, r.share, 'acct_TestHostA');
        raise exception 'A3 FAILED: % was accepted', r.label;
      exception when check_violation then null;
      end;
    end loop;
    -- Valid amounts that don't match the booking itself.
    for r in select * from (values ('price', 4100, 2, 8200, 820, 7380), ('guests', 4000, 3, 12000, 1200, 10800)) as t(label, price, guests, gross, fee, share) loop
      begin
        insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                             gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
        values ((v_ids->>'p3')::uuid, 1, false, r.price, r.guests, r.gross, r.fee, r.share, 'acct_TestHostA');
        raise exception 'A3 FAILED: an attempt with another % than the booking''s was accepted', r.label;
      exception when check_violation then null;
      end;
    end loop;
    -- Half-cent rounding on a real booking: 3 x €33.35 = 10005 cents -> fee 1000.5 -> 1001.
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'odd')::uuid, 1, false, 3335, 3, 10005, 1000, 9005, 'acct_TestHostA');
      raise exception 'A3 FAILED: a half cent was rounded down (fee 1000 on 10005)';
    exception when check_violation then null;
    end;
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'odd')::uuid, 1, false, 3335, 3, 10005, 1001, 9004, 'acct_TestHostA');

    v_stage := 'A4 must start as creating';
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, status, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p3')::uuid, 1, 'confirmed', false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A4 FAILED: an attempt was created already confirmed';
    exception when check_violation then null;
    end;

    v_stage := 'A5 destination and readiness';
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p3')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostB');
      raise exception 'A5 FAILED: another host''s account was used as the destination';
    exception when check_violation then null;
    end;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'pb')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostB');
      raise exception 'A5 FAILED: a host not ready for payouts can be paid';
    exception when sqlstate 'FB006' then null;
    end;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p3')::uuid, 1, true, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A5 FAILED: a live payment to a test-mode account was accepted';
    exception when sqlstate 'FB006' then null;
    end;

    v_stage := 'A6 booking state and the 41-minute window';
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p6')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A6 FAILED: a REQUESTED booking can be paid';
    exception when check_violation then null;
    end;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() + interval '41 minutes' - interval '1 microsecond'
     where id = (v_ids->>'p7')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p7')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A6 FAILED: a payment was started with under 41 minutes left';
    exception when sqlstate 'FB005' then null;
    end;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() + interval '41 minutes' where id = (v_ids->>'p7')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'p7')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');

    v_stage := 'A7 the payment flow on p1';
    v_id := (v_pay->>'p1')::uuid;
    update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p1', checkout_expires_at = now() + interval '1 hour',
           session_opened_at = now() where id = v_id;
    begin
      update public.booking_payments set status = 'captured', payment_intent_id = 'pi_p1', authorized_at = now(), charge_id = 'ch_p1',
             captured_at = now() where id = v_id;
      raise exception 'A7 FAILED: open -> captured skipped the authorization';
    exception when check_violation then null;
    end;
    update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_p1', authorized_at = now() where id = v_id;
    begin
      update public.booking_payments set status = 'confirmed', confirmed_at = now(), host_transfer_status = 'pending' where id = v_id;
      raise exception 'A7 FAILED: authorized -> confirmed skipped the capture';
    exception when check_violation then null;
    end;
    update public.booking_payments set status = 'captured', charge_id = 'ch_p1', captured_at = now() where id = v_id;
    -- Captured, booking not confirmed yet: a state the schema represents (reconciliation pending).
    select count(*) into n from public.booking_payments bp join public.booking_request_items bri on bri.id = bp.booking_request_item_id
     where bp.id = v_id and bp.status = 'captured' and bp.host_transfer_status = 'none' and bri.status = 'AWAITING_PAYMENT';
    if n <> 1 then raise exception 'A7 FAILED: captured-but-unconfirmed is not representable'; end if;
    begin
      update public.booking_payments set status = 'confirmed', confirmed_at = now(), host_transfer_status = 'pending' where id = v_id;
      raise exception 'A7 FAILED: the payment was confirmed while the booking is still AWAITING_PAYMENT';
    exception when check_violation then null;
    end;
    -- The trusted path: 0035's owner-only payment step, then the payment record.
    if not public.booking_item_mark_paid((v_ids->>'p1')::uuid) then raise exception 'A7 FAILED: the owner''s payment step refused p1'; end if;
    update public.booking_payments set status = 'confirmed', confirmed_at = now(), host_transfer_status = 'pending' where id = v_id;
    select count(*) into n from public.notifications
     where booking_request_item_id = (v_ids->>'p1')::uuid and type = 'booking_item_confirmed';
    if n <> 1 then raise exception 'C2 FAILED: no "confirmed" notice after payment'; end if;

    v_stage := 'A8 set-once ids, fixed amounts';
    for r in select * from (values
      ('payment_intent_id', 'pi_other'), ('charge_id', 'ch_other'), ('checkout_session_id', 'cs_test_other')
    ) as t(col, val) loop
      begin
        execute format('update public.booking_payments set %I = $1 where id = $2', r.col) using r.val, v_id;
        raise exception 'A8 FAILED: % was changed after being recorded', r.col;
      exception when check_violation then null;
      end;
    end loop;
    begin
      update public.booking_payments set gross_cents = 9000, platform_fee_cents = 900, host_share_cents = 8100, price_per_person_cents = 4500 where id = v_id;
      raise exception 'A8 FAILED: the amounts of an attempt changed';
    exception when check_violation then null;
    end;
    begin
      update public.booking_payments set status = 'open' where id = v_id;
      raise exception 'A8 FAILED: a confirmed payment went back to open';
    exception when check_violation then null;
    end;

    v_stage := 'A9-A10 Stripe id shapes and uniqueness';
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'p3')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v_id;
    v_pay := v_pay || jsonb_build_object('p3', v_id);
    begin
      update public.booking_payments set status = 'open', checkout_session_id = 'cs_live_p3', checkout_expires_at = now() + interval '1 hour',
             session_opened_at = now() where id = v_id;
      raise exception 'A9 FAILED: a live Checkout session on a test-mode attempt';
    exception when check_violation then null;
    end;
    begin
      update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p1', checkout_expires_at = now() + interval '1 hour',
             session_opened_at = now() where id = v_id;
      raise exception 'A10 FAILED: one Checkout session on two attempts';
    exception when unique_violation then null;
    end;
    update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p3', checkout_expires_at = now() + interval '1 hour',
           session_opened_at = now() where id = v_id;
    begin
      update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_p1', authorized_at = now() where id = v_id;
      raise exception 'A10 FAILED: one PaymentIntent on two attempts';
    exception when unique_violation then null;
    end;

    v_stage := 'A11 retries on p4';
    for n in 1..3 loop
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p4')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v_id;
      if (select attempt_no from public.booking_payments where id = v_id) <> n then raise exception 'A11 FAILED: attempt % numbered wrongly', n; end if;
      update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p4n' || n, checkout_expires_at = now() + interval '1 hour',
             session_opened_at = now() where id = v_id;
      if n = 1 then
        update public.booking_payments set status = 'expired', closed_at = now() where id = v_id;     -- abandoned Checkout
      elsif n = 2 then
        update public.booking_payments set status = 'failed', closed_at = now(), failure_reason = 'card_declined' where id = v_id;
      else
        update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_p4n' || n, authorized_at = now() where id = v_id;
        update public.booking_payments set status = 'released', closed_at = now() where id = v_id;  -- authorization cancelled
      end if;
    end loop;
    begin
      update public.booking_payments set status = 'open' where id = v_id;
      raise exception 'A11 FAILED: a released attempt was reopened';
    exception when check_violation then null;
    end;
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'p4')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v_id;
    update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p4n4', checkout_expires_at = now() + interval '1 hour',
           session_opened_at = now() where id = v_id;
    update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_p4n4', authorized_at = now() where id = v_id;

    v_stage := 'A12 never two successful payments';
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p4')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A12 FAILED: a new attempt next to an authorized one';
    exception when unique_violation then null;
    end;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values ((v_ids->>'p1')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA');
      raise exception 'A12 FAILED: a second payment for a paid booking';
    exception when check_violation or unique_violation then null;
    end;
    select count(*) into n from public.booking_payments where booking_request_item_id = (v_ids->>'p4')::uuid;
    if n <> 4 then raise exception 'A12 FAILED: expected 4 attempts on p4, found %', n; end if;

    -- ═════════ 8. HOST TRANSFERS (X1-X7) ═════════
    v_id := (v_pay->>'p1')::uuid;
    v_stage := 'X1 not completed';
    if public.booking_payment_transfer_blocker(v_id) is distinct from 'not_completed' then
      raise exception 'X1 FAILED: blocker is %, expected not_completed', public.booking_payment_transfer_blocker(v_id);
    end if;
    v_stage := 'X2 no release or transfer before completion';
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic' where id = v_id;
      raise exception 'X2 FAILED: a transfer was released before the experience was completed';
    exception when sqlstate 'FB007' then null;
    end;
    begin
      update public.booking_payments set host_transfer_status = 'transferred', transfer_released_at = now(),
             stripe_transfer_id = 'tr_p1', transferred_at = now() where id = v_id;
      raise exception 'X2 FAILED: pending -> transferred skipped the release';
    exception when check_violation then null;
    end;
    v_stage := 'X3 completion alone releases nothing';
    update public.booking_request_items set completed_at = now() where id = (v_ids->>'p1')::uuid;  -- as 0016's job does
    if public.booking_payment_transfer_blocker(v_id) is distinct from 'awaiting_release' then
      raise exception 'X3 FAILED: blocker is %, expected awaiting_release', public.booking_payment_transfer_blocker(v_id);
    end if;
    if (select host_transfer_status from public.booking_payments where id = v_id) <> 'pending' then
      raise exception 'X3 FAILED: completion changed the transfer status';
    end if;
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic' where id = v_id;
      raise exception 'X3 FAILED: completed, but the scheduled end is in the future, and it was released';
    exception when sqlstate 'FB007' then null;
    end;
    v_stage := 'X4 release';
    -- Eight days after the scheduled end (the snapshot moved back, past the guard on purpose).
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items
       set confirmed_start_at = now() - interval '8 days' - duration_minutes * interval '1 minute'
     where id = (v_ids->>'p1')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic' where id = v_id;
    if public.booking_payment_transfer_blocker(v_id) is not null then
      raise exception 'X4 FAILED: a released, completed, clean payment is still blocked (%)', public.booking_payment_transfer_blocker(v_id);
    end if;
    v_stage := 'X5 refunds and disputes block';
    begin
      update public.booking_payments set refunded_cents = 100 where id = v_id;
      raise exception 'X5 FAILED: a refund left the transfer released';
    exception when check_violation then null;
    end;
    update public.booking_payments set host_transfer_status = 'transferred', stripe_transfer_id = 'tr_p1', transferred_at = now() where id = v_id;
    begin
      update public.booking_payments set dispute_id = 'dp_p1', disputed_at = now(), dispute_status = 'needs_response' where id = v_id;
      raise exception 'X5 FAILED: a dispute left the transfer as transferred';
    exception when check_violation then null;
    end;
    update public.booking_payments set refunded_cents = 1000, host_transfer_status = 'blocked' where id = v_id;
    update public.booking_payments set host_transfer_status = 'reversed', transfer_reversed_cents = 1000 where id = v_id;
    if public.booking_payment_transfer_blocker(v_id) is distinct from 'already_transferred' then
      raise exception 'X5 FAILED: a transferred payment can be transferred again';
    end if;
    v_stage := 'X6 refund limits';
    begin
      update public.booking_payments set refunded_cents = 500 where id = v_id;
      raise exception 'X6 FAILED: a refunded amount went down';
    exception when check_violation then null;
    end;
    begin
      update public.booking_payments set refunded_cents = 8001 where id = v_id;
      raise exception 'X6 FAILED: more than the gross amount was refunded';
    exception when check_violation then null;
    end;
    begin
      update public.booking_payments set transfer_reversed_cents = 7201 where id = v_id;
      raise exception 'X6 FAILED: more than the host share was reversed';
    exception when check_violation then null;
    end;

    v_stage := 'X7 captured, but the deadline passed: unconfirmable';
    insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                         gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
    values ((v_ids->>'p5')::uuid, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v_id;
    update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_p5', checkout_expires_at = now() + interval '1 hour',
           session_opened_at = now() where id = v_id;
    update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_p5', authorized_at = now() where id = v_id;
    update public.booking_payments set status = 'captured', charge_id = 'ch_p5', captured_at = now() where id = v_id;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '1 minute' where id = (v_ids->>'p5')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    if public.expire_due_booking_payments() < 1 then raise exception 'X7 FAILED: the lapsed booking was not expired'; end if;
    begin
      perform public.booking_item_mark_paid((v_ids->>'p5')::uuid);
      raise exception 'X7 FAILED: an expired booking was confirmed';
    exception when sqlstate 'FB002' then null;
    end;
    begin
      update public.booking_payments set status = 'unconfirmable', closed_at = now(), host_transfer_status = 'pending' where id = v_id;
      raise exception 'X7 FAILED: an unconfirmable payment was queued for a host transfer';
    exception when check_violation then null;
    end;
    update public.booking_payments set status = 'unconfirmable', closed_at = now(), host_transfer_status = 'blocked' where id = v_id;
    update public.booking_payments set refunded_cents = 8000 where id = v_id;  -- support refunds it
    update public.booking_payments set dispute_id = 'dp_p5', disputed_at = now(), dispute_status = 'warning_needs_response' where id = v_id;
    if public.booking_payment_transfer_blocker(v_id) is distinct from 'payment_not_confirmed' then
      raise exception 'X7 FAILED: an unconfirmable payment is transferable';
    end if;
    if public.booking_payment_transfer_blocker(gen_random_uuid()) is distinct from 'unknown_payment' then
      raise exception 'X7 FAILED: an unknown payment did not report unknown_payment';
    end if;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'p5')::uuid and status = 'PAYMENT_EXPIRED';
    if n <> 1 then raise exception 'X7 FAILED: the booking is not PAYMENT_EXPIRED'; end if;

    -- ═════════ 9. THE RELEASE GATE (R1-R12) ═════════
    v_stage := 'R setup';
    -- Test-only helpers (rolled back with everything else).
    create function public.felyn_test_paid(p_item uuid, p_tag text) returns uuid language plpgsql set search_path = '' as $h$
    declare
      v uuid;
    begin
      insert into public.booking_payments (booking_request_item_id, attempt_no, livemode, price_per_person_cents, guest_count,
                                           gross_cents, platform_fee_cents, host_share_cents, destination_account_id)
      values (p_item, 1, false, 4000, 2, 8000, 800, 7200, 'acct_TestHostA') returning id into v;
      update public.booking_payments set status = 'open', checkout_session_id = 'cs_test_' || p_tag,
             checkout_expires_at = now() + interval '1 hour', session_opened_at = now() where id = v;
      update public.booking_payments set status = 'authorized', payment_intent_id = 'pi_' || p_tag, authorized_at = now() where id = v;
      update public.booking_payments set status = 'captured', charge_id = 'ch_' || p_tag, captured_at = now() where id = v;
      if not public.booking_item_mark_paid(p_item) then raise exception 'R SETUP: cannot pay %', p_tag; end if;
      update public.booking_payments set status = 'confirmed', confirmed_at = now(), host_transfer_status = 'pending' where id = v;
      return v;
    end $h$;
    -- Moves a booking's scheduled end (the snapshot moved back, past the guard on purpose) and completes it.
    create function public.felyn_test_end_at(p_item uuid, p_end timestamptz) returns void language plpgsql set search_path = '' as $h$
    begin
      alter table public.booking_request_items disable trigger booking_request_items_before_update;
      update public.booking_request_items
         set confirmed_start_at = p_end - duration_minutes * interval '1 minute', completed_at = coalesce(completed_at, p_end)
       where id = p_item;
      alter table public.booking_request_items enable trigger booking_request_items_before_update;
    end $h$;
    -- A definer function that writes a staff release with a chosen released_by (identity mismatch).
    create function public.felyn_test_release_as(p_payment uuid, p_by uuid) returns void language plpgsql security definer
    set search_path = '' as $h$
    begin
      update public.booking_payments
         set host_transfer_status = 'released', transfer_release_kind = 'staff', transfer_released_by = p_by,
             transfer_release_note = 'impersonation test'
       where id = p_payment;
    end $h$;
    grant execute on function public.felyn_test_release_as(uuid, uuid) to authenticated;
    insert into public.staff_members (user_id, role) values (v_b, 'admin'), (v_a, 'support')
      on conflict (user_id) do update set role = excluded.role;
    for r in select unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) as k loop
      v_pay := v_pay || jsonb_build_object(r.k, public.felyn_test_paid((v_ids->>r.k)::uuid, r.k));
      perform public.felyn_test_end_at((v_ids->>r.k)::uuid, now() - interval '168 hours' - interval '1 minute');
    end loop;
    -- The guest's general account question: unrelated to bookings, so it never blocks.
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform public.support_open_thread('guest', 'account', 'How do I change my email address?', null);
    reset role;

    v_stage := 'R0 completed and still confirmed, whatever the date';
    -- Eight days past the scheduled end, but the completion job hasn't marked it completed.
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set completed_at = null where id = (v_ids->>'r5')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
       where id = (v_pay->>'r5')::uuid;
      raise exception 'R0 FAILED: released although the experience was never marked completed';
    exception when sqlstate 'FB007' then null;
    end;
    perform public.felyn_test_end_at((v_ids->>'r5')::uuid, now() - interval '168 hours' - interval '1 minute');
    -- Completed and past the review period, but the paid booking was cancelled since.
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_cancel_as_guest((v_ids->>'r5')::uuid, 'OTHER', '') then raise exception 'R0 SETUP: cannot cancel r5'; end if;
    reset role;
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
       where id = (v_pay->>'r5')::uuid;
      raise exception 'R0 FAILED: released although the booking was cancelled';
    exception when sqlstate 'FB007' then null;
    end;

    v_stage := 'R1 seven full days';
    perform public.felyn_test_end_at((v_ids->>'r1')::uuid, clock_timestamp() - interval '168 hours' + interval '1 second');
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
       where id = (v_pay->>'r1')::uuid;
      raise exception 'R1 FAILED: released 1 second before seven full days had passed';
    exception when sqlstate 'FB007' then null;
    end;
    perform public.felyn_test_end_at((v_ids->>'r1')::uuid, clock_timestamp() - interval '168 hours');
    update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic',
           transfer_released_at = '2000-01-01'  -- ignored: the database stamps the time
     where id = (v_pay->>'r1')::uuid;
    select count(*) into n from public.booking_payments
     where id = (v_pay->>'r1')::uuid and host_transfer_status = 'released' and transfer_release_kind = 'automatic'
       and transfer_released_at >= now() and transfer_released_by is null and transfer_release_note is null;
    if n <> 1 then raise exception 'R1 FAILED: the automatic release was not recorded with the database''s time'; end if;
    select count(*) into n from public.booking_payment_transfer_releases
     where booking_payment_id = (v_pay->>'r1')::uuid and release_kind = 'automatic' and released_by is null;
    if n <> 1 then raise exception 'R1 FAILED: the release was not audited'; end if;

    v_stage := 'R2 open linked case';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_t2 := public.support_open_thread('guest', 'experience', 'The chef arrived an hour late', (v_ids->>'r2')::uuid);
    reset role;
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
       where id = (v_pay->>'r2')::uuid;
      raise exception 'R2 FAILED: released automatically with an open support case on the booking';
    exception when sqlstate 'FB008' then null;
    end;

    v_stage := 'R3 the host''s unlinked payment case';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_t3 := public.support_open_thread('host', 'payment', 'When will I be paid?', null);
    reset role;
    begin
      update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
       where id = (v_pay->>'r3')::uuid;
      raise exception 'R3 FAILED: released automatically while the host has an open payment case';
    exception when sqlstate 'FB008' then null;
    end;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform public.support_staff_set_status(v_t3, 'RESOLVED');
    reset role;

    v_stage := 'R4 only an admin, with a note';
    for r in select * from (values ('support staff (not admin)', v_a), ('the guest (not staff)', v_g)) as t(label, uid) loop
      perform set_config('request.jwt.claim.sub', r.uid::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
      set local role authenticated;
      begin
        perform public.support_staff_release_host_transfer((v_pay->>'r2')::uuid, 'Looks fine');
        raise exception 'R4 FAILED: % released a host transfer', r.label;
      exception when insufficient_privilege then null;
      end;
      reset role;
    end loop;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.support_staff_release_host_transfer((v_pay->>'r2')::uuid, '   ');
      raise exception 'R4 FAILED: a staff release without a note';
    exception when sqlstate '22023' then null;
    end;
    v_stage := 'R5 no impersonation';
    reset role;
    -- Support staff (not admin), as themselves, past the staff function: the update guard refuses too.
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.felyn_test_release_as((v_pay->>'r2')::uuid, v_a);
      raise exception 'R5 FAILED: the update guard let non-admin staff release';
    exception when insufficient_privilege then null;
    end;
    reset role;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    -- The admin's session, but released_by names someone else.
    begin
      perform public.felyn_test_release_as((v_pay->>'r2')::uuid, v_a);
      raise exception 'R5 FAILED: a staff release recorded another person as the releaser';
    exception when insufficient_privilege then null;
    end;
    reset role;
    -- The owner's session (as a scheduled job runs) carrying the admin's identity.
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    begin
      update public.booking_payments
         set host_transfer_status = 'released', transfer_release_kind = 'staff', transfer_released_by = v_b, transfer_release_note = 'job'
       where id = (v_pay->>'r2')::uuid;
      raise exception 'R5 FAILED: an owner session released as staff';
    exception when insufficient_privilege then null;
    end;
    -- ...or claiming automatic while naming the admin.
    begin
      update public.booking_payments
         set host_transfer_status = 'released', transfer_release_kind = 'automatic', transfer_released_by = v_b
       where id = (v_pay->>'r2')::uuid;
      raise exception 'R5 FAILED: an automatic release named a staff member';
    exception when sqlstate 'FB008' or check_violation then null;
    end;

    v_stage := 'R6 the admin clears the case';
    set local role authenticated;
    if not public.support_staff_release_host_transfer((v_pay->>'r2')::uuid, '  Reviewed: chef was late, guest agreed to the full price.  ') then
      raise exception 'R6 FAILED: the admin could not release a reviewed case';
    end if;
    v_stage := 'R7 repeated calls';
    if public.support_staff_release_host_transfer((v_pay->>'r2')::uuid, 'Again') then
      raise exception 'R7 FAILED: a second staff release succeeded';
    end if;
    reset role;
    select count(*) into n from public.booking_payments
     where id = (v_pay->>'r2')::uuid and host_transfer_status = 'released' and transfer_release_kind = 'staff'
       and transfer_released_by = v_b and transfer_release_note = 'Reviewed: chef was late, guest agreed to the full price.';
    if n <> 1 then raise exception 'R6 FAILED: the staff release was not recorded with the admin and the note'; end if;
    select count(*) into n from public.booking_payment_transfer_releases
     where booking_payment_id = (v_pay->>'r2')::uuid and release_kind = 'staff' and released_by = v_b;
    if n <> 1 then raise exception 'R6/R7 FAILED: expected exactly one audited staff release, found %', n; end if;
    -- A repeated automatic release of r1 changes nothing and isn't audited twice.
    update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
     where id = (v_pay->>'r1')::uuid;
    select count(*) into n from public.booking_payment_transfer_releases where booking_payment_id = (v_pay->>'r1')::uuid;
    if n <> 1 then raise exception 'R7 FAILED: a repeated release was audited again'; end if;
    for r in select * from (values ('transfer_released_at', 'now()'), ('transfer_release_note', '''edited''')) as t(col, val) loop
      begin
        execute format('update public.booking_payments set %I = %s where id = $1', r.col, r.val) using (v_pay->>'r2')::uuid;
        raise exception 'R7 FAILED: % of a release was edited', r.col;
      exception when check_violation then null;
      end;
    end loop;

    v_stage := 'R8 refunds and disputes';
    begin
      update public.booking_payments set refunded_cents = 100 where id = (v_pay->>'r4')::uuid;
      raise exception 'R8 FAILED: a refund left the transfer pending';
    exception when check_violation then null;
    end;
    update public.booking_payments set refunded_cents = 100, host_transfer_status = 'blocked' where id = (v_pay->>'r4')::uuid;
    update public.booking_payments set dispute_id = 'dp_r5', disputed_at = now(), dispute_status = 'needs_response',
           host_transfer_status = 'blocked' where id = (v_pay->>'r5')::uuid;
    for r in select unnest(array['r4', 'r5']) as k loop
      begin
        update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
         where id = (v_pay->>r.k)::uuid;
        raise exception 'R8 FAILED: a blocked (% ) payment was released', r.k;
      exception when check_violation then null;
      end;
      begin
        update public.booking_payments set host_transfer_status = 'pending' where id = (v_pay->>r.k)::uuid;
        raise exception 'R8 FAILED: a refunded or disputed payment went back to pending (%)', r.k;
      exception when check_violation then null;
      end;
    end loop;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.support_staff_release_host_transfer((v_pay->>'r4')::uuid, 'Refunded partly, release the rest') then
      raise exception 'R8 FAILED: the admin released a refunded payment';
    end if;
    reset role;

    v_stage := 'R9 staff release, then the case changes';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_t6 := public.support_open_thread('guest', 'cancellation', 'Can I get a partial refund?', (v_ids->>'r6')::uuid);
    reset role;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.support_staff_release_host_transfer((v_pay->>'r6')::uuid, 'Guest withdrew the request') then
      raise exception 'R9 SETUP: the admin could not release r6';
    end if;
    perform public.support_staff_set_status(v_t6, 'RESOLVED');  -- staff resolving it afterwards doesn't block
    reset role;
    if public.booking_payment_transfer_blocker((v_pay->>'r6')::uuid) is not null then
      raise exception 'R9 FAILED: a case resolved after the staff release blocks the transfer (%)',
        public.booking_payment_transfer_blocker((v_pay->>'r6')::uuid);
    end if;
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform public.support_send_message(v_t6, 'Actually, I still want a refund.');  -- reopens it
    reset role;
    if public.booking_payment_transfer_blocker((v_pay->>'r6')::uuid) is distinct from 'support_case' then
      raise exception 'R9 FAILED: blocker is %, expected support_case', public.booking_payment_transfer_blocker((v_pay->>'r6')::uuid);
    end if;
    begin
      update public.booking_payments set host_transfer_status = 'transferred', stripe_transfer_id = 'tr_r6', transferred_at = now()
       where id = (v_pay->>'r6')::uuid;
      raise exception 'R9 FAILED: transferred although the case was reopened after the staff release';
    exception when sqlstate 'FB008' then null;
    end;
    -- r2's case is still open, but unchanged since the admin reviewed it: transferable.
    update public.booking_payments set host_transfer_status = 'transferred', stripe_transfer_id = 'tr_r2', transferred_at = now()
     where id = (v_pay->>'r2')::uuid;

    v_stage := 'R10 automatic release, then a case opens';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_t1 := public.support_open_thread('guest', 'experience', 'Something went wrong', (v_ids->>'r1')::uuid);
    reset role;
    begin
      update public.booking_payments set host_transfer_status = 'transferred', stripe_transfer_id = 'tr_r1', transferred_at = now()
       where id = (v_pay->>'r1')::uuid;
      raise exception 'R10 FAILED: transferred while a case is open';
    exception when sqlstate 'FB008' then null;
    end;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform public.support_staff_set_status(v_t1, 'RESOLVED');
    reset role;
    update public.booking_payments set host_transfer_status = 'transferred', stripe_transfer_id = 'tr_r1', transferred_at = now()
     where id = (v_pay->>'r1')::uuid;

    v_stage := 'R11 blocked, then released again';
    update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
     where id = (v_pay->>'r3')::uuid;  -- the host's case is resolved now
    update public.booking_payments set host_transfer_status = 'blocked' where id = (v_pay->>'r3')::uuid;
    begin
      update public.booking_payments set host_transfer_status = 'pending' where id = (v_pay->>'r3')::uuid;
      raise exception 'R11 FAILED: back to pending with the old release still recorded';
    exception when check_violation then null;
    end;
    update public.booking_payments set host_transfer_status = 'pending', transfer_released_at = null, transfer_release_kind = null
     where id = (v_pay->>'r3')::uuid;
    update public.booking_payments set host_transfer_status = 'released', transfer_release_kind = 'automatic'
     where id = (v_pay->>'r3')::uuid;
    select count(*) into n from public.booking_payment_transfer_releases where booking_payment_id = (v_pay->>'r3')::uuid;
    if n <> 2 then raise exception 'R11 FAILED: expected two audited releases of r3, found %', n; end if;
    begin
      update public.booking_payments set host_transfer_status = 'blocked' where id = (v_pay->>'r2')::uuid;
      update public.booking_payments set host_transfer_status = 'pending', transfer_released_at = null, transfer_release_kind = null,
             transfer_released_by = null, transfer_release_note = null where id = (v_pay->>'r2')::uuid;
      raise exception 'R11 FAILED: a transferred payment went back to pending';
    exception when check_violation then null;
    end;

    v_stage := 'R12 the audit record is append-only';
    begin
      update public.booking_payment_transfer_releases set release_note = 'edited' where booking_payment_id = (v_pay->>'r2')::uuid;
      raise exception 'R12 FAILED: an audited release was edited';
    exception when check_violation then null;
    end;
    begin
      delete from public.booking_payment_transfer_releases where booking_payment_id = (v_pay->>'r2')::uuid;
      raise exception 'R12 FAILED: an audited release was deleted';
    exception when check_violation then null;
    end;
    begin
      truncate public.booking_payment_transfer_releases;
      raise exception 'R12 FAILED: the release record was truncated';
    exception when check_violation then null;
    end;

    -- ═════════ 10. STRIPE EVENTS (E1-E6) ═════════
    v_stage := 'E1 one row per event';
    insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256, booking_payment_id)
    values ('evt_1', 'checkout.session.completed', false, now() - interval '5 seconds', repeat('a', 64), (v_pay->>'p1')::uuid);
    begin
      insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256)
      values ('evt_1', 'checkout.session.completed', false, now() - interval '5 seconds', repeat('a', 64));
      raise exception 'E1 FAILED: the same event id was stored twice';
    exception when unique_violation then null;
    end;
    -- A redelivery, as a later stage will record it: counted, never duplicated.
    insert into public.stripe_events as se (event_id, event_type, livemode, stripe_created_at, payload_sha256)
    values ('evt_1', 'checkout.session.completed', false, now() - interval '5 seconds', repeat('a', 64))
    on conflict (event_id) do update set delivery_count = se.delivery_count + 1, last_received_at = now()
      where se.payload_sha256 = excluded.payload_sha256
    returning se.delivery_count into n;
    if n <> 2 or (select count(*) from public.stripe_events where event_id = 'evt_1') <> 1 then
      raise exception 'E1 FAILED: the redelivery was not counted on the one row';
    end if;
    v_stage := 'E2 identity fixed';
    begin
      update public.stripe_events set payload_sha256 = repeat('b', 64) where event_id = 'evt_1';
      raise exception 'E2 FAILED: an event''s payload hash changed';
    exception when check_violation then null;
    end;
    begin
      update public.stripe_events set event_type = 'charge.refunded' where event_id = 'evt_1';
      raise exception 'E2 FAILED: an event''s type changed';
    exception when check_violation then null;
    end;
    begin
      update public.stripe_events set booking_payment_id = (v_pay->>'p3')::uuid where event_id = 'evt_1';
      raise exception 'E2 FAILED: an event''s payment changed';
    exception when check_violation then null;
    end;
    v_stage := 'E3 processed is final';
    update public.stripe_events set processing_status = 'processed', processed_at = now(), outcome = 'payment_authorized' where event_id = 'evt_1';
    begin
      update public.stripe_events set processing_status = 'failed', processed_at = null, last_error = 'x' where event_id = 'evt_1';
      raise exception 'E3 FAILED: a processed event was reopened';
    exception when check_violation then null;
    end;
    update public.stripe_events set delivery_count = 3, last_received_at = now() where event_id = 'evt_1';  -- a late redelivery is still counted
    v_stage := 'E4 failed then retried';
    insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256, connected_account_id)
    values ('evt_2', 'account.updated', false, now(), repeat('c', 64), 'acct_TestHostA');
    update public.stripe_events set processing_status = 'failed', last_error = 'database unavailable' where event_id = 'evt_2';
    update public.stripe_events set processing_status = 'processed', processed_at = now(), outcome = 'account_synced' where event_id = 'evt_2';
    v_stage := 'E5 shapes';
    for r in select * from (values
      ('bad id', 'evt-1', 'checkout.session.completed', repeat('a', 64)),
      ('bad type', 'evt_3', 'Checkout Completed', repeat('a', 64)),
      ('bad hash', 'evt_4', 'checkout.session.completed', 'not-a-hash')
    ) as t(label, eid, etype, hash) loop
      begin
        insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256)
        values (r.eid, r.etype, false, now(), r.hash);
        raise exception 'E5 FAILED: % was accepted', r.label;
      exception when check_violation then null;
      end;
    end loop;
    v_stage := 'E6 processed needs a time';
    begin
      insert into public.stripe_events (event_id, event_type, livemode, stripe_created_at, payload_sha256, processing_status)
      values ('evt_5', 'checkout.session.expired', false, now(), repeat('d', 64), 'processed');
      raise exception 'E6 FAILED: processed without processed_at';
    exception when check_violation then null;
    end;

    -- ═════════ 11. COMPATIBILITY (C3, C5, C6) ═════════
    v_stage := 'C3 messaging while awaiting payment';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'p3')::uuid, v_g, 'Paying now');
    v_stage := 'C6 direct client writes still refused';
    begin
      update public.booking_request_items set status = 'CONFIRMED' where id = (v_ids->>'p3')::uuid;
      raise exception 'C6 FAILED: a guest updated a booking item directly';
    exception when insufficient_privilege then null;
    end;
    v_stage := 'C5 deletion with payment records';
    if not public.booking_item_cancel_as_guest((v_ids->>'p1')::uuid, 'OTHER', '') then raise exception 'C5 SETUP: cannot cancel p1'; end if;
    if public.booking_request_is_deletable(v_req_p1) then
      raise exception 'C5 FAILED: a request whose only booking was paid and cancelled is deletable';
    end if;
    reset role;
    select count(*) into n from public.booking_request_items where booking_request_id = v_req_p1 and status <> 'CANCELLED';
    if n <> 0 then raise exception 'C5 SETUP: p1''s request has other items'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
