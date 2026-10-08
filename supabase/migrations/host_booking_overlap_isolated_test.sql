-- NOT A MIGRATION. Fail-closed isolated test for 0034_host_booking_overlap.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0034's functions and index, and every test row),
-- releases every lock (including the advisory locks it takes), and leaves the
-- session idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0034 and AFTER 0033 (it applies 0034's body itself, then throws it
-- away; once 0034 is applied it fails at the first statement and should not be
-- re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- One session cannot run two transactions at once, so this file checks every overlap
-- rule and that the host lock is really taken; the concurrent-acceptance behaviour is
-- tested separately with real parallel connections (see the 0034 README entry).
--
-- It needs three existing accounts in auth.users (A and B = hosts, G = guest). Host
-- profiles, experiences, availability and bookings are created and rolled back. Guest
-- and host actions run as the `authenticated` role with that user's claims. Test dates
-- are in 2027, so the 0032 start rules accept them whenever this runs.
--
-- Host A has an accepted booking X on 2027-05-05, 19:00-21:00 Tenerife time. Then:
--   1  same interval 19:00-21:00 -> refused (23P01)
--   2  partial overlap at the start, 18:30-19:30 -> refused
--   3  partial overlap at the end, 20:59-21:59 -> refused
--   4  contained, 19:30-20:30 -> refused
--   5  containing, 18:00-22:00 -> refused
--   6  every refused item is still REQUESTED with no snapshot
--   7  back-to-back after, 21:00-22:00 -> accepted; before, 18:00-19:00 -> accepted
--   8  host B's booking at the same time as X -> accepted (another host)
--   9  on 2027-05-06 host A has, all at 19:00-21:00: a REQUESTED, a DECLINED, a
--      WITHDRAWN and a CANCELLED booking and a CONFIRMED one accepted before 0033
--      (no snapshot) — none of them blocks a new 19:00-21:00 acceptance
--  10  the guard's backstop: a direct UPDATE to CONFIRMED with a correct snapshot but
--      an overlap is refused too (even as postgres)
--  11  accepting takes a transaction-level advisory lock
--  12  the two helpers are not callable by signed-in users

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid; v_b_provider uuid;
  v_e60 uuid; v_e120 uuid; v_e240 uuid; v_eb uuid;
  v_req uuid; v_legacy_req uuid; v_legacy uuid;
  v_x uuid; v_same uuid; v_start_overlap uuid; v_end_overlap uuid; v_inside uuid; v_around uuid;
  v_after uuid; v_before uuid; v_other_host uuid;
  v_d2_requested uuid; v_d2_declined uuid; v_d2_withdrawn uuid; v_d2_cancelled uuid; v_d2_new uuid;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, HOSTS, EXPERIENCES AND A LEGACY ROW (before 0034) ═════════
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
      values (v_a, 'OVERLAP TEST HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'OVERLAP TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'OVERLAP TEST 60 (rolled back)', 'food', 30, 1, 6, 60, true) returning id into v_e60;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'OVERLAP TEST 120 (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_e120;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'OVERLAP TEST 240 (rolled back)', 'food', 50, 1, 6, 240, true) returning id into v_e240;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_b_provider, 'OVERLAP TEST HOST B 120 (rolled back)', 'drink', 40, 1, 6, 120, true) returning id into v_eb;
    insert into public.experience_availability (experience_id, available_from, available_until)
    select id, '2026-01-01', '2030-12-31' from public.experiences where id in (v_e60, v_e120, v_e240, v_eb);

    -- A booking accepted before 0033: CONFIRMED with no snapshot (the 0033 guard is paused for it).
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_legacy_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_legacy_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_legacy;
    alter table public.booking_request_items disable trigger booking_request_items_before_update;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_legacy;
    alter table public.booking_request_items enable trigger booking_request_items_before_update;

    -- ═════════ 1. 0034 BODY (verbatim from 0034_host_booking_overlap.sql, section 2) ═════════
    v_stage := 'migration';
    create function public.booking_host_lock(p_provider_id uuid)
    returns void language sql volatile set search_path = '' as $fn$
      -- One acceptance at a time per host, until this transaction ends.
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('felyn.booking_host_acceptance:' || p_provider_id::text, 0))
    $fn$;

    -- Volatile on purpose: called right after taking the host lock, it must see bookings
    -- that other transactions committed while this one was waiting for the lock.
    create function public.booking_host_overlap_exists(
      p_provider_id uuid, p_item_id uuid, p_start timestamptz, p_end timestamptz
    ) returns boolean language sql volatile set search_path = '' as $fn$
      select exists (
        select 1
          from public.booking_request_items o
          join public.experiences e on e.id = o.experience_id
         where e.provider_id = p_provider_id
           and o.id <> p_item_id
           and o.status in ('CONFIRMED')            -- statuses that reserve the host's time
           and o.confirmed_start_at is not null     -- accepted before 0033: interval unknown, never blocks
           and o.confirmed_start_at < p_end
           and o.confirmed_start_at + o.duration_minutes * interval '1 minute' > p_start)
    $fn$;

    create index booking_request_items_accepted_interval_idx
      on public.booking_request_items (experience_id, confirmed_start_at)
      where confirmed_start_at is not null;

    create or replace function public.booking_request_items_before_update()
    returns trigger language plpgsql set search_path = '' as $fn$
    declare
      v_declining boolean := old.status = 'REQUESTED' and new.status = 'DECLINED';
      v_cancelling boolean := old.status = 'CONFIRMED' and new.status = 'CANCELLED';
      v_accepting boolean := old.status = 'REQUESTED' and new.status = 'CONFIRMED';
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
         and not ((old.status = 'REQUESTED' and new.status in ('CONFIRMED', 'DECLINED', 'WITHDRAWN'))
                  or v_cancelling) then
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

    create or replace function public.booking_item_confirm(p_item_id uuid)
    returns boolean language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_provider uuid;
      v_item record;
      v_start timestamptz;
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
      if public.booking_host_overlap_exists(v_provider, v_item.id, v_start,
           v_start + v_item.duration_minutes * interval '1 minute') then
        raise exception 'This experience overlaps another confirmed booking' using errcode = '23P01';
      end if;
      update public.booking_request_items bri
         set status = 'CONFIRMED',
             accepted_at = now(),
             confirmed_start_at = v_start,
             duration_minutes = v_item.duration_minutes
       where bri.id = v_item.id
         and bri.status = 'REQUESTED';
      return found;
    end $fn$;

    revoke execute on function public.booking_host_lock(uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)
      from public, anon, authenticated, service_role;

    -- Existing overlaps among already accepted bookings are not touched — only reported.
    select count(*) into n
      from public.booking_request_items a
      join public.experiences ea on ea.id = a.experience_id
      join public.booking_request_items b on b.id > a.id
      join public.experiences eb on eb.id = b.experience_id and eb.provider_id = ea.provider_id
     where a.status = 'CONFIRMED' and b.status = 'CONFIRMED'
       and a.confirmed_start_at is not null and b.confirmed_start_at is not null
       and a.confirmed_start_at < b.confirmed_start_at + b.duration_minutes * interval '1 minute'
       and b.confirmed_start_at < a.confirmed_start_at + a.duration_minutes * interval '1 minute';
    raise notice '0034: % pair(s) of already accepted bookings overlap for the same host (left unchanged)', n;

    -- ═════════ 2. SETUP: GUEST G REQUESTS ═════════
    v_stage := 'setup';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time) values
      (v_req, v_e120, '2027-05-05', 'evening', 2, '19:00') returning id into v_x;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-05', 'evening', 2, '19:00') returning id into v_same;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e60, '2027-05-05', 'evening', 2, '18:30') returning id into v_start_overlap;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e60, '2027-05-05', 'evening', 2, '20:59') returning id into v_end_overlap;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e60, '2027-05-05', 'evening', 2, '19:30') returning id into v_inside;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e240, '2027-05-05', 'evening', 2, '18:00') returning id into v_around;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e60, '2027-05-05', 'evening', 2, '21:00') returning id into v_after;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e60, '2027-05-05', 'evening', 2, '18:00') returning id into v_before;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_eb, '2027-05-05', 'evening', 2, '19:00') returning id into v_other_host;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_d2_requested;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_d2_declined;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_d2_withdrawn;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_d2_cancelled;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
      values (v_req, v_e120, '2027-05-06', 'evening', 2, '19:00') returning id into v_d2_new;
    if not public.booking_item_withdraw(v_d2_withdrawn) then raise exception 'SETUP: G cannot withdraw'; end if;
    reset role;

    -- ═════════ 3. HOST A: THE EXISTING BOOKING AND THE REFUSED OVERLAPS (checks 1-6, 11) ═════════
    v_stage := '1-5 overlaps refused';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_x) then raise exception 'SETUP: host A cannot accept X (19:00-21:00)'; end if;
    for r in select * from (values
      (v_same, '1 the same interval 19:00-21:00'),
      (v_start_overlap, '2 a partial overlap at the start, 18:30-19:30'),
      (v_end_overlap, '3 a partial overlap at the end, 20:59-21:59'),
      (v_inside, '4 an interval inside X, 19:30-20:30'),
      (v_around, '5 an interval around X, 18:00-22:00')
    ) as t(id, what) loop
      begin
        perform public.booking_item_confirm(r.id);
        raise exception '% FAILED: it was accepted', r.what;
      exception when exclusion_violation then null;
      end;
    end loop;
    reset role;

    v_stage := '11 advisory lock';
    select count(*) into n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted;
    if n < 1 then raise exception '11 FAILED: accepting took no advisory lock'; end if;

    v_stage := '6 refused items unchanged';
    select count(*) into n from public.booking_request_items
     where id in (v_same, v_start_overlap, v_end_overlap, v_inside, v_around)
       and status = 'REQUESTED' and accepted_at is null and confirmed_start_at is null and duration_minutes is null;
    if n <> 5 then raise exception '6 FAILED: only % of 5 refused items are REQUESTED without a snapshot', n; end if;

    -- ═════════ 4. ALLOWED: BACK-TO-BACK, ANOTHER HOST, NON-BLOCKING STATUSES (checks 7-9) ═════════
    v_stage := '7 back-to-back';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_after) then raise exception '7 FAILED: 21:00-22:00 right after X was refused'; end if;
    if not public.booking_item_confirm(v_before) then raise exception '7 FAILED: 18:00-19:00 right before X was refused'; end if;

    v_stage := '9 non-blocking statuses';
    if not public.booking_item_decline(v_d2_declined, 'other', null) then raise exception 'SETUP: cannot decline'; end if;
    -- Accepting this one also proves the legacy CONFIRMED row (no snapshot) at the same time doesn't block.
    if not public.booking_item_confirm(v_d2_cancelled) then
      raise exception '9 FAILED: a CONFIRMED booking without a snapshot blocked an acceptance';
    end if;
    if not public.booking_item_cancel_as_host(v_d2_cancelled, 'OTHER', null) then raise exception 'SETUP: cannot cancel'; end if;
    if not public.booking_item_confirm(v_d2_new) then
      raise exception '9 FAILED: a REQUESTED, DECLINED, WITHDRAWN, CANCELLED or legacy booking blocked an acceptance';
    end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where (id = v_d2_requested and status = 'REQUESTED') or (id = v_d2_declined and status = 'DECLINED')
        or (id = v_d2_withdrawn and status = 'WITHDRAWN') or (id = v_d2_cancelled and status = 'CANCELLED')
        or (id = v_legacy and status = 'CONFIRMED' and confirmed_start_at is null)
        or (id = v_d2_new and status = 'CONFIRMED' and confirmed_start_at is not null);
    if n <> 6 then raise exception '9 FAILED: only % of the 6 same-time bookings are in the expected state', n; end if;

    v_stage := '8 another host';
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_other_host) then
      raise exception '8 FAILED: host A''s booking blocked host B';
    end if;
    begin
      perform public.booking_host_overlap_exists(v_a_provider, v_x, now(), now() + interval '1 hour');
      raise exception '12 FAILED: a signed-in user can call booking_host_overlap_exists';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.booking_host_lock(v_a_provider);
      raise exception '12 FAILED: a signed-in user can call booking_host_lock';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 5. THE GUARD'S BACKSTOP (check 10) ═════════
    v_stage := '10 backstop';
    begin
      update public.booking_request_items
         set status = 'CONFIRMED', accepted_at = now(), duration_minutes = 120,
             confirmed_start_at = (planned_date + preferred_time) at time zone 'Atlantic/Canary'
       where id = v_same;
      raise exception '10 FAILED: a direct UPDATE accepted an overlapping booking';
    exception when exclusion_violation then null;
    end;
    select count(*) into n from public.booking_request_items
     where id = v_same and status = 'REQUESTED' and accepted_at is null;
    if n <> 1 then raise exception '10 FAILED: the refused direct UPDATE changed the item'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
