-- 0032: requested start time rules — required, fits the moment, 4 hours' notice (Tenerife time)
--
-- ONE SQL statement (a single DO block), same form as 0023-0031: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: a request's preferred_time is about to become the time the experience is
-- booked for (and later paid for), so it must be reliable. Until now the database
-- (0031's insert guard) checked status, price, publication and group size, but not
-- the time: preferred_time could be missing, outside the chosen moment, so late that
-- the experience would run past the moment's end, or minutes (or days) in the past.
--
-- What it does:
--   * public.booking_request_start_error(experience, date, moment, time, now): the one
--     database rule for a requested start. Returns NULL when the start may be
--     requested, otherwise the reason:
--       - preferred_time is required;
--       - it must fall inside the moment's fixed range (morning 07:00-12:00,
--         afternoon 12:00-17:00, evening 17:00-22:00 — the same ranges as
--         src/lib/matching/slot-availability.ts), and the whole experience
--         (experiences.duration_minutes) must end by the end of that range — a
--         2-hour evening experience starts at 20:00 at the latest;
--       - an experience_availability window of the experience must cover the date,
--         and its own hours (when set) must touch the moment — the app's existing
--         availability rule, unchanged;
--       - the start, read as Atlantic/Canary local time and converted to a real
--         instant ((planned_date + preferred_time) AT TIME ZONE 'Atlantic/Canary',
--         DST-correct from the time-zone database, never a fixed offset), must be at
--         least 4 hours after `now` — so it can never be in the past.
--     `now` is a parameter so the rule can be tested at any moment; the trigger
--     always passes the database clock (now()). Callable by nobody but its owner.
--   * public.booking_request_items_before_insert() (0031) is replaced by the same
--     function with one addition: every NEW item must pass the rule above, else
--     SQLSTATE 22023. Every 0031 check is kept verbatim.
--
-- Only INSERTs are checked. Existing rows (including historical ones with no
-- preferred_time) are not touched, re-validated or backfilled, and status changes
-- through the 0031 functions work on them exactly as before.
--
-- What it does NOT do: change any table, column, constraint, policy or grant; touch
-- the 0031 update guard, transition functions or totals; add capacity, overlap or
-- confirmed-start logic.
--
-- Run as role `postgres`, the whole file, in one run, after 0031.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regprocedure('public.booking_request_items_before_insert()') is null
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure)
     or position('the price is never taken from the client' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure)) = 0
     or position('booking_request_start_error' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure)) > 0 then
    raise exception '0032 ABORTED: public.booking_request_items_before_insert() is not 0031''s version';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
                 and tgname = 'booking_request_items_before_insert' and not tgisinternal) then
    raise exception '0032 ABORTED: the 0031 insert trigger is missing';
  end if;
  if to_regprocedure('public.booking_request_start_error(uuid, date, text, time, timestamptz)') is not null then
    raise exception '0032 ABORTED: public.booking_request_start_error already exists';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'experiences' and column_name = 'duration_minutes')
     or (select count(*) from information_schema.columns where table_schema = 'public'
         and table_name = 'experience_availability'
         and column_name in ('experience_id', 'available_from', 'available_until', 'start_time', 'end_time')) <> 5
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'booking_request_items' and column_name = 'preferred_time'
                    and data_type = 'time without time zone') then
    raise exception '0032 ABORTED: an expected experiences/availability/preferred_time column is missing';
  end if;
  if not exists (select 1 from pg_timezone_names where name = 'Atlantic/Canary') then
    raise exception '0032 ABORTED: the database does not know the Atlantic/Canary time zone';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS ═════════
  if position('public.booking_request_start_error(' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure)) = 0
     or position('the price is never taken from the client' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure)) = 0
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_request_items_before_insert()'::regprocedure) then
    raise exception '0032 VERIFY FAILED: the insert guard does not call the start rule';
  end if;
  if has_function_privilege('anon', 'public.booking_request_start_error(uuid, date, text, time, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.booking_request_start_error(uuid, date, text, time, timestamptz)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.booking_request_start_error(uuid, date, text, time, timestamptz)', 'EXECUTE') then
    raise exception '0032 VERIFY FAILED: booking_request_start_error is callable by a client role';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
                 and tgname = 'booking_request_items_before_insert' and not tgisinternal) then
    raise exception '0032 VERIFY FAILED: the insert trigger is missing';
  end if;
  -- DST sanity: 20:00 in July is WEST (UTC+1), 19:00 in January is WET (UTC+0).
  if ('2026-07-15'::date + '20:00'::time) at time zone 'Atlantic/Canary' <> '2026-07-15 19:00:00+00'::timestamptz
     or ('2026-01-15'::date + '19:00'::time) at time zone 'Atlantic/Canary' <> '2026-01-15 19:00:00+00'::timestamptz then
    raise exception '0032 VERIFY FAILED: Atlantic/Canary local times do not convert as expected';
  end if;
end
$migration$;
