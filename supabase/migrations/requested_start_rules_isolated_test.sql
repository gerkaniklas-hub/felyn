-- NOT A MIGRATION. Fail-closed isolated test for 0032_requested_start_rules.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0032's functions and every test row), releases
-- every lock, and leaves the session idle. There is no code path that finishes
-- normally.
--
-- Run it BEFORE 0032 and AFTER 0031 (it applies 0032's body itself, then throws it
-- away; once 0032 is applied it fails at the first statement and should not be
-- re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs two existing accounts in auth.users (A = host, G = guest). The host
-- profile, experiences, availability and bookings it needs are created and rolled
-- back. Inserts run as the `authenticated` role with G's claims, so row-level
-- security and column privileges are genuinely enforced.
--
-- The start rule itself (booking_request_start_error) is checked with FIXED "now"
-- instants, so the 4-hour boundary, the past, both seasons and both DST switch days
-- are tested deterministically whenever this runs; the trigger is then checked with
-- the real clock (far-future and past starts, which don't depend on the time of day).
--
-- What it checks:
--   1  4-hour rule, exact boundary, in summer (WEST, UTC+1) and winter (WET, UTC+0) —
--      a naive UTC or a fixed UTC+1 implementation fails one of these
--   2  4-hour rule on the spring-forward (2026-03-29) and fall-back (2026-10-25) days
--   3  a start in the past is refused
--   4  preferred_time is required
--   5  the start must be inside the chosen moment (07-12 / 12-17 / 17-22)
--   6  the whole experience must end by the end of the moment (2 h evening: 20:00
--      yes, 20:30 / 21:00 no; 60 min: 21:00 yes, 21:30 no; too long: never)
--   7  availability: the date must be in a window, and a window's own hours must
--      touch the moment
--   8  through the real trigger, as guest G: missing time, past start, start outside
--      the moment, start running past the moment, date outside availability all
--      refused (22023); a valid far-future request accepted, price from the experience
--   9  legacy: an item created before 0032 with NO preferred_time is untouched and
--      still goes through the 0031 transitions (host confirms it)
--  10  0031 still holds: G cannot UPDATE preferred_time; G withdraws through
--      booking_item_withdraw; the rule function is not callable by clients

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_g uuid;
  v_a_provider uuid;
  v_e2h uuid; v_e1h uuid; v_ewin uuid; v_elong uuid;
  v_legacy_req uuid; v_legacy_item uuid;
  v_req uuid; v_item uuid;
  v_future date;
  v_price numeric;
  v_err text;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, EXPERIENCES AND A LEGACY ROW (before 0032) ═════════
    v_stage := 'accounts';
    select u.id into v_a from auth.users u order by u.created_at limit 1;
    select u.id into v_g from auth.users u where u.id <> v_a order by u.created_at limit 1;
    if v_a is null or v_g is null then
      raise exception 'SETUP: need two accounts in auth.users';
    end if;
    select p.id into v_a_provider from public.providers p where p.user_id = v_a;
    if v_a_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_a, 'START RULE TEST HOST (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'START RULE TEST 2H (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_e2h;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'START RULE TEST 1H (rolled back)', 'drink', 25, 1, 6, 60, true) returning id into v_e1h;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'START RULE TEST WINDOW (rolled back)', 'food', 30, 1, 6, 60, true) returning id into v_ewin;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'START RULE TEST 6H (rolled back)', 'food', 90, 1, 6, 360, true) returning id into v_elong;
    insert into public.experience_availability (experience_id, available_from, available_until) values
      (v_e2h, '2026-01-01', '2030-12-31'), (v_e1h, '2026-01-01', '2030-12-31'), (v_elong, '2026-01-01', '2030-12-31');
    insert into public.experience_availability (experience_id, available_from, available_until, start_time, end_time)
    values (v_ewin, '2026-01-01', '2030-12-31', '09:00', '11:00');

    -- A request made before 0032: no preferred_time (allowed until now).
    v_future := (now() at time zone 'Atlantic/Canary')::date + 30;
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_legacy_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_legacy_req, v_e2h, v_future, 'evening', 2) returning id into v_legacy_item;

    -- ═════════ 1. 0032 BODY (verbatim from 0032_requested_start_rules.sql, section 2) ═════════
    v_stage := 'migration';
    create function public.booking_request_start_error(
      p_experience_id uuid, p_date date, p_moment text, p_time time, p_now timestamptz
    ) returns text language plpgsql stable set search_path = '' as $fn$
    declare
      v_duration integer;
      v_moment_start integer;
      v_moment_end integer;
      v_start numeric;
    begin
      if p_time is null then
        return 'preferred_time is required';
      end if;
      select e.duration_minutes into v_duration from public.experiences e where e.id = p_experience_id;
      if not found then
        return 'experience not found';
      end if;
      -- Minutes since midnight, [start, end) — same ranges as slot-availability.ts.
      v_moment_start := case p_moment when 'morning' then 420 when 'afternoon' then 720 when 'evening' then 1020 end;
      if v_moment_start is null then
        return 'planned_moment must be morning, afternoon or evening';
      end if;
      v_moment_end := v_moment_start + 300;
      v_start := extract(epoch from p_time) / 60;
      if v_start < v_moment_start or v_start >= v_moment_end then
        return 'preferred_time is outside the selected time of day';
      end if;
      if v_start + v_duration > v_moment_end then
        return 'the experience would end after the selected time of day';
      end if;
      if not exists (
        select 1 from public.experience_availability a
         where a.experience_id = p_experience_id
           and p_date between a.available_from and a.available_until
           and (a.start_time is null or a.end_time is null
                or (extract(epoch from a.start_time) / 60 < v_moment_end
                    and extract(epoch from a.end_time) / 60 > v_moment_start))
      ) then
        return 'the experience is not available on that date and time of day';
      end if;
      -- Tenerife local date + time -> a real instant (DST from the time-zone database).
      if (p_date + p_time) at time zone 'Atlantic/Canary' < p_now + interval '4 hours' then
        return 'the requested start must be at least 4 hours from now';
      end if;
      return null;
    end $fn$;

    create or replace function public.booking_request_items_before_insert()
    returns trigger language plpgsql security definer set search_path = '' as $fn$
    declare
      v_exp record;
      v_start_error text;
    begin
      if new.status <> 'REQUESTED'
         or new.decided_at is not null or new.decline_reason is not null or new.decline_note is not null
         or new.cancelled_at is not null or new.cancelled_by is not null
         or new.cancellation_reason is not null or new.cancellation_note is not null
         or new.completed_at is not null then
        raise exception 'A new booking item must be REQUESTED with no decision, cancellation or completion'
          using errcode = '23514';
      end if;
      if not exists (select 1 from public.booking_requests br
                      where br.id = new.booking_request_id and br.status in ('REQUESTED', 'CONFIRMED')) then
        raise exception 'Items can only be added to an active booking request' using errcode = '22023';
      end if;
      select e.price_per_person, e.min_guests, e.max_guests, e.published into v_exp
        from public.experiences e where e.id = new.experience_id;
      if not found or not v_exp.published then
        raise exception 'This experience is not available' using errcode = '22023';
      end if;
      if new.guest_count < v_exp.min_guests or new.guest_count > v_exp.max_guests then
        raise exception 'guest_count is outside this experience''s group size' using errcode = '22023';
      end if;
      -- 0032: the requested start (required, fits the moment, 4 hours' notice in Tenerife time).
      v_start_error := public.booking_request_start_error(
        new.experience_id, new.planned_date, new.planned_moment, new.preferred_time, now());
      if v_start_error is not null then
        raise exception 'Requested start refused: %', v_start_error using errcode = '22023';
      end if;
      new.price_per_person := v_exp.price_per_person;  -- the price is never taken from the client
      return new;
    end $fn$;

    revoke execute on function public.booking_request_start_error(uuid, date, text, time, timestamptz)
      from public, anon, authenticated, service_role;

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    insert into public.booking_requests (user_id, stay_id) values (v_g, null) returning id into v_req;

    -- ═════════ 3. THE START RULE WITH FIXED "NOW" (checks 1-7) ═════════
    v_stage := '1-7 start rule';
    for r in select * from (values
      -- check 1: summer, now = 15:00 UTC = 16:00 WEST -> earliest start 20:00 local
      (v_e2h, '2026-07-15'::date, 'evening', '20:00'::time, '2026-07-15 15:00:00+00'::timestamptz, true,  '1 summer: exactly 4 h'),
      (v_e2h, '2026-07-15', 'evening', '19:30', '2026-07-15 15:00:00+00', false, '1 summer: 3.5 h (a UTC-based rule would accept this)'),
      -- check 1: winter, now = 15:00 UTC = 15:00 WET -> earliest start 19:00 local
      (v_e2h, '2026-01-15', 'evening', '19:00', '2026-01-15 15:00:00+00', true,  '1 winter: exactly 4 h (a fixed UTC+1 rule would refuse this)'),
      (v_e2h, '2026-01-15', 'evening', '18:30', '2026-01-15 15:00:00+00', false, '1 winter: 3.5 h'),
      -- check 2: spring forward, 01:00 UTC; now 03:00 UTC = 04:00 WEST -> earliest 08:00 local
      (v_e1h, '2026-03-29', 'morning', '08:00', '2026-03-29 03:00:00+00', true,  '2 spring-forward day: exactly 4 h'),
      (v_e1h, '2026-03-29', 'morning', '07:30', '2026-03-29 03:00:00+00', false, '2 spring-forward day: 3.5 h'),
      -- check 2: fall back, 01:00 UTC; now 03:00 UTC = 03:00 WET -> earliest 07:00 local
      (v_e1h, '2026-10-25', 'morning', '07:00', '2026-10-25 03:00:00+00', true,  '2 fall-back day: exactly 4 h'),
      (v_e1h, '2026-10-25', 'morning', '07:00', '2026-10-25 03:01:00+00', false, '2 fall-back day: one minute short'),
      -- check 3: past
      (v_e2h, '2026-07-14', 'evening', '20:00', '2026-07-15 15:00:00+00', false, '3 a start yesterday'),
      (v_e2h, '2026-07-15', 'evening', '17:00', '2026-07-15 17:00:00+00', false, '3 a start an hour ago'),
      -- check 5: inside the moment
      (v_e1h, '2027-05-05', 'evening', '16:30', '2026-07-15 15:00:00+00', false, '5 16:30 is not evening'),
      (v_e1h, '2027-05-05', 'morning', '12:00', '2026-07-15 15:00:00+00', false, '5 12:00 is not morning'),
      (v_e1h, '2027-05-05', 'evening', '22:00', '2026-07-15 15:00:00+00', false, '5 22:00 is not evening'),
      (v_e1h, '2027-05-05', 'afternoon', '12:00', '2026-07-15 15:00:00+00', true, '5 12:00 starts the afternoon'),
      -- check 6: duration
      (v_e2h, '2027-05-05', 'evening', '20:00', '2026-07-15 15:00:00+00', true,  '6 2 h at 20:00 ends 22:00'),
      (v_e2h, '2027-05-05', 'evening', '20:30', '2026-07-15 15:00:00+00', false, '6 2 h at 20:30 ends 22:30'),
      (v_e2h, '2027-05-05', 'evening', '21:00', '2026-07-15 15:00:00+00', false, '6 2 h at 21:00 ends 23:00'),
      (v_e1h, '2027-05-05', 'evening', '21:00', '2026-07-15 15:00:00+00', true,  '6 1 h at 21:00 ends 22:00'),
      (v_e1h, '2027-05-05', 'evening', '21:30', '2026-07-15 15:00:00+00', false, '6 1 h at 21:30 ends 22:30'),
      (v_elong, '2027-05-05', 'morning', '07:00', '2026-07-15 15:00:00+00', false, '6 a 6 h experience never fits'),
      -- check 7: availability
      (v_e2h, '2031-01-10', 'evening', '19:00', '2026-07-15 15:00:00+00', false, '7 a date after every window'),
      (v_ewin, '2027-05-05', 'morning', '09:00', '2026-07-15 15:00:00+00', true,  '7 the window''s hours touch the morning'),
      (v_ewin, '2027-05-05', 'evening', '19:00', '2026-07-15 15:00:00+00', false, '7 the window''s hours miss the evening')
    ) as t(exp, d, m, tm, now_at, ok, what) loop
      v_err := public.booking_request_start_error(r.exp, r.d, r.m, r.tm, r.now_at);
      if (v_err is null) <> r.ok then
        raise exception '% FAILED: expected %, got %', r.what, case when r.ok then 'accepted' else 'refused' end,
          coalesce(v_err, 'accepted');
      end if;
    end loop;
    v_stage := '4 time required';
    if public.booking_request_start_error(v_e2h, '2027-05-05', 'evening', null, now()) is distinct from 'preferred_time is required' then
      raise exception '4 FAILED: a missing preferred_time was not refused';
    end if;
    if public.booking_request_start_error(v_e2h, '2027-05-05', 'night', '19:00', now()) is null then
      raise exception '5 FAILED: an unknown moment was accepted';
    end if;

    -- ═════════ 4. THE REAL TRIGGER, AS GUEST G (checks 8, 10) ═════════
    v_stage := '8 trigger as guest';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;

    for r in select * from (values
      (v_e2h, v_future, 'evening', null::time, 'a missing preferred_time'),
      (v_e2h, v_future - 60, 'evening', '19:00', 'a start in the past'),
      (v_e2h, v_future, 'evening', '16:00', 'a start outside the evening'),
      (v_e2h, v_future, 'evening', '20:30', 'a 2 h start ending after 22:00'),
      (v_e2h, '2031-01-10', 'evening', '19:00', 'a date outside every availability window')
    ) as t(exp, d, m, tm, what) loop
      begin
        insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
        values (v_req, r.exp, r.d, r.m, 2, r.tm);
        raise exception '8 FAILED: the trigger accepted %', r.what;
      exception when invalid_parameter_value then null;
      end;
    end loop;

    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_req, v_e2h, v_future, 'evening', 2, '20:00') returning id, price_per_person into v_item, v_price;
    if v_price <> 40 then raise exception '8 FAILED: price_per_person is % instead of 40', v_price; end if;

    v_stage := '10 0031 still holds';
    begin
      update public.booking_request_items set preferred_time = '19:00' where id = v_item;
      raise exception '10 FAILED: G updated preferred_time directly';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.booking_request_start_error(v_e2h, v_future, 'evening', '19:00', now());
      raise exception '10 FAILED: a client can call booking_request_start_error';
    exception when insufficient_privilege then null;
    end;
    if not public.booking_item_withdraw(v_item) then raise exception '10 FAILED: G cannot withdraw a new item'; end if;
    reset role;

    -- ═════════ 5. LEGACY ROW (check 9) ═════════
    v_stage := '9 legacy';
    select count(*) into n from public.booking_request_items
     where id = v_legacy_item and preferred_time is null and status = 'REQUESTED';
    if n <> 1 then raise exception '9 FAILED: the legacy item changed'; end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_legacy_item) then
      raise exception '9 FAILED: the host cannot confirm a legacy item without preferred_time';
    end if;
    reset role;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
