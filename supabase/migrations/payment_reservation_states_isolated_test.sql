-- NOT A MIGRATION. Fail-closed isolated test for 0035_payment_reservation_states.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0035's schema, functions and policies, and every
-- test row, notification and email-outbox row), releases every lock, and leaves
-- the session idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0035 and AFTER 0034 (it applies 0035's body itself, then throws it
-- away; once 0035 is applied it fails at the first statement and should not be
-- re-run). It expects 0028 (email outbox) to be applied, as in production.
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- now() is fixed for a whole transaction, so two things are simulated: bookings that
-- start soon (inserted relative to now(), past the 0032 rule on purpose) and the
-- passing of a payment deadline (payment_due_at moved back, past the guard on purpose).
-- Everything else runs through the real functions as signed-in users. Concurrent
-- acceptance/expiry is tested separately with real parallel connections.
--
-- It needs three accounts in auth.users (A, B = hosts, G = guest).
--
-- What it checks (numbers follow the Phase 5 test list):
--   transitions   1 REQUESTED -> AWAITING_PAYMENT on acceptance   2 decline still works
--                 3 no client can confirm an AWAITING_PAYMENT item  4 only the owner path
--                 can (the future payment step)  5 expiry only via the deadline / expiry
--                 6-7 PAYMENT_EXPIRED can never become CONFIRMED, AWAITING_PAYMENT or
--                 REQUESTED; REQUESTED -> CONFIRMED is gone; AWAITING_PAYMENT -> REQUESTED refused
--   snapshot      8-13 accepted_at, confirmed_start_at, duration_minutes, payment_due_at
--                 all set together; a refused acceptance leaves all four NULL
--   deadline      14 accepted + 24 h when earlier   15 start - 2 h when earlier
--                 16 a timestamptz   17 late acceptance: under 30 minutes to pay is refused
--                 (FB001), exactly 30 minutes is accepted, a past start is refused
--   overlap       18 AWAITING_PAYMENT blocks  19 CONFIRMED blocks  20 PAYMENT_EXPIRED releases
--                 (also lazily, inside acceptance)  21-24 REQUESTED, DECLINED, WITHDRAWN,
--                 CANCELLED don't block  25 back-to-back AWAITING_PAYMENT is fine
--   expiry        27 due -> PAYMENT_EXPIRED  28 future unchanged  29 CONFIRMED unchanged
--                 30 re-running is a no-op  31 releases the interval  32 several at once
--                 (two hosts)  33 nothing unrelated changes
--   security      34-38 clients can't write payment_due_at or the new states, can't call
--                 the expiry/lock/payment helpers; guards hold even for postgres
--   payment       39 service_role can't confirm an AWAITING_PAYMENT item directly, nor
--                 call booking_item_mark_paid  40 the owner's booking_item_mark_paid
--                 confirms it before the deadline (snapshot kept, "confirmed" notice)
--                 41 at exactly the deadline it is refused (FB002), and so is a direct
--                 UPDATE even as postgres  42 after the deadline, before the expiry job
--                 ran: refused  43 after expiry: refused, stays PAYMENT_EXPIRED
--                 44 not awaiting payment (REQUESTED, already paid, unknown): false
--                 45 service_role can't expire a due booking directly (only the owner's
--                 expire_due_booking_payments can, check 27; early expiry: checks 5, 28)
--   also          messaging open during AWAITING_PAYMENT, 30-day window after expiry,
--                 closed after it and for WITHDRAWN; the guest's acceptance notice and
--                 email; request totals; legacy CONFIRMED rows; stay deletion

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid; v_b_provider uuid;
  v_e60 uuid; v_e120 uuid; v_eb uuid;
  v_req uuid; v_legacy_req uuid; v_legacy uuid;
  v_ids jsonb := '{}'::jsonb;
  v_id uuid;
  v_total_before numeric; v_total_after numeric;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, EXPERIENCES AND A LEGACY ROW (before 0035) ═════════
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
      values (v_a, 'PAYMENT TEST HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'PAYMENT TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'PAYMENT TEST 60 (rolled back)', 'food', 30, 1, 6, 60, true) returning id into v_e60;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'PAYMENT TEST 120 (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_e120;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_b_provider, 'PAYMENT TEST HOST B (rolled back)', 'drink', 40, 1, 6, 120, true) returning id into v_eb;
    insert into public.experience_availability (experience_id, available_from, available_until)
    select id, '2026-01-01', '2030-12-31' from public.experiences where id in (v_e60, v_e120, v_eb);

    -- A booking confirmed before 0035 (and before 0033): CONFIRMED, no snapshot, no deadline.
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_legacy_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_legacy_req, v_e120, '2027-09-01', 'evening', 2, '19:00') returning id into v_legacy;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_legacy;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;

    -- ═════════ 1. 0035 BODY (verbatim from 0035_payment_reservation_states.sql, section 2) ═════════
    v_stage := 'migration';
    -- ── states and the payment deadline ──
    alter table public.booking_request_items drop constraint booking_request_items_status_check;
    alter table public.booking_request_items add constraint booking_request_items_status_check
      check (status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'CANCELLED', 'PAYMENT_EXPIRED'));
    -- Nullable, no default: metadata-only; every existing row is NULL.
    alter table public.booking_request_items add column payment_due_at timestamptz;
    alter table public.booking_request_items drop constraint booking_request_items_acceptance_status_check;
    alter table public.booking_request_items
      add constraint booking_request_items_acceptance_status_check
        check (accepted_at is null or status in ('AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'PAYMENT_EXPIRED')),
      add constraint booking_request_items_payment_due_check
        check ((payment_due_at is null or accepted_at is not null)
               and (status not in ('AWAITING_PAYMENT', 'PAYMENT_EXPIRED') or payment_due_at is not null));
    -- Expiry looks only at items awaiting payment, by deadline.
    create index booking_request_items_payment_due_idx
      on public.booking_request_items (payment_due_at)
      where status = 'AWAITING_PAYMENT';

    -- ── host locking and reservations (0034) ──
    create function public.booking_host_try_lock(p_provider_id uuid)
    returns boolean language sql volatile set search_path = '' as $fn$
      -- The same per-host key as booking_host_lock, without waiting.
      select pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('felyn.booking_host_acceptance:' || p_provider_id::text, 0))
    $fn$;

    create or replace function public.booking_host_overlap_exists(
      p_provider_id uuid, p_item_id uuid, p_start timestamptz, p_end timestamptz
    ) returns boolean language sql volatile set search_path = '' as $fn$
      select exists (
        select 1
          from public.booking_request_items o
          join public.experiences e on e.id = o.experience_id
         where e.provider_id = p_provider_id
           and o.id <> p_item_id
           and o.status in ('AWAITING_PAYMENT', 'CONFIRMED')   -- statuses that reserve the host's time
           and o.confirmed_start_at is not null     -- accepted before 0033: interval unknown, never blocks
           and o.confirmed_start_at < p_end
           and o.confirmed_start_at + o.duration_minutes * interval '1 minute' > p_start)
    $fn$;

    -- Releases a host's reservations whose payment deadline has passed. The caller must
    -- hold that host's lock (booking_host_lock / booking_host_try_lock).
    create function public.booking_expire_host_payments(p_provider_id uuid)
    returns integer language sql volatile set search_path = '' as $fn$
      with expired as (
        update public.booking_request_items bri
           set status = 'PAYMENT_EXPIRED'
          from public.experiences e
         where e.id = bri.experience_id
           and e.provider_id = p_provider_id
           and bri.status = 'AWAITING_PAYMENT'
           and bri.payment_due_at <= now()
        returning bri.id
      )
      select count(*)::integer from expired
    $fn$;

    create function public.expire_due_booking_payments()
    returns integer language plpgsql security definer set search_path = '' as $fn$
    declare
      v_provider uuid;
      v_expired integer := 0;
    begin
      for v_provider in
        select distinct e.provider_id
          from public.booking_request_items bri
          join public.experiences e on e.id = bri.experience_id
         where bri.status = 'AWAITING_PAYMENT'
           and bri.payment_due_at <= now()
      loop
        -- A host that is accepting right now holds its lock: that acceptance releases the
        -- host's lapsed reservations itself, and the next run catches anything left.
        if public.booking_host_try_lock(v_provider) then
          v_expired := v_expired + public.booking_expire_host_payments(v_provider);
        end if;
      end loop;
      return v_expired;
    end $fn$;

    -- ── the update guard (0034's, every rule kept) ──
    create or replace function public.booking_request_items_before_update()
    returns trigger language plpgsql set search_path = '' as $fn$
    declare
      v_declining boolean := old.status = 'REQUESTED' and new.status = 'DECLINED';
      v_cancelling boolean := old.status = 'CONFIRMED' and new.status = 'CANCELLED';
      v_accepting boolean := old.status = 'REQUESTED' and new.status = 'AWAITING_PAYMENT';
      v_paying boolean := old.status = 'AWAITING_PAYMENT' and new.status = 'CONFIRMED';
      v_expiring boolean := old.status = 'AWAITING_PAYMENT' and new.status = 'PAYMENT_EXPIRED';
      v_provider uuid;
    begin
      if new.id is distinct from old.id
         or new.booking_request_id is distinct from old.booking_request_id
         or new.experience_id is distinct from old.experience_id
         or new.planned_date is distinct from old.planned_date
         or new.planned_moment is distinct from old.planned_moment
         or new.guest_count is distinct from old.guest_count
         or new.price_per_person is distinct from old.price_per_person
         or new.preferred_time is distinct from old.preferred_time
         or new.host_note is distinct from old.host_note
         or new.created_at is distinct from old.created_at then
        raise exception 'A booking item''s booking details cannot change' using errcode = '23514';
      end if;
      if new.status is distinct from old.status
         and not ((old.status = 'REQUESTED' and new.status in ('AWAITING_PAYMENT', 'DECLINED', 'WITHDRAWN'))
                  or v_paying or v_expiring or v_cancelling) then
        raise exception 'Booking item status cannot change from % to %', old.status, new.status using errcode = '23514';
      end if;
      if not v_declining
         and (new.decided_at is distinct from old.decided_at
              or new.decline_reason is distinct from old.decline_reason
              or new.decline_note is distinct from old.decline_note) then
        raise exception 'Decline details can only be written when an item is declined' using errcode = '23514';
      end if;
      if not v_cancelling
         and (new.cancelled_at is distinct from old.cancelled_at
              or new.cancelled_by is distinct from old.cancelled_by
              or new.cancellation_reason is distinct from old.cancellation_reason
              or new.cancellation_note is distinct from old.cancellation_note) then
        raise exception 'Cancellation details can only be written when an item is cancelled' using errcode = '23514';
      end if;
      if new.completed_at is distinct from old.completed_at
         and not (old.completed_at is null and old.status = 'CONFIRMED' and new.status = 'CONFIRMED') then
        raise exception 'completed_at can only be set once, on a CONFIRMED item' using errcode = '23514';
      end if;
      -- 0035: payment is the owner's alone (booking_item_mark_paid runs as the owner; no
      -- client or service_role session), only before the payment deadline — even if the
      -- expiry job hasn't run yet — and under the host's lock, like acceptance.
      if v_paying then
        if (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user)
           is distinct from (select c.relowner from pg_catalog.pg_class c where c.oid = tg_relid) then
          raise exception 'Only the payment step can confirm a booking' using errcode = '42501';
        end if;
        if old.payment_due_at is null or old.payment_due_at <= now() then
          raise exception 'The payment deadline for this booking has passed' using errcode = '23514';
        end if;
        select e.provider_id into v_provider from public.experiences e where e.id = new.experience_id;
        perform public.booking_host_lock(v_provider);
      end if;
      -- 0035: a reservation expires only through the owner's expiry
      -- (expire_due_booking_payments, or an acceptance releasing the host's lapsed
      -- reservations — both run as the owner; never a client or service_role session),
      -- and only once its payment deadline has passed.
      if v_expiring then
        if (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user)
           is distinct from (select c.relowner from pg_catalog.pg_class c where c.oid = tg_relid) then
          raise exception 'Only payment expiry can expire a booking' using errcode = '42501';
        end if;
        if old.payment_due_at > now() then
          raise exception 'A payment can only expire after its deadline' using errcode = '23514';
        end if;
      end if;
      -- 0035: the payment deadline is written exactly once, on acceptance (checked below).
      if not v_accepting and new.payment_due_at is distinct from old.payment_due_at then
        raise exception 'The payment deadline can only be set when a request is accepted' using errcode = '23514';
      end if;
      -- 0033: the acceptance snapshot is written exactly once, when the host accepts, and
      -- must then be complete: the acceptance time, a positive duration, and the requested
      -- Tenerife start as a real instant. It never changes afterwards.
      if v_accepting then
        if new.accepted_at is null or new.duration_minutes is null or new.duration_minutes <= 0
           or new.preferred_time is null
           or new.confirmed_start_at is distinct from
              ((new.planned_date + new.preferred_time) at time zone 'Atlantic/Canary') then
          raise exception 'An accepted booking needs accepted_at, a positive duration_minutes and its requested start as confirmed_start_at'
            using errcode = '23514';
        end if;
        -- 0035: the payment deadline is the earlier of 24 hours after acceptance and
        -- 2 hours before the start.
        if new.payment_due_at is distinct from
           least(new.accepted_at + interval '24 hours', new.confirmed_start_at - interval '2 hours') then
          raise exception 'An accepted booking needs payment_due_at = least(accepted_at + 24 hours, confirmed_start_at - 2 hours)'
            using errcode = '23514';
        end if;
        -- 0034: under the host's acceptance lock (taken again here, so every route to
        -- CONFIRMED is serialized and checked), the new interval may not overlap another
        -- booking that reserves this host's time.
        select e.provider_id into v_provider from public.experiences e where e.id = new.experience_id;
        perform public.booking_host_lock(v_provider);
        if public.booking_host_overlap_exists(v_provider, new.id, new.confirmed_start_at,
             new.confirmed_start_at + new.duration_minutes * interval '1 minute') then
          raise exception 'This experience overlaps another confirmed booking' using errcode = '23P01';
        end if;
      elsif new.accepted_at is distinct from old.accepted_at
            or new.confirmed_start_at is distinct from old.confirmed_start_at
            or new.duration_minutes is distinct from old.duration_minutes then
        raise exception 'The acceptance snapshot can only be written when a request is accepted' using errcode = '23514';
      end if;
      return new;
    end $fn$;

    -- ── host acceptance (0034's, now -> AWAITING_PAYMENT with a payment deadline) ──
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
      select bri.id, bri.planned_date, bri.preferred_time, e.duration_minutes into v_item
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
      v_start := (v_item.planned_date + v_item.preferred_time) at time zone 'Atlantic/Canary';
      -- 0035: the guest pays by the earlier of 24 hours from now and 2 hours before the
      -- start, and must get at least 30 minutes to do so.
      v_due := least(now() + interval '24 hours', v_start - interval '2 hours');
      if v_due < now() + interval '30 minutes' then
        raise exception 'This request starts too soon to accept: the guest would have less than 30 minutes to pay'
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

    -- ── payment: the state transition only (the Stripe phase records the payment and calls this) ──
    -- AWAITING_PAYMENT -> CONFIRMED under the host's lock, so it never interleaves with an
    -- acceptance or with expiry. At or after the deadline it is refused (FB002), whether or
    -- not the reservation has been expired yet. Anything else (unknown item, not awaiting
    -- payment, already paid) changes nothing and returns false.
    create function public.booking_item_mark_paid(p_item_id uuid)
    returns boolean language plpgsql security definer set search_path = '' as $fn$
    declare
      v_provider uuid;
      v_item record;
    begin
      select e.provider_id into v_provider
        from public.booking_request_items bri
        join public.experiences e on e.id = bri.experience_id
       where bri.id = p_item_id;
      if not found then
        return false;
      end if;
      perform public.booking_host_lock(v_provider);
      -- Re-read and lock the item now that this host is serialized: an expiry or another
      -- payment may have finished while this one waited.
      select bri.status, bri.payment_due_at into v_item
        from public.booking_request_items bri
       where bri.id = p_item_id
         for update;
      if v_item.status = 'PAYMENT_EXPIRED'
         or (v_item.status = 'AWAITING_PAYMENT' and v_item.payment_due_at <= now()) then
        raise exception 'The payment deadline for this booking has passed' using errcode = 'FB002';
      end if;
      if v_item.status is distinct from 'AWAITING_PAYMENT' then
        return false;
      end if;
      update public.booking_request_items bri
         set status = 'CONFIRMED'
       where bri.id = p_item_id
         and bri.status = 'AWAITING_PAYMENT';
      return found;
    end $fn$;

    -- ── request totals and stay deletion (0031) ──
    create or replace function public.booking_request_items_sync_total()
    returns trigger language plpgsql security definer set search_path = '' as $fn$
    begin
      update public.booking_requests br
         set estimated_total = coalesce((select sum(bri.price_per_person * bri.guest_count)
                                           from public.booking_request_items bri
                                          where bri.booking_request_id = br.id
                                            and bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED')), 0)
       where br.id = new.booking_request_id;
      return null;
    end $fn$;

    create or replace function public.booking_request_is_deletable(p_request_id uuid)
    returns boolean language sql stable security definer set search_path = '' as $fn$
      select exists (select 1 from public.booking_requests br
                      where br.id = p_request_id and br.user_id = auth.uid())
         and not exists (select 1 from public.booking_request_items bri
                          where bri.booking_request_id = p_request_id
                            and bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED', 'DECLINED', 'PAYMENT_EXPIRED'))
    $fn$;

    -- ── messaging (0021's policies; only the status condition gains the two states) ──
    drop policy "Guests send messages on their own active items" on public.messages;
    create policy "Guests send messages on their own active items" on public.messages
      for insert to authenticated with check (
        sender_id = auth.uid()
        and exists (
          select 1 from public.booking_request_items bri
          join public.booking_requests br on br.id = bri.booking_request_id
          where bri.id = messages.booking_request_item_id
            and br.user_id = auth.uid()
            and (
              bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED')
              or (bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days')
              or (bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days')
              or (bri.status = 'PAYMENT_EXPIRED' and bri.payment_due_at is not null and now() <= bri.payment_due_at + interval '30 days')
            )
        )
      );
    drop policy "Providers send messages on their own active items" on public.messages;
    create policy "Providers send messages on their own active items" on public.messages
      for insert to authenticated with check (
        sender_id = auth.uid()
        and exists (
          select 1 from public.booking_request_items bri
          join public.experiences e on e.id = bri.experience_id
          join public.providers p on p.id = e.provider_id
          where bri.id = messages.booking_request_item_id
            and p.user_id = auth.uid()
            and (
              bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED')
              or (bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days')
              or (bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days')
              or (bri.status = 'PAYMENT_EXPIRED' and bri.payment_due_at is not null and now() <= bri.payment_due_at + interval '30 days')
            )
        )
      );

    -- ── the guest's in-app notice (0009's trigger function) ──
    create or replace function public.notify_guest_on_item_status_change()
    returns trigger
    language plpgsql
    security definer
    set search_path = public
    as $fn$
    declare
      guest_user_id uuid;
      experience_title text;
      provider_display_name text;
      moment_word text;
    begin
      if new.status = old.status or new.status not in ('AWAITING_PAYMENT', 'CONFIRMED', 'DECLINED') then
        return new;
      end if;

      select br.user_id into guest_user_id
      from public.booking_requests br
      where br.id = new.booking_request_id;

      select e.title, p.display_name into experience_title, provider_display_name
      from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = new.experience_id;

      moment_word := lower(new.planned_moment);

      insert into public.notifications (user_id, type, title, body, booking_request_item_id)
      values (
        guest_user_id,
        case new.status when 'AWAITING_PAYMENT' then 'booking_item_accepted'
                        when 'CONFIRMED' then 'booking_item_confirmed'
                        else 'booking_item_declined' end,
        case new.status when 'AWAITING_PAYMENT' then 'Your request was accepted'
                        when 'CONFIRMED' then 'Your experience is confirmed'
                        else 'An experience couldn''t be confirmed' end,
        case
          when new.status = 'AWAITING_PAYMENT' then
            coalesce(provider_display_name, 'Your host') || ' accepted your ' || coalesce(experience_title, 'experience')
              || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word
              || '. It isn''t confirmed until you pay — payment is due by '
              || to_char(new.payment_due_at at time zone 'Atlantic/Canary', 'FMDay HH24:MI') || ' (Tenerife time).'
          when new.status = 'CONFIRMED' then
            coalesce(provider_display_name, 'Your host') || ' has confirmed your ' || coalesce(experience_title, 'experience')
              || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '.'
          else
            coalesce(provider_display_name, 'Your host') || ' couldn''t confirm your ' || coalesce(experience_title, 'experience')
              || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '. You can request another experience for that slot.'
        end,
        new.id
      );

      return new;
    end;
    $fn$;

    -- ── the acceptance email (0028's trigger function: acceptance is now -> AWAITING_PAYMENT) ──
    create or replace function public.email_outbox_on_item_status_change()
    returns trigger language plpgsql security definer set search_path = '' as $fn$
    declare
      v_guest uuid;
      v_host uuid;
      v_reason jsonb;
    begin
      if not ((old.status = 'REQUESTED' and new.status in ('AWAITING_PAYMENT', 'DECLINED'))
              or (old.status = 'CONFIRMED' and new.status = 'CANCELLED' and new.cancelled_by in ('guest', 'provider'))) then
        return null;
      end if;
      begin
        select br.user_id into v_guest from public.booking_requests br where br.id = new.booking_request_id;
        if new.status = 'AWAITING_PAYMENT' then
          perform public.email_outbox_enqueue('request_confirmed_guest', 'guest', v_guest, new.booking_request_id, array[new.id]);
        elsif new.status = 'DECLINED' then
          perform public.email_outbox_enqueue('request_declined_guest', 'guest', v_guest, new.booking_request_id, array[new.id]);
        else
          v_reason := jsonb_strip_nulls(jsonb_build_object('cancellation_reason', new.cancellation_reason));
          select p.user_id into v_host
          from public.experiences e join public.providers p on p.id = e.provider_id
          where e.id = new.experience_id;
          if new.cancelled_by = 'guest' then
            perform public.email_outbox_enqueue('booking_cancelled_by_guest_host', 'host', v_host, new.booking_request_id, array[new.id], v_reason);
            perform public.email_outbox_enqueue('booking_cancelled_by_guest_guest', 'guest', v_guest, new.booking_request_id, array[new.id], v_reason);
          else
            perform public.email_outbox_enqueue('booking_cancelled_by_host_guest', 'guest', v_guest, new.booking_request_id, array[new.id], v_reason);
            perform public.email_outbox_enqueue('booking_cancelled_by_host_host', 'host', v_host, new.booking_request_id, array[new.id], v_reason);
          end if;
        end if;
      exception when others then
        raise warning 'email_outbox: status-change event not recorded (SQLSTATE %): %', sqlstate, sqlerrm;
      end;
      return null;
    end
    $fn$;

    -- ── function privileges: the new functions are for their owner (and the scheduler) only ──
    revoke execute on function public.booking_host_try_lock(uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.booking_expire_host_payments(uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.expire_due_booking_payments() from public, anon, authenticated, service_role;
    revoke execute on function public.booking_item_mark_paid(uuid) from public, anon, authenticated, service_role;

    -- ═════════ 2. SETUP: GUEST G REQUESTS ═════════
    v_stage := 'setup';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;
    for r in select * from (values
      ('s1', 'A120', '2027-05-05', '19:00'),   -- standard acceptance, 19:00-21:00
      ('same', 'A120', '2027-05-05', '19:00'),  -- overlaps s1
      ('part', 'A60', '2027-05-05', '20:30'),   -- overlaps s1
      ('next', 'A60', '2027-05-05', '21:00'),   -- back-to-back after s1
      ('req', 'A120', '2027-05-06', '19:00'),   -- stays REQUESTED
      ('dec', 'A120', '2027-05-06', '19:00'),   -- declined
      ('wd', 'A120', '2027-05-06', '19:00'),    -- withdrawn
      ('can', 'A120', '2027-05-06', '19:00'),   -- accepted, paid, cancelled
      ('exp', 'A120', '2027-05-06', '19:00'),   -- accepted, then expired
      ('d2', 'A120', '2027-05-06', '19:00'),    -- must be accepted over all of the above
      ('paid', 'A120', '2027-05-07', '19:00'),  -- accepted and paid (CONFIRMED)
      ('paid2', 'A60', '2027-05-07', '19:30'),  -- overlaps the CONFIRMED one
      ('e1', 'A60', '2027-05-10', '17:00'),     -- expiry batch (host A)
      ('e2', 'A60', '2027-05-10', '19:00'),     -- expiry batch (host A)
      ('e3', 'B120', '2027-05-10', '17:00'),    -- expiry batch (host B)
      ('e4', 'A60', '2027-05-10', '17:00'),     -- takes e1's released slot
      ('lz', 'A120', '2027-05-11', '19:00'),    -- lapsed reservation...
      ('lz2', 'A120', '2027-05-11', '19:00'),   -- ...released inside this acceptance
      ('pay1', 'A120', '2027-05-12', '19:00'),  -- paid before its deadline
      ('pay2', 'A120', '2027-05-13', '19:00')   -- payment at / after its deadline
    ) as t(k, exp, d, tm) loop
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, case r.exp when 'A60' then v_e60 when 'A120' then v_e120 else v_eb end, r.d::date, 'evening', 2, r.tm::time)
      returning id into v_id;
      v_ids := v_ids || jsonb_build_object(r.k, v_id);
    end loop;
    if not public.booking_item_withdraw((v_ids->>'wd')::uuid) then raise exception 'SETUP: G cannot withdraw'; end if;
    reset role;
    -- Starts relative to now() (past the 0032 four-hour rule on purpose); none overlap
    -- another of the same host, so only the deadline rule decides.
    for r in select * from (values
      ('soon5', interval '5 hours', 'A'),               -- deadline = start - 2 h (check 15)
      ('late215', interval '2 hours 15 minutes', 'B'),  -- 15 minutes to pay: refused (17)
      ('late230', interval '2 hours 30 minutes', 'A'),  -- exactly 30 minutes to pay: accepted (17)
      ('past', interval '-1 hour', 'A')                 -- already started: refused (17)
    ) as t(k, ahead, host) loop
      alter table public.booking_request_items disable trigger booking_request_items_before_insert;
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time)
      values (v_req, case r.host when 'A' then v_e60 else v_eb end, ((now() + r.ahead) at time zone 'Atlantic/Canary')::date, 'evening', 2, 30,
              ((now() + r.ahead) at time zone 'Atlantic/Canary')::time)
      returning id into v_id;
      alter table public.booking_request_items enable trigger booking_request_items_before_insert;
      v_ids := v_ids || jsonb_build_object(r.k, v_id);
    end loop;

    -- ═════════ 3. ACCEPTANCE, DEADLINES, LATE ACCEPTANCE (checks 1, 8-17) ═════════
    v_stage := '1/14 acceptance';
    select br.estimated_total into v_total_before from public.booking_requests br where br.id = v_req;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'s1')::uuid) then raise exception '1 FAILED: host A cannot accept s1'; end if;
    if not public.booking_item_confirm((v_ids->>'soon5')::uuid) then raise exception '15 FAILED: cannot accept a start 5 hours away'; end if;
    if not public.booking_item_confirm((v_ids->>'late230')::uuid) then
      raise exception '17 FAILED: exactly 30 minutes to pay was refused';
    end if;
    begin
      perform public.booking_item_confirm((v_ids->>'past')::uuid);
      raise exception '17 FAILED: a start in the past was accepted';
    exception when sqlstate 'FB001' then null;
    end;
    reset role;
    -- late215 belongs to host B.
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_item_confirm((v_ids->>'late215')::uuid);
      raise exception '17 FAILED: an acceptance leaving 15 minutes to pay was accepted';
    exception when sqlstate 'FB001' then null;
    end;
    reset role;

    v_stage := '8-16 snapshot and deadline';
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'s1')::uuid and status = 'AWAITING_PAYMENT'
       and accepted_at = now() and confirmed_start_at = ('2027-05-05'::date + '19:00'::time) at time zone 'Atlantic/Canary'
       and duration_minutes = 120 and payment_due_at = now() + interval '24 hours'
       and pg_typeof(payment_due_at) = 'timestamp with time zone'::regtype;
    if n <> 1 then raise exception '1/8-14/16 FAILED: s1 is not AWAITING_PAYMENT with the full snapshot and a 24-hour deadline'; end if;
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'soon5')::uuid and status = 'AWAITING_PAYMENT'
       and payment_due_at = confirmed_start_at - interval '2 hours' and payment_due_at < now() + interval '24 hours';
    if n <> 1 then raise exception '15 FAILED: a start 5 hours away is not due 2 hours before it'; end if;
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'late230')::uuid and status = 'AWAITING_PAYMENT' and payment_due_at = now() + interval '30 minutes';
    if n <> 1 then raise exception '17 FAILED: the 30-minute acceptance has the wrong deadline'; end if;
    select count(*) into n from public.booking_request_items
     where id in ((v_ids->>'late215')::uuid, (v_ids->>'past')::uuid) and status = 'REQUESTED'
       and accepted_at is null and confirmed_start_at is null and duration_minutes is null and payment_due_at is null;
    if n <> 2 then raise exception '13/17 FAILED: a refused late acceptance changed the item'; end if;
    select br.estimated_total into v_total_after from public.booking_requests br where br.id = v_req;
    if v_total_after <> v_total_before then raise exception 'totals FAILED: accepting changed estimated_total'; end if;

    v_stage := 'notice and email';
    select count(*) into n from public.notifications
     where booking_request_item_id = (v_ids->>'s1')::uuid and user_id = v_g and type = 'booking_item_accepted'
       and body like '%isn''t confirmed until you pay%' and body like '%(Tenerife time).';
    if n <> 1 then raise exception 'notice FAILED: no "request accepted" notice for the guest'; end if;
    if exists (select 1 from public.notifications where booking_request_item_id = (v_ids->>'s1')::uuid and type = 'booking_item_confirmed') then
      raise exception 'notice FAILED: acceptance told the guest the booking is confirmed';
    end if;
    select count(*) into n from public.email_outbox
     where event_type = 'request_confirmed_guest' and (v_ids->>'s1')::uuid = any (booking_request_item_ids);
    if n <> 1 then raise exception 'email FAILED: acceptance did not queue the acceptance email'; end if;

    -- ═════════ 4. OVERLAPS (checks 18-25) ═════════
    v_stage := '18/25 AWAITING_PAYMENT blocks';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    for r in select unnest(array['same', 'part']) as k loop
      begin
        perform public.booking_item_confirm((v_ids->>r.k)::uuid);
        raise exception '18 FAILED: % overlapping an AWAITING_PAYMENT booking was accepted', r.k;
      exception when exclusion_violation then null;
      end;
    end loop;
    if not public.booking_item_confirm((v_ids->>'next')::uuid) then
      raise exception '25 FAILED: a back-to-back acceptance after an AWAITING_PAYMENT booking was refused';
    end if;
    -- 2027-05-06: declined, withdrawn, cancelled (after payment) and expired at 19:00 — then d2.
    if not public.booking_item_decline((v_ids->>'dec')::uuid, 'other', null) then raise exception '2 FAILED: decline'; end if;
    if not public.booking_item_confirm((v_ids->>'can')::uuid) then raise exception 'SETUP: accept can'; end if;
    reset role;
    -- The payment step (owner-only): AWAITING_PAYMENT -> CONFIRMED (check 4).
    if not public.booking_item_mark_paid((v_ids->>'can')::uuid) then raise exception '4 FAILED: the owner cannot mark can as paid'; end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_cancel_as_host((v_ids->>'can')::uuid, 'OTHER', null) then raise exception 'SETUP: cancel'; end if;
    if not public.booking_item_confirm((v_ids->>'exp')::uuid) then raise exception 'SETUP: accept exp'; end if;
    reset role;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '1 minute' where id = (v_ids->>'exp')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    if public.expire_due_booking_payments() < 1 then raise exception 'SETUP: expiry did not run'; end if;
    v_stage := '20-24 non-blocking statuses';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'d2')::uuid) then
      raise exception '20-24 FAILED: a REQUESTED, DECLINED, WITHDRAWN, CANCELLED or PAYMENT_EXPIRED booking blocked an acceptance';
    end if;
    v_stage := '19 CONFIRMED blocks';
    if not public.booking_item_confirm((v_ids->>'paid')::uuid) then raise exception 'SETUP: accept paid'; end if;
    reset role;
    if not public.booking_item_mark_paid((v_ids->>'paid')::uuid) then raise exception '4 FAILED: the owner cannot mark paid as paid'; end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_item_confirm((v_ids->>'paid2')::uuid);
      raise exception '19 FAILED: a booking overlapping a CONFIRMED one was accepted';
    exception when exclusion_violation then null;
    end;
    reset role;
    select count(*) into n from public.booking_request_items
     where id in ((v_ids->>'same')::uuid, (v_ids->>'part')::uuid, (v_ids->>'paid2')::uuid) and status = 'REQUESTED'
       and accepted_at is null and payment_due_at is null;
    if n <> 3 then raise exception '13 FAILED: a refused overlapping acceptance changed the item'; end if;

    -- ═════════ 5. EXPIRY (checks 27-33) ═════════
    v_stage := '27-33 expiry';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'e1')::uuid) or not public.booking_item_confirm((v_ids->>'e2')::uuid) then
      raise exception 'SETUP: accept e1/e2';
    end if;
    begin
      perform public.booking_item_confirm((v_ids->>'e4')::uuid);
      raise exception '31 FAILED: e4 was accepted while e1 still held the slot';
    exception when exclusion_violation then null;
    end;
    reset role;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'e3')::uuid) then raise exception 'SETUP: accept e3'; end if;
    reset role;
    -- Too early: expiry changes nothing yet, and the guard refuses an early expiry even for postgres.
    if public.expire_due_booking_payments() <> 0 then raise exception '28 FAILED: expiry touched a reservation before its deadline'; end if;
    begin
      update public.booking_request_items set status = 'PAYMENT_EXPIRED' where id = (v_ids->>'e1')::uuid;
      raise exception '5 FAILED: a reservation was expired before its deadline';
    exception when check_violation then null;
    end;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '1 minute'
     where id in ((v_ids->>'e1')::uuid, (v_ids->>'e2')::uuid, (v_ids->>'e3')::uuid);
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    -- e1 is now due: still, service_role can't expire it directly (check 45).
    v_stage := '45 service_role expiry';
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    set local role service_role;
    begin
      update public.booking_request_items set status = 'PAYMENT_EXPIRED' where id = (v_ids->>'e1')::uuid;
      raise exception '45 FAILED: service_role expired a due booking directly';
    exception when insufficient_privilege then
      if sqlerrm <> 'Only payment expiry can expire a booking' then
        raise exception '45 FAILED: service_role was refused for another reason: %', sqlerrm;
      end if;
    end;
    reset role;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'e1')::uuid and status = 'AWAITING_PAYMENT';
    if n <> 1 then raise exception '45 FAILED: e1 is no longer AWAITING_PAYMENT'; end if;
    v_stage := '27-33 expiry';
    create temporary table phase5_before on commit drop as
      select id, status, payment_due_at from public.booking_request_items
       where id not in ((v_ids->>'e1')::uuid, (v_ids->>'e2')::uuid, (v_ids->>'e3')::uuid);
    n := public.expire_due_booking_payments();
    if n <> 3 then raise exception '27/32 FAILED: expiry changed % reservations instead of 3 (two hosts)', n; end if;
    select count(*) into n from public.booking_request_items
     where id in ((v_ids->>'e1')::uuid, (v_ids->>'e2')::uuid, (v_ids->>'e3')::uuid) and status = 'PAYMENT_EXPIRED'
       and accepted_at is not null and payment_due_at is not null;
    if n <> 3 then raise exception '27 FAILED: the due reservations are not PAYMENT_EXPIRED with their snapshot kept'; end if;
    select count(*) into n from phase5_before b join public.booking_request_items bri on bri.id = b.id
     where bri.status is distinct from b.status or bri.payment_due_at is distinct from b.payment_due_at;
    if n <> 0 then raise exception '28/29/33 FAILED: expiry changed % unrelated item(s)', n; end if;
    if public.expire_due_booking_payments() <> 0 then raise exception '30 FAILED: a second expiry run changed something'; end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'e4')::uuid) then raise exception '31 FAILED: the expired slot was not released'; end if;
    -- A lapsed reservation is released inside the acceptance itself (check 20), without the job.
    if not public.booking_item_confirm((v_ids->>'lz')::uuid) then raise exception 'SETUP: accept lz'; end if;
    reset role;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '1 minute' where id = (v_ids->>'lz')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'lz2')::uuid) then raise exception '20 FAILED: a lapsed reservation blocked an acceptance'; end if;
    reset role;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'lz')::uuid and status = 'PAYMENT_EXPIRED';
    if n <> 1 then raise exception '20 FAILED: the lapsed reservation was not expired by the acceptance'; end if;

    -- ═════════ 5b. PAYMENT (checks 39-44) ═════════
    v_stage := '39 service_role';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm((v_ids->>'pay1')::uuid) or not public.booking_item_confirm((v_ids->>'pay2')::uuid) then
      raise exception 'SETUP: accept pay1/pay2';
    end if;
    reset role;
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    set local role service_role;
    begin
      update public.booking_request_items set status = 'CONFIRMED' where id = (v_ids->>'pay1')::uuid;
      raise exception '39 FAILED: service_role confirmed an AWAITING_PAYMENT item directly';
    exception when insufficient_privilege then
      -- Refused by the payment rule itself, not merely by a missing privilege on the way.
      if sqlerrm <> 'Only the payment step can confirm a booking' then
        raise exception '39 FAILED: service_role was refused for another reason: %', sqlerrm;
      end if;
    end;
    begin
      perform public.booking_item_mark_paid((v_ids->>'pay1')::uuid);
      raise exception '39 FAILED: service_role can call booking_item_mark_paid';
    exception when insufficient_privilege then null;
    end;
    reset role;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'pay1')::uuid and status = 'AWAITING_PAYMENT';
    if n <> 1 then raise exception '39 FAILED: pay1 is no longer AWAITING_PAYMENT'; end if;

    v_stage := '40 payment before the deadline';
    create temporary table phase5_pay1 on commit drop as
      select accepted_at, confirmed_start_at, duration_minutes, payment_due_at
        from public.booking_request_items where id = (v_ids->>'pay1')::uuid;
    if not public.booking_item_mark_paid((v_ids->>'pay1')::uuid) then raise exception '40 FAILED: payment before the deadline was refused'; end if;
    select count(*) into n from public.booking_request_items bri, phase5_pay1 b
     where bri.id = (v_ids->>'pay1')::uuid and bri.status = 'CONFIRMED'
       and (bri.accepted_at, bri.confirmed_start_at, bri.duration_minutes, bri.payment_due_at)
           = (b.accepted_at, b.confirmed_start_at, b.duration_minutes, b.payment_due_at);
    if n <> 1 then raise exception '40 FAILED: pay1 is not CONFIRMED with its snapshot and deadline unchanged'; end if;
    select count(*) into n from public.notifications
     where booking_request_item_id = (v_ids->>'pay1')::uuid and user_id = v_g and type = 'booking_item_confirmed';
    if n <> 1 then raise exception '40 FAILED: payment did not send the guest the "confirmed" notice'; end if;

    v_stage := '41 payment at the deadline';
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() where id = (v_ids->>'pay2')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    begin
      perform public.booking_item_mark_paid((v_ids->>'pay2')::uuid);
      raise exception '41 FAILED: payment at exactly the deadline was accepted';
    exception when sqlstate 'FB002' then null;
    end;
    begin
      update public.booking_request_items set status = 'CONFIRMED' where id = (v_ids->>'pay2')::uuid;
      raise exception '41 FAILED: a direct UPDATE (as postgres) confirmed a booking at its deadline';
    exception when check_violation then null;
    end;
    v_stage := '42 payment after the deadline, before expiry';
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '1 minute' where id = (v_ids->>'pay2')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    begin
      perform public.booking_item_mark_paid((v_ids->>'pay2')::uuid);
      raise exception '42 FAILED: payment after the deadline was accepted before the expiry job ran';
    exception when sqlstate 'FB002' then null;
    end;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'pay2')::uuid and status = 'AWAITING_PAYMENT';
    if n <> 1 then raise exception '41/42 FAILED: a refused payment changed pay2'; end if;
    v_stage := '43 payment after expiry';
    if public.expire_due_booking_payments() < 1 then raise exception 'SETUP: expiry did not expire pay2'; end if;
    begin
      perform public.booking_item_mark_paid((v_ids->>'pay2')::uuid);
      raise exception '43 FAILED: an expired booking was paid';
    exception when sqlstate 'FB002' then null;
    end;
    select count(*) into n from public.booking_request_items where id = (v_ids->>'pay2')::uuid and status = 'PAYMENT_EXPIRED';
    if n <> 1 then raise exception '43 FAILED: pay2 is not PAYMENT_EXPIRED'; end if;
    v_stage := '44 nothing to pay';
    if public.booking_item_mark_paid((v_ids->>'req')::uuid) then raise exception '44 FAILED: a REQUESTED item was marked paid'; end if;
    if public.booking_item_mark_paid((v_ids->>'pay1')::uuid) then raise exception '44 FAILED: a paid item was marked paid twice'; end if;
    if public.booking_item_mark_paid(gen_random_uuid()) then raise exception '44 FAILED: an unknown item was marked paid'; end if;
    select count(*) into n from public.booking_request_items
     where id = (v_ids->>'req')::uuid and status = 'REQUESTED' and accepted_at is null;
    if n <> 1 then raise exception '44 FAILED: marking a REQUESTED item paid changed it'; end if;

    -- ═════════ 6. STATE-MACHINE GUARD, AS POSTGRES (checks 3-7) ═════════
    v_stage := '3-7 guard';
    for r in select * from (values
      ('update public.booking_request_items set status = ''REQUESTED'' where id = $1', 's1', 'AWAITING_PAYMENT -> REQUESTED'),
      ('update public.booking_request_items set status = ''CONFIRMED'' where id = $1', 'e1', 'PAYMENT_EXPIRED -> CONFIRMED'),
      ('update public.booking_request_items set status = ''AWAITING_PAYMENT'' where id = $1', 'e1', 'PAYMENT_EXPIRED -> AWAITING_PAYMENT'),
      ('update public.booking_request_items set status = ''REQUESTED'' where id = $1', 'e1', 'PAYMENT_EXPIRED -> REQUESTED'),
      ('update public.booking_request_items set status = ''CANCELLED'', cancelled_at = now(), cancelled_by = ''guest'', cancellation_reason = ''OTHER'' where id = $1', 's1', 'AWAITING_PAYMENT -> CANCELLED'),
      ('update public.booking_request_items set payment_due_at = payment_due_at + interval ''1 day'' where id = $1', 's1', 'moving a payment deadline'),
      ('update public.booking_request_items set status = ''CONFIRMED'', accepted_at = now(), duration_minutes = 120, confirmed_start_at = (planned_date + preferred_time) at time zone ''Atlantic/Canary'' where id = $1', 'req', 'REQUESTED -> CONFIRMED (the old acceptance)'),
      ('update public.booking_request_items set status = ''AWAITING_PAYMENT'', accepted_at = now(), duration_minutes = 120, confirmed_start_at = (planned_date + preferred_time) at time zone ''Atlantic/Canary'', payment_due_at = now() + interval ''7 days'' where id = $1', 'req', 'accepting with a wrong deadline')
    ) as t(stmt, k, what) loop
      begin
        execute r.stmt using (v_ids->>r.k)::uuid;
        raise exception '3-7 FAILED: the guard allowed % (as postgres)', r.what;
      exception when check_violation then null;
      end;
    end loop;
    begin
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, payment_due_at)
      values (v_req, v_e60, '2027-10-01', 'evening', 2, '19:00', now());
      raise exception '34 FAILED: a REQUESTED item was created with a payment deadline (as postgres)';
    exception when check_violation then null;
    end;

    v_stage := '34-38 clients';
    for r in select * from (values (v_g, 'G'), (v_a, 'host A')) as t(uid, who) loop
      perform set_config('request.jwt.claim.sub', r.uid::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
      set local role authenticated;
      for n in 1..6 loop
        begin
          case n
            when 1 then update public.booking_request_items set payment_due_at = now() where id = (v_ids->>'s1')::uuid;
            when 2 then update public.booking_request_items set status = 'CONFIRMED' where id = (v_ids->>'s1')::uuid;
            when 3 then update public.booking_request_items set status = 'PAYMENT_EXPIRED' where id = (v_ids->>'s1')::uuid;
            when 4 then update public.booking_request_items set status = 'AWAITING_PAYMENT' where id = (v_ids->>'req')::uuid;
            when 5 then perform public.booking_item_mark_paid((v_ids->>'s1')::uuid);
            else perform public.expire_due_booking_payments();
          end case;
          raise exception '34-38 FAILED: % could run client write #%', r.who, n;
        exception when insufficient_privilege then null;
        end;
      end loop;
      begin
        perform public.booking_expire_host_payments(v_a_provider);
        raise exception '38 FAILED: % can call booking_expire_host_payments', r.who;
      exception when insufficient_privilege then null;
      end;
      reset role;
    end loop;

    -- ═════════ 7. MESSAGING, TOTALS, LEGACY, DELETION ═════════
    v_stage := 'messaging';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'s1')::uuid, v_g, 'Looking forward!');
    insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'e1')::uuid, v_g, 'Sorry I missed it');
    begin
      insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'wd')::uuid, v_g, 'hello?');
      raise exception 'messaging FAILED: G messaged on a WITHDRAWN item';
    exception when insufficient_privilege then null;
    end;
    reset role;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set payment_due_at = now() - interval '31 days' where id = (v_ids->>'e2')::uuid;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'s1')::uuid, v_a, 'See you then');
    begin
      insert into public.messages (booking_request_item_id, sender_id, body) values ((v_ids->>'e2')::uuid, v_a, 'too late');
      raise exception 'messaging FAILED: the host messaged 31 days after a payment expired';
    exception when insufficient_privilege then null;
    end;
    reset role;

    v_stage := 'totals, legacy, deletion';
    select count(*) into n from public.booking_requests br
     where br.id = v_req
       and br.estimated_total = (select sum(bri.price_per_person * bri.guest_count) from public.booking_request_items bri
                                  where bri.booking_request_id = v_req and bri.status in ('REQUESTED', 'AWAITING_PAYMENT', 'CONFIRMED'));
    if n <> 1 then raise exception 'totals FAILED: estimated_total does not count REQUESTED + AWAITING_PAYMENT + CONFIRMED'; end if;
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_cancel_as_guest(v_legacy, 'OTHER', '') then raise exception 'legacy FAILED: a legacy CONFIRMED booking cannot be cancelled'; end if;
    if public.booking_request_is_deletable(v_req) then raise exception 'deletion FAILED: a request with active or expired bookings is deletable'; end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = v_legacy and status = 'CANCELLED' and payment_due_at is null and accepted_at is null;
    if n <> 1 then raise exception 'legacy FAILED: the legacy booking was given a snapshot or deadline'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
