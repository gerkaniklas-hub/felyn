-- NOT A MIGRATION. Fail-closed isolated test for 0033_accepted_start_snapshot.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0033's columns, constraints and functions, and
-- every test row), releases every lock, and leaves the session idle. There is
-- no code path that finishes normally.
--
-- Run it BEFORE 0033 and AFTER 0032 (it applies 0033's body itself, then throws it
-- away; once 0033 is applied it fails at the first statement and should not be
-- re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs three existing accounts in auth.users (A = host, B = another account,
-- G = guest). The host profile, experiences, availability and bookings it needs are
-- created and rolled back. Guest and host actions run as the `authenticated` role
-- with that user's claims, so row-level security and column privileges are
-- genuinely enforced. Test dates are in 2027, so the 0032 start rules accept them
-- whenever this runs.
--
-- What it checks:
--   1  a new REQUESTED item has accepted_at, confirmed_start_at, duration_minutes NULL
--   2  host acceptance: REQUESTED -> CONFIRMED and all three set (accepted_at = now())
--   3  summer: 2027-07-15 20:00 Tenerife -> 2027-07-15 19:00 UTC (WEST, UTC+1)
--   4  winter: 2027-01-15 19:00 Tenerife -> 2027-01-15 19:00 UTC (WET, UTC+0)
--   5  DST from the time-zone database: 08:00 on 2027-03-27 is 08:00 UTC, the next
--      day (after the 2027-03-28 switch) 07:00 UTC
--   6  confirmed_start_at shows the requested date and time in Tenerife
--   7  duration_minutes = the experience's duration at acceptance
--   8  editing the experience's duration afterwards does not change the booking
--   9  guest G cannot UPDATE any of the three fields
--  10  host A cannot UPDATE any of the three fields
--  11  nobody can set them when a request is created (G: no column privilege;
--      even postgres: a REQUESTED row may not carry them)
--  12  failed acceptance leaves them NULL and the item REQUESTED: another account,
--      an item without preferred_time (pre-0032 legacy), and direct writes that skip
--      or fake the snapshot (refused by the guard, even as postgres)
--  13  after acceptance the snapshot can never change (even as postgres), survives a
--      cancellation, and the request's estimated_total behaves as before
--  14  legacy CONFIRMED rows without the fields still cancel and complete
--  15  booking_item_confirm is executable by signed-in users only
--  16  observation: acceptance has no time limit — a request starting in 1 hour (or
--      already started) is still accepted, with the real accepted_at/confirmed_start_at

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid;
  v_exp uuid;
  v_req uuid;
  v_legacy_req uuid; v_legacy_confirmed uuid; v_legacy_untimed uuid; v_late uuid;
  v_summer uuid; v_winter uuid; v_dst_before uuid; v_dst_after uuid; v_other uuid; v_cancel uuid;
  v_total_before numeric; v_total_after numeric;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, EXPERIENCE AND LEGACY ROWS (before 0033) ═════════
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
      values (v_a, 'SNAPSHOT TEST HOST (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'SNAPSHOT TEST 2H (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_exp;
    insert into public.experience_availability (experience_id, available_from, available_until)
    values (v_exp, '2026-01-01', '2030-12-31');

    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_legacy_req;
    -- A request confirmed before 0033 (0031's guard allowed CONFIRMED without a snapshot).
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_legacy_req, v_exp, '2027-06-01', 'evening', 2, '19:00') returning id into v_legacy_confirmed;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_legacy_confirmed;
    -- A request made before 0032: no preferred_time (inserted past the 0032 rule on purpose).
    alter table public.booking_request_items disable trigger booking_request_items_before_insert;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_legacy_req, v_exp, '2027-06-02', 'evening', 2, 40) returning id into v_legacy_untimed;
    -- A request starting in about an hour (check 16): could exist once time passes.
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time)
    values (v_legacy_req, v_exp, (now() at time zone 'Atlantic/Canary')::date, 'evening', 2, 40,
            ((now() + interval '1 hour') at time zone 'Atlantic/Canary')::time) returning id into v_late;
    alter table public.booking_request_items enable trigger booking_request_items_before_insert;

    -- ═════════ 1. 0033 BODY (verbatim from 0033_accepted_start_snapshot.sql, section 2) ═════════
    v_stage := 'migration';
    -- Nullable, no default: metadata-only, no table rewrite; every existing row is NULL.
    alter table public.booking_request_items
      add column accepted_at timestamptz,
      add column confirmed_start_at timestamptz,
      add column duration_minutes integer;
    alter table public.booking_request_items
      add constraint booking_request_items_acceptance_all_or_none_check
        check ((accepted_at is null) = (confirmed_start_at is null)
               and (accepted_at is null) = (duration_minutes is null)),
      add constraint booking_request_items_duration_minutes_check
        check (duration_minutes is null or duration_minutes > 0),
      add constraint booking_request_items_acceptance_status_check
        check (accepted_at is null or status in ('CONFIRMED', 'CANCELLED'));

    create or replace function public.booking_request_items_before_update()
    returns trigger language plpgsql set search_path = '' as $fn$
    declare
      v_declining boolean := old.status = 'REQUESTED' and new.status = 'DECLINED';
      v_cancelling boolean := old.status = 'CONFIRMED' and new.status = 'CANCELLED';
      v_accepting boolean := old.status = 'REQUESTED' and new.status = 'CONFIRMED';
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
      v_item record;
    begin
      if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
      -- Same authorization as 0031: the caller hosts this item's experience, the item is
      -- still REQUESTED and its request still active. Locked, so the snapshot below is
      -- taken from the row that is actually accepted.
      select bri.id, bri.preferred_time, e.duration_minutes into v_item
        from public.booking_request_items bri
        join public.experiences e on e.id = bri.experience_id
        join public.providers p on p.id = e.provider_id
       where bri.id = p_item_id
         and bri.status = 'REQUESTED'
         and p.user_id = v_uid
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
      update public.booking_request_items bri
         set status = 'CONFIRMED',
             accepted_at = now(),
             confirmed_start_at = (bri.planned_date + bri.preferred_time) at time zone 'Atlantic/Canary',
             duration_minutes = v_item.duration_minutes
       where bri.id = v_item.id
         and bri.status = 'REQUESTED';
      return found;
    end $fn$;

    -- ═════════ 2. SETUP: NEW REQUESTS AS GUEST G (checks 1, 11) ═════════
    v_stage := 'setup';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-07-15', 'evening', 2, '20:00') returning id into v_summer;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-01-15', 'evening', 2, '19:00') returning id into v_winter;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-03-27', 'morning', 1, '08:00') returning id into v_dst_before;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-03-28', 'morning', 1, '08:00') returning id into v_dst_after;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-08-01', 'afternoon', 1, '14:00') returning id into v_other;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_exp, '2027-08-02', 'afternoon', 1, '14:00') returning id into v_cancel;

    v_stage := '1 new items';
    select count(*) into n from public.booking_request_items
     where booking_request_id = v_req and status = 'REQUESTED'
       and accepted_at is null and confirmed_start_at is null and duration_minutes is null;
    if n <> 6 then raise exception '1 FAILED: % of 6 new items are REQUESTED with an empty snapshot', n; end if;

    v_stage := '11 spoof at creation';
    for r in select unnest(array[
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, accepted_at) values ($1, $2, ''2027-09-01'', ''evening'', 2, ''19:00'', now())',
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, confirmed_start_at) values ($1, $2, ''2027-09-01'', ''evening'', 2, ''19:00'', now())',
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, duration_minutes) values ($1, $2, ''2027-09-01'', ''evening'', 2, ''19:00'', 1)']) as stmt loop
      begin
        execute r.stmt using v_req, v_exp;
        raise exception '11 FAILED: G could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;

    v_stage := '9 guest direct writes';
    for r in select unnest(array[
               'update public.booking_request_items set accepted_at = now() where id = $1',
               'update public.booking_request_items set confirmed_start_at = now() where id = $1',
               'update public.booking_request_items set duration_minutes = 30 where id = $1']) as stmt loop
      begin
        execute r.stmt using v_summer;
        raise exception '9 FAILED: G could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
    reset role;

    v_stage := '11 spoof as postgres';
    begin
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time,
                                                accepted_at, confirmed_start_at, duration_minutes)
      values (v_req, v_exp, '2027-09-02', 'evening', 2, '19:00', now(), now(), 120);
      raise exception '11 FAILED: a REQUESTED item was created with a snapshot';
    exception when check_violation then null;
    end;

    -- ═════════ 3. FAILED ACCEPTANCES (check 12) ═════════
    v_stage := '12 failed acceptance';
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.booking_item_confirm(v_other) then raise exception '12 FAILED: account B accepted host A''s item'; end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.booking_item_confirm(v_legacy_untimed);
      raise exception '12 FAILED: an item without preferred_time was accepted';
    exception when invalid_parameter_value then null;
    end;
    reset role;
    for r in select * from (values
      ('update public.booking_request_items set status = ''CONFIRMED'' where id = $1', 'accepting without a snapshot'),
      ('update public.booking_request_items set status = ''CONFIRMED'', accepted_at = now(), duration_minutes = 120, confirmed_start_at = now() where id = $1', 'accepting with a fake start'),
      ('update public.booking_request_items set status = ''CONFIRMED'', accepted_at = now(), duration_minutes = 0, confirmed_start_at = (planned_date + preferred_time) at time zone ''Atlantic/Canary'' where id = $1', 'accepting with a zero duration'),
      ('update public.booking_request_items set accepted_at = now() where id = $1', 'a snapshot on a REQUESTED item')
    ) as t(stmt, what) loop
      begin
        execute r.stmt using v_other;
        raise exception '12 FAILED: the guard allowed % (as postgres)', r.what;
      exception when check_violation then null;
      end;
    end loop;
    select count(*) into n from public.booking_request_items
     where id in (v_other, v_legacy_untimed) and status = 'REQUESTED'
       and accepted_at is null and confirmed_start_at is null and duration_minutes is null;
    if n <> 2 then raise exception '12 FAILED: a failed acceptance left the item changed'; end if;

    -- ═════════ 4. ACCEPTANCE BY HOST A (checks 2-7, 10, 13) ═════════
    v_stage := '2 acceptance';
    select br.estimated_total into v_total_before from public.booking_requests br where br.id = v_req;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    for r in select unnest(array[v_summer, v_winter, v_dst_before, v_dst_after, v_cancel]) as id loop
      if not public.booking_item_confirm(r.id) then raise exception '2 FAILED: host A cannot accept %', r.id; end if;
    end loop;
    if public.booking_item_confirm(v_summer) then raise exception '2 FAILED: an item was accepted twice'; end if;

    v_stage := '10 host direct writes';
    for r in select unnest(array[
               'update public.booking_request_items set accepted_at = now() - interval ''1 day'' where id = $1',
               'update public.booking_request_items set confirmed_start_at = now() where id = $1',
               'update public.booking_request_items set duration_minutes = 30 where id = $1']) as stmt loop
      begin
        execute r.stmt using v_summer;
        raise exception '10 FAILED: host A could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
    reset role;

    v_stage := '2-7 snapshot values';
    select count(*) into n from public.booking_request_items
     where id in (v_summer, v_winter, v_dst_before, v_dst_after, v_cancel)
       and status = 'CONFIRMED' and accepted_at = now() and duration_minutes = 120;
    if n <> 5 then raise exception '2/7 FAILED: % of 5 accepted items have status, accepted_at and the 120-minute duration', n; end if;
    for r in select * from (values
      (v_summer, '2027-07-15 19:00:00+00'::timestamptz, '3 summer'),
      (v_winter, '2027-01-15 19:00:00+00', '4 winter'),
      (v_dst_before, '2027-03-27 08:00:00+00', '5 the day before the DST switch'),
      (v_dst_after, '2027-03-28 07:00:00+00', '5 the day of the DST switch')
    ) as t(id, expected, what) loop
      select count(*) into n from public.booking_request_items where id = r.id and confirmed_start_at = r.expected;
      if n <> 1 then raise exception '% FAILED: confirmed_start_at is not %', r.what, r.expected; end if;
    end loop;
    select count(*) into n from public.booking_request_items
     where id in (v_summer, v_winter, v_dst_before, v_dst_after)
       and (confirmed_start_at at time zone 'Atlantic/Canary')::date = planned_date
       and (confirmed_start_at at time zone 'Atlantic/Canary')::time = preferred_time;
    if n <> 4 then raise exception '6 FAILED: confirmed_start_at does not show the requested Tenerife date and time'; end if;

    v_stage := '8 experience edited afterwards';
    update public.experiences set duration_minutes = 90 where id = v_exp;
    select count(*) into n from public.booking_request_items where id = v_summer and duration_minutes = 120;
    if n <> 1 then raise exception '8 FAILED: the booking''s duration followed the experience'; end if;

    v_stage := '13 snapshot is permanent';
    for r in select unnest(array[
               'update public.booking_request_items set confirmed_start_at = confirmed_start_at + interval ''1 hour'' where id = $1',
               'update public.booking_request_items set duration_minutes = 90 where id = $1',
               'update public.booking_request_items set accepted_at = null, confirmed_start_at = null, duration_minutes = null where id = $1']) as stmt loop
      begin
        execute r.stmt using v_summer;
        raise exception '13 FAILED: the guard allowed (as postgres): %', r.stmt;
      exception when check_violation then null;
      end;
    end loop;
    select br.estimated_total into v_total_after from public.booking_requests br where br.id = v_req;
    if v_total_after <> v_total_before then
      raise exception '13 FAILED: accepting changed estimated_total from % to %', v_total_before, v_total_after;
    end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_cancel_as_host(v_cancel, 'OTHER', null) then
      raise exception '13 FAILED: host A cannot cancel an accepted item';
    end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = v_cancel and status = 'CANCELLED' and accepted_at is not null and duration_minutes = 120;
    if n <> 1 then raise exception '13 FAILED: the snapshot did not survive the cancellation'; end if;

    -- ═════════ 5. LEGACY CONFIRMED ROW (check 14) ═════════
    v_stage := '14 legacy confirmed';
    update public.booking_request_items set completed_at = now() where id = v_legacy_confirmed;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '14 FAILED: a legacy CONFIRMED item cannot be completed'; end if;
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_cancel_as_guest(v_legacy_confirmed, 'OTHER', '') then
      raise exception '14 FAILED: G cannot cancel a legacy CONFIRMED item';
    end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = v_legacy_confirmed and status = 'CANCELLED' and accepted_at is null and confirmed_start_at is null;
    if n <> 1 then raise exception '14 FAILED: the legacy item was given a snapshot'; end if;

    -- ═════════ 6. PRIVILEGES AND LATE ACCEPTANCE (checks 15, 16) ═════════
    v_stage := '15 privileges';
    if has_function_privilege('anon', 'public.booking_item_confirm(uuid)', 'EXECUTE')
       or not has_function_privilege('authenticated', 'public.booking_item_confirm(uuid)', 'EXECUTE') then
      raise exception '15 FAILED: booking_item_confirm is not for signed-in users only';
    end if;

    v_stage := '16 late acceptance (observation)';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_late) then
      raise exception '16 FAILED: a request starting in about an hour could not be accepted';
    end if;
    reset role;
    select count(*) into n from public.booking_request_items
     where id = v_late and accepted_at = now() and confirmed_start_at - accepted_at < interval '2 hours';
    if n <> 1 then raise exception '16 FAILED: the late acceptance did not record the real times'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
