-- 0031: booking write hardening — the database owns every booking field and transition
--
-- ONE SQL statement (a single DO block), same form as 0023-0030: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: before payments, the booking rows must be trustworthy. Until now:
--   * guests had a FOR ALL policy on their own booking_requests and booking_request_items
--     (0005/0026): through the API a guest could change price_per_person, guest_count,
--     the date/time, estimated_total or status (e.g. set their own request to
--     CONFIRMED), insert items with any price or status, and delete items;
--   * hosts had an UPDATE policy on items for their experiences (0009) covering EVERY
--     column: a host could change the price, guest count or date, or move a CANCELLED
--     item back to CONFIRMED;
--   * the transition rules (".eq('status', ...)") lived only in the app code;
--   * withdrawing a whole request (planner "Withdraw request") changed only the parent,
--     leaving its REQUESTED items behind as REQUESTED.
--
-- What it does:
--   * Privileges. anon: nothing on either table. authenticated:
--       booking_requests       SELECT, INSERT (user_id, stay_id) only, DELETE
--       booking_request_items  SELECT, INSERT (booking_request_id, experience_id,
--                              planned_date, planned_moment, guest_count,
--                              preferred_time, host_note) only
--     No client may UPDATE either table, or DELETE an item, directly.
--   * Policies. The guest FOR ALL policies are replaced by SELECT + INSERT policies with
--     the same ownership rules, plus a DELETE policy on booking_requests limited to the
--     guest's own requests with no REQUESTED, CONFIRMED or DECLINED item (exactly what
--     the app's deleteStay and failed-submit cleanup delete). The host UPDATE policy is
--     dropped. The provider SELECT policies (0007/0008) are unchanged.
--   * Every status change goes through one SECURITY DEFINER function that checks
--     auth.uid() itself, guards the current state, and writes timestamps from the
--     database clock. Each returns true when it changed the row and false otherwise
--     (not found, not yours, or not in the required state — deliberately the same):
--       guest: booking_item_withdraw(item)                      REQUESTED -> WITHDRAWN
--              booking_item_cancel_as_guest(item, reason, note) CONFIRMED -> CANCELLED
--              booking_request_withdraw(request)                request -> WITHDRAWN and,
--                                in the same transaction, its REQUESTED items -> WITHDRAWN
--       host:  booking_item_confirm(item)                       REQUESTED -> CONFIRMED
--              booking_item_decline(item, reason, note)         REQUESTED -> DECLINED
--              booking_item_cancel_as_host(item, reason, note)  CONFIRMED -> CANCELLED
--     A host may decide only items of their own experiences whose request is still
--     active; a guest may act only on their own requests.
--   * Triggers (they apply to every role, including service_role and postgres):
--       booking_requests BEFORE INSERT: status must be REQUESTED; estimated_total is set
--         to 0 (it is maintained from the items, below).
--       booking_requests BEFORE UPDATE: id, user_id, stay_id, created_at never change;
--         status may only go from REQUESTED/CONFIRMED to WITHDRAWN.
--       booking_request_items BEFORE INSERT: status REQUESTED with every decision,
--         cancellation and completion field empty; the parent request must be active;
--         the experience must be published and guest_count within its min/max;
--         price_per_person is ALWAYS taken from the experience (clients can't send it).
--       booking_request_items BEFORE UPDATE: the booking itself (request, experience,
--         date, moment, guest count, price, preferred time, note, created_at) never
--         changes; status moves only REQUESTED -> CONFIRMED | DECLINED | WITHDRAWN and
--         CONFIRMED -> CANCELLED; decline fields/decided_at change only on the decline,
--         cancellation fields only on the cancellation; completed_at only from empty to
--         set on a CONFIRMED item (the 0016 completion job).
--       booking_request_items AFTER INSERT / UPDATE OF status: recomputes the parent's
--         estimated_total = sum(price_per_person * guest_count) of its REQUESTED and
--         CONFIRMED items (the app's previous formula, now kept by the database).
--   * Data, once: every REQUESTED item whose request is already WITHDRAWN (left behind
--     by the old whole-request withdrawal; hosts never see these) becomes WITHDRAWN,
--     and every estimated_total is recomputed with the formula above. Neither change
--     creates a notification or an email (the 0009/0020/0028 triggers ignore
--     WITHDRAWN, and estimated_total has no trigger).
--
-- What it does NOT do: add a status, column or constraint; change messages, support,
-- notifications, email_outbox or any of their triggers/functions; change the provider
-- SELECT policies; touch service_role's privileges (the email sender is unaffected).
--
-- Maintenance note: to repair a booking row by hand, the guard triggers apply to
-- postgres too; disable them explicitly for that one statement if it is really needed.
--
-- Run as role `postgres`, the whole file, in one run, after 0030.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
  n int;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  -- Policies are exactly as 0005/0007/0008/0009/0026 left them.
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_requests') <> 2
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_requests'
                    and policyname = 'Users manage their own booking requests' and cmd = 'ALL')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_requests'
                    and policyname = 'Providers view requests for their experiences' and cmd = 'SELECT') then
    raise exception '0031 ABORTED: booking_requests policies are not exactly the 0026/0008 pair';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_request_items') <> 3
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_request_items'
                    and policyname = 'Users manage their own booking request items' and cmd = 'ALL')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_request_items'
                    and policyname = 'Providers view items for their experiences' and cmd = 'SELECT')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_request_items'
                    and policyname = 'Providers update items for their experiences' and cmd = 'UPDATE') then
    raise exception '0031 ABORTED: booking_request_items policies are not exactly the 0005/0007/0009 three';
  end if;
  -- The columns and constraints the functions below rely on.
  for r in select unnest(array['decided_at', 'cancelled_at', 'cancelled_by', 'cancellation_reason',
                               'cancellation_note', 'decline_reason', 'decline_note', 'completed_at',
                               'preferred_time', 'host_note']) as col loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'booking_request_items' and column_name = r.col) then
      raise exception '0031 ABORTED: booking_request_items.% is missing', r.col;
    end if;
  end loop;
  if (select array_agg(lit order by lit)
        from (select distinct (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g'))[1] as lit
                from pg_constraint c
               where c.conrelid = 'public.booking_request_items'::regclass
                 and c.conname = 'booking_request_items_status_check') s)
     is distinct from array['CANCELLED', 'CONFIRMED', 'DECLINED', 'REQUESTED', 'WITHDRAWN'] then
    raise exception '0031 ABORTED: booking_request_items_status_check is not the five 0018 values';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.booking_request_items'::regclass
                 and conname = 'booking_request_items_cancellation_reason_actor_check') then
    raise exception '0031 ABORTED: booking_request_items_cancellation_reason_actor_check (0019) is missing';
  end if;
  -- Nothing this migration creates exists yet.
  for r in select unnest(array[
             'public.booking_requests_before_insert()', 'public.booking_requests_before_update()',
             'public.booking_request_items_before_insert()', 'public.booking_request_items_before_update()',
             'public.booking_request_items_sync_total()', 'public.booking_request_is_deletable(uuid)',
             'public.booking_item_confirm(uuid)', 'public.booking_item_decline(uuid, text, text)',
             'public.booking_item_cancel_as_host(uuid, text, text)', 'public.booking_item_withdraw(uuid)',
             'public.booking_item_cancel_as_guest(uuid, text, text)', 'public.booking_request_withdraw(uuid)']) as fn loop
    if to_regprocedure(r.fn) is not null then
      raise exception '0031 ABORTED: % already exists', r.fn;
    end if;
  end loop;

  -- ═════════ 2. MIGRATION ═════════
  -- ── data, once: REQUESTED items left behind under a withdrawn request ──
  update public.booking_request_items bri
     set status = 'WITHDRAWN'
    from public.booking_requests br
   where br.id = bri.booking_request_id
     and br.status = 'WITHDRAWN'
     and bri.status = 'REQUESTED';
  get diagnostics n = row_count;
  raise notice '0031: % REQUESTED item(s) under an already withdrawn request set to WITHDRAWN', n;

  -- ── privileges ──
  revoke all on public.booking_requests from anon;
  revoke all on public.booking_request_items from anon;
  revoke insert, update, delete, truncate, references, trigger on public.booking_requests from authenticated;
  revoke insert, update, delete, truncate, references, trigger on public.booking_request_items from authenticated;
  grant select, delete on public.booking_requests to authenticated;
  grant insert (user_id, stay_id) on public.booking_requests to authenticated;
  grant select on public.booking_request_items to authenticated;
  grant insert (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time, host_note)
    on public.booking_request_items to authenticated;

  -- ── deletable = the caller's own request with no REQUESTED/CONFIRMED/DECLINED item ──
  create function public.booking_request_is_deletable(p_request_id uuid)
  returns boolean language sql stable security definer set search_path = '' as $fn$
    select exists (select 1 from public.booking_requests br
                    where br.id = p_request_id and br.user_id = auth.uid())
       and not exists (select 1 from public.booking_request_items bri
                        where bri.booking_request_id = p_request_id
                          and bri.status in ('REQUESTED', 'CONFIRMED', 'DECLINED'))
  $fn$;

  -- ── policies ──
  drop policy "Users manage their own booking requests" on public.booking_requests;
  create policy "Guests view their own booking requests" on public.booking_requests
    for select to authenticated using (auth.uid() = user_id);
  create policy "Guests create their own booking requests" on public.booking_requests
    for insert to authenticated with check (
      auth.uid() = user_id
      and (stay_id is null
           or exists (select 1 from public.stays s where s.id = stay_id and s.user_id = auth.uid()))
    );
  create policy "Guests delete their own closed booking requests" on public.booking_requests
    for delete to authenticated using (auth.uid() = user_id and public.booking_request_is_deletable(id));

  drop policy "Users manage their own booking request items" on public.booking_request_items;
  drop policy "Providers update items for their experiences" on public.booking_request_items;
  create policy "Guests view their own booking request items" on public.booking_request_items
    for select to authenticated using (
      exists (select 1 from public.booking_requests br
               where br.id = booking_request_id and br.user_id = auth.uid())
    );
  create policy "Guests add items to their own booking requests" on public.booking_request_items
    for insert to authenticated with check (
      exists (select 1 from public.booking_requests br
               where br.id = booking_request_id and br.user_id = auth.uid())
    );

  -- ── triggers: booking_requests ──
  create function public.booking_requests_before_insert()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.status <> 'REQUESTED' then
      raise exception 'A new booking request must be REQUESTED' using errcode = '23514';
    end if;
    new.estimated_total := 0;  -- maintained from the items by booking_request_items_sync_total
    return new;
  end $fn$;
  create trigger booking_requests_before_insert
    before insert on public.booking_requests
    for each row execute function public.booking_requests_before_insert();

  create function public.booking_requests_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
       or new.stay_id is distinct from old.stay_id or new.created_at is distinct from old.created_at then
      raise exception 'A booking request''s owner, stay and identity cannot change' using errcode = '23514';
    end if;
    if new.status is distinct from old.status
       and not (old.status in ('REQUESTED', 'CONFIRMED') and new.status = 'WITHDRAWN') then
      raise exception 'Booking request status cannot change from % to %', old.status, new.status using errcode = '23514';
    end if;
    return new;
  end $fn$;
  create trigger booking_requests_before_update
    before update on public.booking_requests
    for each row execute function public.booking_requests_before_update();

  -- ── triggers: booking_request_items ──
  create function public.booking_request_items_before_insert()
  returns trigger language plpgsql security definer set search_path = '' as $fn$
  declare
    v_exp record;
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
    new.price_per_person := v_exp.price_per_person;  -- the price is never taken from the client
    return new;
  end $fn$;
  create trigger booking_request_items_before_insert
    before insert on public.booking_request_items
    for each row execute function public.booking_request_items_before_insert();

  create function public.booking_request_items_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  declare
    v_declining boolean := old.status = 'REQUESTED' and new.status = 'DECLINED';
    v_cancelling boolean := old.status = 'CONFIRMED' and new.status = 'CANCELLED';
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
    return new;
  end $fn$;
  create trigger booking_request_items_before_update
    before update on public.booking_request_items
    for each row execute function public.booking_request_items_before_update();

  create function public.booking_request_items_sync_total()
  returns trigger language plpgsql security definer set search_path = '' as $fn$
  begin
    update public.booking_requests br
       set estimated_total = coalesce((select sum(bri.price_per_person * bri.guest_count)
                                         from public.booking_request_items bri
                                        where bri.booking_request_id = br.id
                                          and bri.status in ('REQUESTED', 'CONFIRMED')), 0)
     where br.id = new.booking_request_id;
    return null;
  end $fn$;
  create trigger booking_request_items_sync_total
    after insert or update of status on public.booking_request_items
    for each row execute function public.booking_request_items_sync_total();

  -- ── guest transitions ──
  create function public.booking_item_withdraw(p_item_id uuid)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    update public.booking_request_items bri
       set status = 'WITHDRAWN'
     where bri.id = p_item_id
       and bri.status = 'REQUESTED'
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.user_id = v_uid);
    return found;
  end $fn$;

  create function public.booking_item_cancel_as_guest(p_item_id uuid, p_reason text, p_note text)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
    v_note text := nullif(btrim(p_note), '');
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    if p_reason is null or p_reason not in
       ('CHANGE_OF_PLANS', 'NO_LONGER_NEEDED', 'DATE_OR_TIME_NO_LONGER_WORKS', 'UNEXPECTED_CIRCUMSTANCES', 'OTHER') then
      raise exception 'Invalid cancellation reason' using errcode = '22023';
    end if;
    if char_length(v_note) > 500 then raise exception 'Note is too long' using errcode = '22023'; end if;
    update public.booking_request_items bri
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'guest',
           cancellation_reason = p_reason, cancellation_note = v_note
     where bri.id = p_item_id
       and bri.status = 'CONFIRMED'
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.user_id = v_uid);
    return found;
  end $fn$;

  create function public.booking_request_withdraw(p_request_id uuid)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    update public.booking_requests br
       set status = 'WITHDRAWN', updated_at = now()
     where br.id = p_request_id
       and br.user_id = v_uid
       and br.status in ('REQUESTED', 'CONFIRMED');
    if not found then return false; end if;
    -- Same transaction: no REQUESTED item is ever left behind under a withdrawn request.
    -- Decided items (CONFIRMED/DECLINED/CANCELLED) are history and keep their status.
    update public.booking_request_items bri
       set status = 'WITHDRAWN'
     where bri.booking_request_id = p_request_id
       and bri.status = 'REQUESTED';
    return true;
  end $fn$;

  -- ── host transitions (items of the caller's own experiences, request still active) ──
  create function public.booking_item_confirm(p_item_id uuid)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    update public.booking_request_items bri
       set status = 'CONFIRMED'
     where bri.id = p_item_id
       and bri.status = 'REQUESTED'
       and exists (select 1 from public.experiences e join public.providers p on p.id = e.provider_id
                    where e.id = bri.experience_id and p.user_id = v_uid)
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.status in ('REQUESTED', 'CONFIRMED'));
    return found;
  end $fn$;

  create function public.booking_item_decline(p_item_id uuid, p_reason text, p_note text)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    if p_reason is null or p_reason not in
       ('double_booking', 'no_longer_available', 'cannot_accommodate', 'unavailable_for_date', 'other') then
      raise exception 'Invalid decline reason' using errcode = '22023';
    end if;
    update public.booking_request_items bri
       set status = 'DECLINED', decline_reason = p_reason, decline_note = nullif(btrim(p_note), ''),
           decided_at = now()
     where bri.id = p_item_id
       and bri.status = 'REQUESTED'
       and exists (select 1 from public.experiences e join public.providers p on p.id = e.provider_id
                    where e.id = bri.experience_id and p.user_id = v_uid)
       and exists (select 1 from public.booking_requests br
                    where br.id = bri.booking_request_id and br.status in ('REQUESTED', 'CONFIRMED'));
    return found;
  end $fn$;

  create function public.booking_item_cancel_as_host(p_item_id uuid, p_reason text, p_note text)
  returns boolean language plpgsql security definer set search_path = '' as $fn$
  declare
    v_uid uuid := auth.uid();
    v_note text := nullif(btrim(p_note), '');
  begin
    if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    if p_reason is null or p_reason not in
       ('DATE_OR_TIME_NO_LONGER_WORKS', 'UNABLE_TO_PROVIDE_EXPERIENCE', 'UNEXPECTED_CIRCUMSTANCES', 'OTHER') then
      raise exception 'Invalid cancellation reason' using errcode = '22023';
    end if;
    if char_length(v_note) > 500 then raise exception 'Note is too long' using errcode = '22023'; end if;
    update public.booking_request_items bri
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'provider',
           cancellation_reason = p_reason, cancellation_note = v_note
     where bri.id = p_item_id
       and bri.status = 'CONFIRMED'
       and exists (select 1 from public.experiences e join public.providers p on p.id = e.provider_id
                    where e.id = bri.experience_id and p.user_id = v_uid);
    return found;
  end $fn$;

  -- ── function privileges: triggers callable by nobody; transitions by signed-in users only ──
  revoke execute on function public.booking_requests_before_insert() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_requests_before_update() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_request_items_before_insert() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_request_items_before_update() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_request_items_sync_total() from public, anon, authenticated, service_role;
  revoke execute on function public.booking_request_is_deletable(uuid) from public, anon, service_role;
  revoke execute on function public.booking_item_withdraw(uuid) from public, anon, service_role;
  revoke execute on function public.booking_item_cancel_as_guest(uuid, text, text) from public, anon, service_role;
  revoke execute on function public.booking_request_withdraw(uuid) from public, anon, service_role;
  revoke execute on function public.booking_item_confirm(uuid) from public, anon, service_role;
  revoke execute on function public.booking_item_decline(uuid, text, text) from public, anon, service_role;
  revoke execute on function public.booking_item_cancel_as_host(uuid, text, text) from public, anon, service_role;
  grant execute on function public.booking_request_is_deletable(uuid) to authenticated;
  grant execute on function public.booking_item_withdraw(uuid) to authenticated;
  grant execute on function public.booking_item_cancel_as_guest(uuid, text, text) to authenticated;
  grant execute on function public.booking_request_withdraw(uuid) to authenticated;
  grant execute on function public.booking_item_confirm(uuid) to authenticated;
  grant execute on function public.booking_item_decline(uuid, text, text) to authenticated;
  grant execute on function public.booking_item_cancel_as_host(uuid, text, text) to authenticated;

  -- ── data, once: estimated_total from the items (clients could previously write it) ──
  update public.booking_requests br
     set estimated_total = t.total
    from (select b.id, coalesce((select sum(bri.price_per_person * bri.guest_count)
                                   from public.booking_request_items bri
                                  where bri.booking_request_id = b.id
                                    and bri.status in ('REQUESTED', 'CONFIRMED')), 0) as total
            from public.booking_requests b) t
   where t.id = br.id and br.estimated_total is distinct from t.total;
  get diagnostics n = row_count;
  raise notice '0031: estimated_total recomputed on % booking request(s)', n;

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_requests') <> 4
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_requests'
          and cmd = 'UPDATE') <> 0
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_request_items') <> 3
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_request_items'
          and cmd in ('UPDATE', 'DELETE', 'ALL')) <> 0 then
    raise exception '0031 VERIFY FAILED: booking policies are not exactly as intended';
  end if;
  if has_table_privilege('authenticated', 'public.booking_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.booking_requests', 'INSERT')
     or not has_table_privilege('authenticated', 'public.booking_requests', 'DELETE')
     or has_table_privilege('authenticated', 'public.booking_request_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.booking_request_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.booking_request_items', 'DELETE')
     or has_table_privilege('anon', 'public.booking_requests', 'SELECT, INSERT, UPDATE, DELETE')
     or has_table_privilege('anon', 'public.booking_request_items', 'SELECT, INSERT, UPDATE, DELETE') then
    raise exception '0031 VERIFY FAILED: a table-level privilege on the booking tables is not as intended';
  end if;
  for r in select c.table_name::text as tbl, c.column_name::text as col from information_schema.columns c
           where c.table_schema = 'public' and c.table_name in ('booking_requests', 'booking_request_items') loop
    if has_column_privilege('authenticated', 'public.' || r.tbl, r.col, 'UPDATE')
       or has_column_privilege('anon', 'public.' || r.tbl, r.col, 'INSERT') then
      raise exception '0031 VERIFY FAILED: %.% is still writable', r.tbl, r.col;
    end if;
    if has_column_privilege('authenticated', 'public.' || r.tbl, r.col, 'INSERT')
       <> ((r.tbl = 'booking_requests' and r.col in ('user_id', 'stay_id'))
           or (r.tbl = 'booking_request_items' and r.col in ('booking_request_id', 'experience_id', 'planned_date',
                                                              'planned_moment', 'guest_count', 'preferred_time', 'host_note'))) then
      raise exception '0031 VERIFY FAILED: authenticated INSERT on %.% is not as intended', r.tbl, r.col;
    end if;
  end loop;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in (
        'booking_requests_before_insert', 'booking_requests_before_update', 'booking_request_items_before_insert',
        'booking_request_items_before_update', 'booking_request_items_sync_total')) <> 5 then
    raise exception '0031 VERIFY FAILED: a booking guard trigger is missing';
  end if;
  for r in select unnest(array['booking_item_withdraw(uuid)', 'booking_item_cancel_as_guest(uuid,text,text)',
                               'booking_request_withdraw(uuid)', 'booking_item_confirm(uuid)',
                               'booking_item_decline(uuid,text,text)', 'booking_item_cancel_as_host(uuid,text,text)',
                               'booking_request_is_deletable(uuid)']) as fn loop
    if not has_function_privilege('authenticated', 'public.' || r.fn, 'EXECUTE')
       or has_function_privilege('anon', 'public.' || r.fn, 'EXECUTE')
       or not (select p.prosecdef from pg_proc p where p.oid = ('public.' || r.fn)::regprocedure) then
      raise exception '0031 VERIFY FAILED: % is not a SECURITY DEFINER function executable by authenticated only', r.fn;
    end if;
  end loop;
  if exists (select 1 from public.booking_request_items bri
               join public.booking_requests br on br.id = bri.booking_request_id
              where br.status = 'WITHDRAWN' and bri.status = 'REQUESTED') then
    raise exception '0031 VERIFY FAILED: a REQUESTED item is still under a withdrawn request';
  end if;
end
$migration$;
