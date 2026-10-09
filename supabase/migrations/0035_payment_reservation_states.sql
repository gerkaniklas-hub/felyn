-- 0035: payment reservation states — AWAITING_PAYMENT, PAYMENT_EXPIRED, payment_due_at
--
-- ONE SQL statement (a single DO block), same form as 0023-0034: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- RELEASE NOTE: there is no way to pay until the Stripe phase ships. Apply this only
-- together with that phase — once applied, every accepted booking expires at its
-- payment deadline unless it is paid.
--
-- Why: once a host accepts, the host's time is reserved until the guest pays or the
-- payment deadline passes. Acceptance no longer means "confirmed":
--     REQUESTED --host accepts--> AWAITING_PAYMENT --payment (Stripe phase)--> CONFIRMED
--     AWAITING_PAYMENT --deadline passes--> PAYMENT_EXPIRED
--
-- What it does, on public.booking_request_items:
--   * status may also be AWAITING_PAYMENT or PAYMENT_EXPIRED (nothing else changes);
--   * payment_due_at timestamptz, set only when a host accepts:
--       least(accepted_at + 24 hours, confirmed_start_at - 2 hours)
--     — plain timestamp arithmetic on the 0033 snapshot (no time-zone conversion);
--     constraints: it exists only with a snapshot, and every AWAITING_PAYMENT or
--     PAYMENT_EXPIRED item has one; the snapshot constraint now also allows the two
--     new states;
--   * the update guard (0034's, every rule kept) now allows exactly:
--       REQUESTED -> AWAITING_PAYMENT | DECLINED | WITHDRAWN
--       AWAITING_PAYMENT -> CONFIRMED          (payment: owner only, before the deadline)
--       AWAITING_PAYMENT -> PAYMENT_EXPIRED    (expiry: owner only, once payment_due_at has passed)
--       CONFIRMED -> CANCELLED
--     REQUESTED -> CONFIRMED is no longer possible; on acceptance the guard also
--     requires payment_due_at to equal the formula above; payment_due_at can never be
--     written at any other moment. Payment is refused unless the session is the
--     table's owner (so never a client or service_role session) and refused once
--     payment_due_at <= now() — also when the expiry job hasn't run yet — and it takes
--     the host's lock, like acceptance. Expiry is likewise refused unless the session
--     is the table's owner (expire_due_booking_payments and acceptance's release of
--     lapsed reservations run as the owner), and before payment_due_at;
--   * public.booking_item_mark_paid(item): the payment step's state transition only
--     (no payment is recorded here — that is the Stripe phase). Owner-only. Under the
--     host lock: AWAITING_PAYMENT -> CONFIRMED before the deadline; at or after it,
--     refused (SQLSTATE FB002, nothing changed);
--   * booking_item_confirm (signature, grants and authorization unchanged) sets
--     AWAITING_PAYMENT with the snapshot and payment_due_at. Under the host lock it
--     first releases this host's lapsed reservations, then checks overlaps. It refuses
--     (SQLSTATE FB001, nothing changed) an acceptance that would leave the guest less
--     than 30 minutes to pay — a request starting in under about 2.5 hours;
--   * overlap protection (0034): AWAITING_PAYMENT now reserves the host's time too
--     (with CONFIRMED); PAYMENT_EXPIRED, like REQUESTED/DECLINED/WITHDRAWN/CANCELLED,
--     does not;
--   * public.expire_due_booking_payments(): the expiry authority — every
--     AWAITING_PAYMENT item whose payment_due_at has passed becomes PAYMENT_EXPIRED,
--     host by host under that host's lock (a host that is accepting at that moment is
--     skipped: its acceptance releases its own lapsed reservations, and the next run
--     catches the rest). Idempotent; never touches anything else. Callable only by its
--     owner — scheduled by booking_payment_expiry_schedule.sql (pg_cron, every minute);
--   * request totals and stay deletion count AWAITING_PAYMENT as active; deletion also
--     keeps PAYMENT_EXPIRED as history (like DECLINED);
--   * messaging: guest and host can message during AWAITING_PAYMENT; after
--     PAYMENT_EXPIRED they have the same 30-day reply window as after DECLINED or
--     CANCELLED, anchored to payment_due_at. Every other policy clause is unchanged;
--   * notifications: acceptance (REQUESTED -> AWAITING_PAYMENT) sends the guest an
--     in-app "Your request was accepted" notice (type booking_item_accepted, with the
--     payment deadline in Tenerife time) and the existing request_confirmed_guest email
--     (whose copy the app now words as "accepted — payment needed"). Payment
--     (AWAITING_PAYMENT -> CONFIRMED) keeps the existing in-app "Your experience is
--     confirmed" notice (booking_item_confirmed); no email is sent on payment or expiry.
--
-- Not changed: cancellation (still only CONFIRMED -> CANCELLED: an AWAITING_PAYMENT
-- booking can't be cancelled or withdrawn — it is paid or expires), completion,
-- support, the email outbox table and sender, grants, RLS on the booking tables.
-- Existing rows are not touched: no payment_due_at backfill, no status change.
--
-- Run as role `postgres` (the owner of booking_request_items), the whole file, in one
-- run, after 0034.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if (select array_agg(lit order by lit)
        from (select distinct (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g'))[1] as lit
                from pg_constraint c
               where c.conrelid = 'public.booking_request_items'::regclass
                 and c.conname = 'booking_request_items_status_check') s)
     is distinct from array['CANCELLED', 'CONFIRMED', 'DECLINED', 'REQUESTED', 'WITHDRAWN'] then
    raise exception '0035 ABORTED: booking_request_items_status_check is not the five pre-payment states';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'booking_request_items' and column_name = 'payment_due_at') then
    raise exception '0035 ABORTED: payment_due_at already exists';
  end if;
  -- Payment is reserved for the table's owner, and booking_item_mark_paid runs as the
  -- role that creates it: both must be the same role.
  if (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.booking_request_items'::regclass)
     is distinct from (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '0035 ABORTED: run this as the owner of public.booking_request_items (postgres)';
  end if;
  if to_regprocedure('public.booking_host_lock(uuid)') is null
     or position('public.booking_host_lock(v_provider)' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('AWAITING_PAYMENT' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) > 0
     or position('public.booking_host_overlap_exists(' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('AWAITING_PAYMENT' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) > 0 then
    raise exception '0035 ABORTED: booking_item_confirm or the update guard is not 0034''s version';
  end if;
  for r in select unnest(array[
             'public.booking_host_try_lock(uuid)', 'public.booking_expire_host_payments(uuid)',
             'public.expire_due_booking_payments()', 'public.booking_item_mark_paid(uuid)']) as fn loop
    if to_regprocedure(r.fn) is not null then
      raise exception '0035 ABORTED: % already exists', r.fn;
    end if;
  end loop;
  for r in select unnest(array[
             'public.booking_request_items_sync_total()', 'public.booking_request_is_deletable(uuid)',
             'public.notify_guest_on_item_status_change()', 'public.email_outbox_on_item_status_change()',
             'public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)']) as fn loop
    if to_regprocedure(r.fn) is null then
      raise exception '0035 ABORTED: % is missing', r.fn;
    end if;
  end loop;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'messages' and cmd = 'INSERT'
        and policyname in ('Guests send messages on their own active items',
                           'Providers send messages on their own active items')) <> 2 then
    raise exception '0035 ABORTED: the two 0021 message INSERT policies are not in place';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select array_agg(lit order by lit)
        from (select distinct (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g'))[1] as lit
                from pg_constraint c
               where c.conrelid = 'public.booking_request_items'::regclass
                 and c.conname = 'booking_request_items_status_check') s)
     is distinct from array['AWAITING_PAYMENT', 'CANCELLED', 'CONFIRMED', 'DECLINED', 'PAYMENT_EXPIRED', 'REQUESTED', 'WITHDRAWN'] then
    raise exception '0035 VERIFY FAILED: the status constraint is not the seven states';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'booking_request_items' and column_name = 'payment_due_at'
                 and data_type = 'timestamp with time zone' and is_nullable = 'YES')
     or has_column_privilege('authenticated', 'public.booking_request_items', 'payment_due_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.booking_request_items', 'payment_due_at', 'UPDATE')
     or has_column_privilege('anon', 'public.booking_request_items', 'payment_due_at', 'SELECT') then
    raise exception '0035 VERIFY FAILED: payment_due_at is missing or writable by a client';
  end if;
  if exists (select 1 from public.booking_request_items where payment_due_at is not null)
     or to_regclass('public.booking_request_items_payment_due_idx') is null
     or (select count(*) from pg_constraint where conrelid = 'public.booking_request_items'::regclass
         and conname in ('booking_request_items_acceptance_status_check', 'booking_request_items_payment_due_check')) <> 2 then
    raise exception '0035 VERIFY FAILED: payment_due_at constraints, index or existing rows are not as intended';
  end if;
  for r in select unnest(array['public.booking_host_try_lock(uuid)', 'public.booking_expire_host_payments(uuid)',
                               'public.expire_due_booking_payments()', 'public.booking_host_lock(uuid)',
                               'public.booking_item_mark_paid(uuid)',
                               'public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)']) as fn loop
    if has_function_privilege('anon', r.fn, 'EXECUTE') or has_function_privilege('authenticated', r.fn, 'EXECUTE')
       or has_function_privilege('service_role', r.fn, 'EXECUTE') then
      raise exception '0035 VERIFY FAILED: % is callable by a client role', r.fn;
    end if;
  end loop;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.expire_due_booking_payments()'::regprocedure)
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_mark_paid(uuid)'::regprocedure)
     or (select p.proowner from pg_proc p where p.oid = 'public.booking_item_mark_paid(uuid)'::regprocedure)
        is distinct from (select c.relowner from pg_class c where c.oid = 'public.booking_request_items'::regclass)
     or position('Only the payment step can confirm a booking' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('Only payment expiry can expire a booking' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.booking_item_confirm(uuid)', 'EXECUTE')
     or position('''AWAITING_PAYMENT''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('''AWAITING_PAYMENT''' in
                 (select p.prosrc from pg_proc p
                   where p.oid = 'public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)'::regprocedure)) = 0
     or position('v_paying or v_expiring or v_cancelling' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('booking_item_accepted' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.notify_guest_on_item_status_change()'::regprocedure)) = 0
     or position('new.status = ''AWAITING_PAYMENT''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.email_outbox_on_item_status_change()'::regprocedure)) = 0 then
    raise exception '0035 VERIFY FAILED: a replaced function is not the 0035 version';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'messages' and cmd = 'INSERT'
        and policyname in ('Guests send messages on their own active items',
                           'Providers send messages on their own active items')
        and with_check like '%PAYMENT_EXPIRED%' and with_check like '%AWAITING_PAYMENT%'
        and with_check not like '%WITHDRAWN%') <> 2 then
    raise exception '0035 VERIFY FAILED: the message INSERT policies are not the 0035 version';
  end if;
end
$migration$;
