-- 0033: accepted start snapshot — accepted_at, confirmed_start_at, duration_minutes
--
-- ONE SQL statement (a single DO block), same form as 0023-0032: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: when a host accepts a request, the requested Tenerife date and time become the
-- booking's confirmed start, and the experience's length at that moment is what was
-- agreed. Later phases (payment deadline = least(accepted_at + 24 h,
-- confirmed_start_at - 2 h), overlap protection) need these as stored, authoritative
-- values — not re-derived from a time zone rule or from an experience the host can
-- still edit. Until now acceptance (0031's booking_item_confirm) changed only the status.
--
-- What it does, on public.booking_request_items:
--   * three nullable columns, written ONLY when a host accepts (REQUESTED -> CONFIRMED):
--       accepted_at         timestamptz  the database clock at acceptance (now())
--       confirmed_start_at  timestamptz  (planned_date + preferred_time) AT TIME ZONE
--                                        'Atlantic/Canary' — the real instant of the
--                                        requested Tenerife start, DST-correct from the
--                                        time-zone database (never a fixed offset)
--       duration_minutes    integer      the experience's duration_minutes at acceptance
--   * check constraints: the three are all set or all NULL; duration_minutes > 0; and
--     they may exist only on a CONFIRMED or CANCELLED item (so a new REQUESTED item can
--     never carry them, whoever inserts it).
--   * booking_request_items_before_update() (0031) is replaced by the same function plus
--     one rule (every 0031 check is kept verbatim): on REQUESTED -> CONFIRMED the three
--     fields MUST be set, with confirmed_start_at equal to the requested Tenerife start
--     and a positive duration; on every other update they can never change. This holds
--     for every role, postgres included.
--   * booking_item_confirm(item) (0031) keeps its signature, grants and authorization
--     (the caller hosts the item's experience, the item is still REQUESTED, its request
--     still active, else false). It now locks the item, refuses (SQLSTATE 22023,
--     nothing changed) an item with no preferred_time (requests made before 0032) or an
--     experience without a valid duration, and in ONE update sets the status and the
--     three fields. Notifications and emails fire exactly as before (status trigger).
--
-- Legacy: existing rows keep NULL in all three (no backfill, no status change). A
-- legacy REQUESTED item without preferred_time can no longer be accepted (the host is
-- told to ask the guest for a new request); legacy CONFIRMED rows are untouched and keep
-- working (cancel, completion, messaging, display from planned_date/preferred_time).
--
-- What it does NOT do: add payment states, a payment deadline, overlap protection or an
-- acceptance-time restriction; change any policy, grant, other function or trigger.
--
-- Run as role `postgres`, the whole file, in one run, after 0032.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'booking_request_items'
             and column_name in ('accepted_at', 'confirmed_start_at', 'duration_minutes')) then
    raise exception '0033 ABORTED: an acceptance snapshot column already exists';
  end if;
  if to_regprocedure('public.booking_request_start_error(uuid, date, text, time, timestamptz)') is null then
    raise exception '0033 ABORTED: 0032 (booking_request_start_error) is not applied';
  end if;
  if to_regprocedure('public.booking_item_confirm(uuid)') is null
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or position('set status = ''CONFIRMED''' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('confirmed_start_at' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) > 0 then
    raise exception '0033 ABORTED: public.booking_item_confirm(uuid) is not 0031''s version';
  end if;
  if to_regprocedure('public.booking_request_items_before_update()') is null
     or position('completed_at can only be set once' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('confirmed_start_at' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) > 0 then
    raise exception '0033 ABORTED: public.booking_request_items_before_update() is not 0031''s version';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
                 and tgname = 'booking_request_items_before_update' and not tgisinternal) then
    raise exception '0033 ABORTED: the 0031 update trigger is missing';
  end if;
  if not exists (select 1 from pg_timezone_names where name = 'Atlantic/Canary') then
    raise exception '0033 ABORTED: the database does not know the Atlantic/Canary time zone';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select count(*) from information_schema.columns where table_schema = 'public'
      and table_name = 'booking_request_items'
      and ((column_name = 'accepted_at' and data_type = 'timestamp with time zone')
           or (column_name = 'confirmed_start_at' and data_type = 'timestamp with time zone')
           or (column_name = 'duration_minutes' and data_type = 'integer'))
      and is_nullable = 'YES') <> 3 then
    raise exception '0033 VERIFY FAILED: the snapshot columns are not as intended';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.booking_request_items'::regclass
      and conname in ('booking_request_items_acceptance_all_or_none_check',
                      'booking_request_items_duration_minutes_check',
                      'booking_request_items_acceptance_status_check')) <> 3 then
    raise exception '0033 VERIFY FAILED: a snapshot constraint is missing';
  end if;
  for r in select unnest(array['accepted_at', 'confirmed_start_at', 'duration_minutes']) as col loop
    if has_column_privilege('authenticated', 'public.booking_request_items', r.col, 'INSERT')
       or has_column_privilege('authenticated', 'public.booking_request_items', r.col, 'UPDATE')
       or has_column_privilege('anon', 'public.booking_request_items', r.col, 'INSERT')
       or has_column_privilege('anon', 'public.booking_request_items', r.col, 'UPDATE')
       or has_column_privilege('anon', 'public.booking_request_items', r.col, 'SELECT') then
      raise exception '0033 VERIFY FAILED: a client can write booking_request_items.%', r.col;
    end if;
  end loop;
  if position('confirmed_start_at' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.booking_item_confirm(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.booking_item_confirm(uuid)', 'EXECUTE') then
    raise exception '0033 VERIFY FAILED: booking_item_confirm is not the snapshotting SECURITY DEFINER version';
  end if;
  if position('The acceptance snapshot can only be written when a request is accepted' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('completed_at can only be set once' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0 then
    raise exception '0033 VERIFY FAILED: the update guard is not the snapshot-aware 0031 guard';
  end if;
  if exists (select 1 from public.booking_request_items
             where accepted_at is not null or confirmed_start_at is not null or duration_minutes is not null) then
    raise exception '0033 VERIFY FAILED: an existing row was given snapshot values';
  end if;
  -- DST sanity: 20:00 in July is WEST (UTC+1), 19:00 in January is WET (UTC+0).
  if ('2026-07-15'::date + '20:00'::time) at time zone 'Atlantic/Canary' <> '2026-07-15 19:00:00+00'::timestamptz
     or ('2026-01-15'::date + '19:00'::time) at time zone 'Atlantic/Canary' <> '2026-01-15 19:00:00+00'::timestamptz then
    raise exception '0033 VERIFY FAILED: Atlantic/Canary local times do not convert as expected';
  end if;
end
$migration$;
