-- 0034: no overlapping accepted bookings per host — serialized, database-enforced
--
-- ONE SQL statement (a single DO block), same form as 0023-0033: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: a host must never be booked twice at the same time. Since 0033 an accepted
-- booking has an authoritative interval — [confirmed_start_at, confirmed_start_at +
-- duration_minutes) — but acceptance (booking_item_confirm) checked nothing against the
-- host's other bookings, and two acceptances running at the same moment could not see
-- each other anyway.
--
-- Strategy: a transaction-level advisory lock per host, then the overlap check, then
-- the update — all in one transaction. (An exclusion constraint was considered: it
-- would need the host id copied onto every item, a trigger-maintained range column —
-- timestamptz + interval cannot be a generated column — the btree_gist extension and a
-- status-dependent predicate. The lock gives the same guarantee without restructuring.)
--
-- What it does:
--   * public.booking_host_lock(provider_id): pg_advisory_xact_lock on
--       hashtextextended('felyn.booking_host_acceptance:' || provider_id, 0)
--     — one deterministic 64-bit key per host (providers.id, the id the app already
--     uses for a host), namespaced so it can't meet any other advisory lock. Held until
--     the transaction commits or rolls back. Two hosts whose keys happened to collide
--     would only wait for each other briefly; it can never let an overlap through.
--   * public.booking_host_overlap_exists(provider_id, item_id, start, end): whether
--     another booking of that host (item -> experience -> provider) that reserves the
--     host's time overlaps the half-open interval [start, end):
--         existing_start < new_end AND existing_end > new_start
--     where existing_end = confirmed_start_at + duration_minutes minutes (the 0033
--     snapshot — never the experience's current duration). Reserving statuses: only
--     CONFIRMED today (one list to extend for a future pre-payment hold). Rows without a
--     snapshot (accepted before 0033) never block: their real interval is unknown.
--   * booking_item_confirm(item) keeps its signature, grants, authorization and 0033
--     validations; it now resolves the host, takes that host's lock, re-reads and locks
--     the item, and refuses an overlap with SQLSTATE 23P01 (exclusion_violation) —
--     nothing changed, the item stays REQUESTED without a snapshot.
--   * booking_request_items_before_update() (0033) is replaced by the same function plus
--     the same lock and check on every REQUESTED -> CONFIRMED, so no route to CONFIRMED
--     can skip it (only owner-run code can call the helpers; a direct UPDATE by any
--     other role can no longer accept at all). Every 0033 check is kept verbatim.
--   * booking_request_items_accepted_interval_idx on (experience_id, confirmed_start_at)
--     WHERE confirmed_start_at IS NOT NULL: the overlap check reads a host's experiences
--     (experiences_provider_id_idx) and, for each, only accepted rows starting before the
--     new end. Partial, so pending, declined and withdrawn rows don't enter it.
--
-- What it does NOT do: add a constraint, status or payment state; change any table,
-- policy or grant; touch existing rows. Existing overlaps among already accepted
-- bookings (if any) are reported as a NOTICE and left alone.
--
-- Run as role `postgres`, the whole file, in one run, after 0033.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
  n int;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if (select count(*) from information_schema.columns where table_schema = 'public'
      and table_name = 'booking_request_items'
      and column_name in ('accepted_at', 'confirmed_start_at', 'duration_minutes')) <> 3 then
    raise exception '0034 ABORTED: 0033''s snapshot columns are missing';
  end if;
  if to_regprocedure('public.booking_item_confirm(uuid)') is null
     or not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or position('confirmed_start_at' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('booking_host_lock' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) > 0 then
    raise exception '0034 ABORTED: public.booking_item_confirm(uuid) is not 0033''s version';
  end if;
  if to_regprocedure('public.booking_request_items_before_update()') is null
     or position('The acceptance snapshot can only be written when a request is accepted' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('booking_host_lock' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) > 0 then
    raise exception '0034 ABORTED: public.booking_request_items_before_update() is not 0033''s version';
  end if;
  if to_regprocedure('public.booking_host_lock(uuid)') is not null
     or to_regprocedure('public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)') is not null
     or to_regclass('public.booking_request_items_accepted_interval_idx') is not null then
    raise exception '0034 ABORTED: a 0034 function or index already exists';
  end if;
  if to_regprocedure('pg_catalog.hashtextextended(text, bigint)') is null then
    raise exception '0034 ABORTED: hashtextextended(text, bigint) is not available';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS ═════════
  for r in select unnest(array['public.booking_host_lock(uuid)',
                               'public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)']) as fn loop
    if to_regprocedure(r.fn) is null
       or has_function_privilege('anon', r.fn, 'EXECUTE')
       or has_function_privilege('authenticated', r.fn, 'EXECUTE')
       or has_function_privilege('service_role', r.fn, 'EXECUTE') then
      raise exception '0034 VERIFY FAILED: % is missing or callable by a client role', r.fn;
    end if;
  end loop;
  if to_regclass('public.booking_request_items_accepted_interval_idx') is null then
    raise exception '0034 VERIFY FAILED: the accepted-interval index is missing';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.booking_item_confirm(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.booking_item_confirm(uuid)', 'EXECUTE')
     or position('public.booking_host_lock(v_provider)' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) = 0
     or position('public.booking_host_lock(v_provider)' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure))
        > position('for update of bri' in
                   (select p.prosrc from pg_proc p where p.oid = 'public.booking_item_confirm(uuid)'::regprocedure)) then
    raise exception '0034 VERIFY FAILED: booking_item_confirm does not lock the host before re-reading the item';
  end if;
  if position('public.booking_host_overlap_exists(' in
              (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0
     or position('The acceptance snapshot can only be written when a request is accepted' in
                 (select p.prosrc from pg_proc p where p.oid = 'public.booking_request_items_before_update()'::regprocedure)) = 0 then
    raise exception '0034 VERIFY FAILED: the update guard does not check overlaps on acceptance';
  end if;
end
$migration$;
