-- NOT A MIGRATION. Fail-closed isolated test for 0031_booking_write_hardening.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0031's policies, grants, functions, triggers and
-- data fixes, and every test row), releases every lock, and leaves the session
-- idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0031 (it applies 0031's body itself, then throws it away; once
-- 0031 is applied it fails at the first statement and should not be re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs four existing accounts in auth.users. Where an account needs a host
-- profile, experiences or bookings, the test creates them — rolled back like
-- everything else. The real checks run as the `anon` / `authenticated` roles with
-- a signed-in user's claims, so row-level security and column privileges are
-- genuinely enforced. Database-side triggers (in-app notifications, and the email
-- outbox if 0028 is applied) fire as usual; their rows are rolled back too.
--
-- Accounts:  A = host of experiences EA / EA2 (unpublished)   B = host of experience EB
--            G1 = guest (requests R1, R3, R4)                  G2 = another guest (request R2)
--
-- What it checks:
--   1  anon can neither read nor write either booking table
--   2  G1 creates a request: status REQUESTED, estimated_total starts at 0; G1 cannot
--      send estimated_total or status
--   3  G1 adds items: price_per_person always comes from the experience and the total
--      follows; G1 cannot send price_per_person or status; guest_count outside the
--      experience's group size, an unpublished experience, someone else's request and
--      a withdrawn request are all refused
--   4  G1 cannot UPDATE any item column (price, guest count, date, moment, preferred
--      time, note, status, completion, decision or cancellation fields, experience,
--      request) nor any request column (estimated_total, status, user_id, stay_id),
--      and cannot DELETE an item
--   5  G1 cannot use the host transitions on their own items
--   6  host A cannot UPDATE any item column directly
--   7  host A confirms and declines their own REQUESTED items (decision fields set by
--      the database); a second decision is refused; an invalid reason is refused
--   8  host A cannot confirm, decline or cancel host B's items, and cannot use the
--      guest transitions on items of their own experiences
--   9  host A cancels their own CONFIRMED item; a REQUESTED item can't be cancelled
--  10  G1 withdraws their own REQUESTED item (once); cannot withdraw a CONFIRMED item;
--      cannot withdraw G2's item; estimated_total follows
--  11  G1 cancels their own CONFIRMED item; cannot cancel a DECLINED item or G2's item
--  12  whole-request withdrawal: G2 cannot withdraw G1's request; G1's withdrawal sets
--      the request and every REQUESTED item to WITHDRAWN atomically, keeps CONFIRMED
--      and DECLINED items, leaves no REQUESTED item behind, and can't be repeated
--  13  deleting requests: only the guest's own, and only with no REQUESTED, CONFIRMED
--      or DECLINED item
--  14  transition guard (as postgres, i.e. even past RLS): every invalid status move,
--      every change to the booking details, out-of-turn decision/cancellation/
--      completion writes and request owner/status changes are refused; the
--      completion job's write still works
--  15  data: the legacy REQUESTED item under a withdrawn request is now WITHDRAWN, and
--      every estimated_total matches its items

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g1 uuid; v_g2 uuid;
  v_a_provider uuid; v_b_provider uuid;
  v_ea uuid; v_ea2 uuid; v_eb uuid;
  v_legacy_req uuid; v_legacy_item uuid;
  v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid;
  v_i1 uuid; v_i2 uuid; v_i3 uuid; v_i4 uuid;
  v_j1 uuid; v_j2 uuid;
  v_k1 uuid; v_k2 uuid; v_k3 uuid; v_k4 uuid;
  v_m1 uuid;
  v_ok boolean;
  v_status text; v_total numeric; v_price numeric;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. ACCOUNTS, HOSTS, EXPERIENCES AND A LEGACY ROW (before 0031) ═════════
    v_stage := 'accounts';
    select u.id into v_a from auth.users u order by u.created_at limit 1;
    select u.id into v_b from auth.users u where u.id <> v_a order by u.created_at limit 1;
    select u.id into v_g1 from auth.users u where u.id not in (v_a, v_b) order by u.created_at limit 1;
    select u.id into v_g2 from auth.users u where u.id not in (v_a, v_b, v_g1) order by u.created_at limit 1;
    if v_a is null or v_b is null or v_g1 is null or v_g2 is null then
      raise exception 'SETUP: need four accounts in auth.users';
    end if;
    select p.id into v_a_provider from public.providers p where p.user_id = v_a;
    if v_a_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_a, 'BOOKING TEST HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'BOOKING TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'BOOKING TEST EA (rolled back)', 'food', 40, 1, 6, 120, true) returning id into v_ea;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'BOOKING TEST EA2 unpublished (rolled back)', 'food', 30, 1, 6, 120, false) returning id into v_ea2;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_b_provider, 'BOOKING TEST EB (rolled back)', 'drink', 55, 1, 4, 90, true) returning id into v_eb;

    -- What the old whole-request withdrawal left behind: a REQUESTED item under a WITHDRAWN request.
    insert into public.booking_requests (user_id, stay_id, estimated_total) values (v_g1, null, 999) returning id into v_legacy_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_legacy_req, v_ea, current_date + 30, 'evening', 2, 40) returning id into v_legacy_item;
    update public.booking_requests set status = 'WITHDRAWN' where id = v_legacy_req;

    -- ═════════ 1. 0031 BODY (verbatim from 0031_booking_write_hardening.sql, section 2) ═════════
    v_stage := 'migration';
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

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    -- G2's request (created through the real triggers): j1 on B's experience, j2 on A's.
    insert into public.booking_requests (user_id, stay_id) values (v_g2, null) returning id into v_r2;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r2, v_eb, current_date + 20, 'evening', 2) returning id into v_j1;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r2, v_ea, current_date + 21, 'morning', 1) returning id into v_j2;

    -- ═════════ 3. ANON (check 1) ═════════
    v_stage := '1 anon';
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    set local role anon;
    for r in select unnest(array[
               'select count(*) from public.booking_requests',
               'select count(*) from public.booking_request_items',
               'insert into public.booking_requests (user_id) values (gen_random_uuid())',
               'update public.booking_request_items set guest_count = 1',
               'delete from public.booking_requests']) as stmt loop
      begin
        execute r.stmt;
        raise exception '1 FAILED: anon could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
    reset role;

    -- ═════════ 4. GUEST G1 CREATES (checks 2, 3) ═════════
    v_stage := '2 create request';
    perform set_config('request.jwt.claim.sub', v_g1::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g1, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g1 then raise exception 'IMPERSONATION FAILED (G1): auth.uid() = %', auth.uid(); end if;

    insert into public.booking_requests (user_id, stay_id) values (v_g1, null) returning id, status, estimated_total into v_r1, v_status, v_total;
    if v_status <> 'REQUESTED' or v_total <> 0 then
      raise exception '2 FAILED: a new request is % with total %', v_status, v_total;
    end if;
    for r in select unnest(array[
               'insert into public.booking_requests (user_id, stay_id, estimated_total) values ($1, null, 1)',
               'insert into public.booking_requests (user_id, stay_id, status) values ($1, null, ''CONFIRMED'')']) as stmt loop
      begin
        execute r.stmt using v_g1;
        raise exception '2 FAILED: G1 could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;

    v_stage := '3 add items';
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, preferred_time)
    values (v_r1, v_ea, current_date + 10, 'evening', 2, '19:00') returning id, price_per_person into v_i1, v_price;
    if v_price <> 40 then raise exception '3 FAILED: price_per_person is % instead of the experience''s 40', v_price; end if;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r1, v_ea, current_date + 11, 'evening', 1) returning id into v_i2;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r1, v_ea, current_date + 12, 'evening', 3) returning id into v_i3;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r1, v_ea, current_date + 13, 'evening', 2) returning id into v_i4;
    select br.estimated_total into v_total from public.booking_requests br where br.id = v_r1;
    if v_total <> 320 then raise exception '3 FAILED: estimated_total is % instead of 320 (40 x 8)', v_total; end if;
    for r in select unnest(array[
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person) values ($1, $2, current_date + 14, ''evening'', 2, 0.01)',
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, status) values ($1, $2, current_date + 14, ''evening'', 2, ''CONFIRMED'')',
               'insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, completed_at) values ($1, $2, current_date + 14, ''evening'', 2, now())']) as stmt loop
      begin
        execute r.stmt using v_r1, v_ea;
        raise exception '3 FAILED: G1 could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
    for r in select * from (values
               (v_r1, v_ea, 7, 'a guest_count above max_guests'),
               (v_r1, v_ea, 0, 'a guest_count below min_guests'),
               (v_r1, v_ea2, 2, 'an unpublished experience'),
               (v_legacy_req, v_ea, 2, 'a withdrawn request')) as t(req, exp, guests, what) loop
      begin
        insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
        values (r.req, r.exp, current_date + 15, 'evening', r.guests);
        raise exception '3 FAILED: G1 could add an item for %', r.what;
      exception when invalid_parameter_value or check_violation then null;
      end;
    end loop;
    begin
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
      values (v_r2, v_ea, current_date + 15, 'evening', 2);
      raise exception '3 FAILED: G1 added an item to G2''s request';
    exception when insufficient_privilege then null;
    end;

    -- ═════════ 5. GUEST G1 CANNOT WRITE DIRECTLY (checks 4, 5) ═════════
    v_stage := '4 guest direct writes';
    for r in select unnest(array[
               'update public.booking_request_items set price_per_person = 0.01 where id = $1',
               'update public.booking_request_items set guest_count = 1 where id = $1',
               'update public.booking_request_items set planned_date = current_date + 50 where id = $1',
               'update public.booking_request_items set planned_moment = ''morning'' where id = $1',
               'update public.booking_request_items set preferred_time = ''20:00'' where id = $1',
               'update public.booking_request_items set host_note = ''changed'' where id = $1',
               'update public.booking_request_items set status = ''CONFIRMED'' where id = $1',
               'update public.booking_request_items set completed_at = now() where id = $1',
               'update public.booking_request_items set decided_at = now() where id = $1',
               'update public.booking_request_items set decline_reason = ''other'' where id = $1',
               'update public.booking_request_items set cancelled_at = now(), cancelled_by = ''guest'' where id = $1',
               'update public.booking_request_items set experience_id = gen_random_uuid() where id = $1',
               'update public.booking_request_items set booking_request_id = gen_random_uuid() where id = $1',
               'delete from public.booking_request_items where id = $1']) as stmt loop
      begin
        execute r.stmt using v_i1;
        raise exception '4 FAILED: G1 could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
    for r in select unnest(array[
               'update public.booking_requests set estimated_total = 1 where id = $1',
               'update public.booking_requests set status = ''CONFIRMED'' where id = $1',
               'update public.booking_requests set user_id = gen_random_uuid() where id = $1',
               'update public.booking_requests set stay_id = null where id = $1']) as stmt loop
      begin
        execute r.stmt using v_r1;
        raise exception '4 FAILED: G1 could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;

    v_stage := '5 guest uses host transitions';
    if public.booking_item_confirm(v_i1) or public.booking_item_decline(v_i1, 'other', null)
       or public.booking_item_cancel_as_host(v_i1, 'OTHER', null) then
      raise exception '5 FAILED: G1 used a host transition on their own item';
    end if;
    reset role;

    -- ═════════ 6. HOST A (checks 6, 7, 8, 9) ═════════
    v_stage := '6 host direct writes';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_a then raise exception 'IMPERSONATION FAILED (A): auth.uid() = %', auth.uid(); end if;
    for r in select unnest(array[
               'update public.booking_request_items set price_per_person = 999 where id = $1',
               'update public.booking_request_items set guest_count = 6 where id = $1',
               'update public.booking_request_items set planned_date = current_date + 50 where id = $1',
               'update public.booking_request_items set preferred_time = ''21:00'' where id = $1',
               'update public.booking_request_items set status = ''CONFIRMED'' where id = $1',
               'update public.booking_request_items set cancelled_at = now(), cancelled_by = ''provider'' where id = $1',
               'delete from public.booking_request_items where id = $1']) as stmt loop
      begin
        execute r.stmt using v_i1;
        raise exception '6 FAILED: host A could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;

    v_stage := '7 host decisions';
    if not public.booking_item_confirm(v_i1) then raise exception '7 FAILED: host A cannot confirm their own item'; end if;
    if public.booking_item_confirm(v_i1) then raise exception '7 FAILED: an item was confirmed twice'; end if;
    if not public.booking_item_decline(v_i2, 'double_booking', '  busy that night  ') then
      raise exception '7 FAILED: host A cannot decline their own item';
    end if;
    if public.booking_item_confirm(v_i2) or public.booking_item_decline(v_i2, 'other', null) then
      raise exception '7 FAILED: a declined item was decided again';
    end if;
    begin
      perform public.booking_item_decline(v_i4, 'not_a_reason', null);
      raise exception '7 FAILED: an invalid decline reason was accepted';
    exception when invalid_parameter_value then null;
    end;
    if not public.booking_item_confirm(v_i4) then raise exception '7 FAILED: host A cannot confirm i4'; end if;

    v_stage := '8 other host';
    if public.booking_item_confirm(v_j1) or public.booking_item_decline(v_j1, 'other', null) then
      raise exception '8 FAILED: host A decided host B''s item';
    end if;
    if public.booking_item_withdraw(v_j2) or public.booking_item_cancel_as_guest(v_i4, 'OTHER', '')
       or public.booking_request_withdraw(v_r1) then
      raise exception '8 FAILED: host A used a guest transition';
    end if;

    v_stage := '9 host cancels';
    if public.booking_item_cancel_as_host(v_j2, 'OTHER', null) then
      raise exception '9 FAILED: host A cancelled a REQUESTED item';
    end if;
    if not public.booking_item_cancel_as_host(v_i4, 'UNABLE_TO_PROVIDE_EXPERIENCE', ' sorry ') then
      raise exception '9 FAILED: host A cannot cancel their own CONFIRMED item';
    end if;
    reset role;

    -- Host B confirms their own j1 (so host A's cancel attempt below has a CONFIRMED target).
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_j1) then raise exception '8 FAILED: host B cannot confirm their own item'; end if;
    if public.booking_item_confirm(v_i1) or public.booking_item_decline(v_j2, 'other', null) then
      raise exception '8 FAILED: host B decided host A''s item';
    end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.booking_item_cancel_as_host(v_j1, 'OTHER', null) then
      raise exception '8 FAILED: host A cancelled host B''s item';
    end if;
    reset role;

    v_stage := '7-9 results';
    select count(*) into n from public.booking_request_items bri
     where (bri.id = v_i1 and bri.status = 'CONFIRMED' and bri.decided_at is null)
        or (bri.id = v_i2 and bri.status = 'DECLINED' and bri.decided_at is not null
            and bri.decline_reason = 'double_booking' and bri.decline_note = 'busy that night')
        or (bri.id = v_i4 and bri.status = 'CANCELLED' and bri.cancelled_by = 'provider' and bri.cancelled_at is not null
            and bri.cancellation_reason = 'UNABLE_TO_PROVIDE_EXPERIENCE' and bri.cancellation_note = 'sorry')
        or (bri.id = v_j1 and bri.status = 'CONFIRMED')
        or (bri.id = v_j2 and bri.status = 'REQUESTED');
    if n <> 5 then raise exception '7-9 FAILED: only % of 5 items are in the expected state', n; end if;
    select br.estimated_total into v_total from public.booking_requests br where br.id = v_r1;
    if v_total <> 200 then raise exception '9 FAILED: R1 total is % instead of 200 (i1 2 + i3 3 guests x 40)', v_total; end if;

    -- ═════════ 7. GUEST G1 TRANSITIONS (checks 10, 11) ═════════
    v_stage := '10 guest withdraws';
    perform set_config('request.jwt.claim.sub', v_g1::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g1, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_withdraw(v_i3) then raise exception '10 FAILED: G1 cannot withdraw their own item'; end if;
    if public.booking_item_withdraw(v_i3) then raise exception '10 FAILED: an item was withdrawn twice'; end if;
    if public.booking_item_withdraw(v_i1) then raise exception '10 FAILED: G1 withdrew a CONFIRMED item'; end if;
    if public.booking_item_withdraw(v_j2) then raise exception '10 FAILED: G1 withdrew G2''s item'; end if;
    select br.estimated_total into v_total from public.booking_requests br where br.id = v_r1;
    if v_total <> 80 then raise exception '10 FAILED: R1 total is % instead of 80 after the withdrawal', v_total; end if;

    v_stage := '11 guest cancels';
    begin
      perform public.booking_item_cancel_as_guest(v_i1, 'UNABLE_TO_PROVIDE_EXPERIENCE', null);
      raise exception '11 FAILED: G1 used a host-only cancellation reason';
    exception when invalid_parameter_value then null;
    end;
    if public.booking_item_cancel_as_guest(v_i2, 'OTHER', '') then raise exception '11 FAILED: G1 cancelled a DECLINED item'; end if;
    if public.booking_item_cancel_as_guest(v_j1, 'OTHER', '') then raise exception '11 FAILED: G1 cancelled G2''s item'; end if;
    if not public.booking_item_cancel_as_guest(v_i1, 'CHANGE_OF_PLANS', '') then
      raise exception '11 FAILED: G1 cannot cancel their own CONFIRMED item';
    end if;
    select count(*) into n from public.booking_request_items bri
     where bri.id = v_i1 and bri.status = 'CANCELLED' and bri.cancelled_by = 'guest'
       and bri.cancellation_reason = 'CHANGE_OF_PLANS' and bri.cancellation_note is null;
    if n <> 1 then raise exception '11 FAILED: i1 is not cancelled by the guest as expected'; end if;
    select br.estimated_total into v_total from public.booking_requests br where br.id = v_r1;
    if v_total <> 0 then raise exception '11 FAILED: R1 total is % instead of 0', v_total; end if;
    reset role;
    select count(*) into n from public.booking_request_items bri where bri.id = v_j2 and bri.status = 'REQUESTED';
    if n <> 1 then raise exception '10 FAILED: G2''s item changed'; end if;

    -- ═════════ 8. WHOLE-REQUEST WITHDRAWAL (check 12) ═════════
    v_stage := '12 setup';
    perform set_config('request.jwt.claim.sub', v_g1::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g1, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.booking_requests (user_id, stay_id) values (v_g1, null) returning id into v_r3;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r3, v_ea, current_date + 40, 'morning', 1) returning id into v_k1;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r3, v_ea, current_date + 40, 'afternoon', 1) returning id into v_k2;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r3, v_eb, current_date + 40, 'evening', 1) returning id into v_k3;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r3, v_ea, current_date + 41, 'evening', 1) returning id into v_k4;
    reset role;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_item_confirm(v_k2) or not public.booking_item_decline(v_k4, 'other', null) then
      raise exception '12 FAILED: host A cannot decide R3''s items';
    end if;
    reset role;

    v_stage := '12 withdraw request';
    perform set_config('request.jwt.claim.sub', v_g2::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g2, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.booking_request_withdraw(v_r3) then raise exception '12 FAILED: G2 withdrew G1''s request'; end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_g1::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g1, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.booking_request_withdraw(v_r3) then raise exception '12 FAILED: G1 cannot withdraw their own request'; end if;
    if public.booking_request_withdraw(v_r3) then raise exception '12 FAILED: a request was withdrawn twice'; end if;
    reset role;
    select count(*) into n from public.booking_request_items bri
     where (bri.id = v_k1 and bri.status = 'WITHDRAWN') or (bri.id = v_k2 and bri.status = 'CONFIRMED')
        or (bri.id = v_k3 and bri.status = 'WITHDRAWN') or (bri.id = v_k4 and bri.status = 'DECLINED');
    if n <> 4 then raise exception '12 FAILED: only % of R3''s 4 items are in the expected state', n; end if;
    select count(*) into n from public.booking_request_items bri where bri.booking_request_id = v_r3 and bri.status = 'REQUESTED';
    if n <> 0 then raise exception '12 FAILED: % REQUESTED item(s) left under the withdrawn request', n; end if;
    select br.status, br.estimated_total into v_status, v_total from public.booking_requests br where br.id = v_r3;
    if v_status <> 'WITHDRAWN' or v_total <> 40 then
      raise exception '12 FAILED: R3 is % with total % (expected WITHDRAWN, 40 for the CONFIRMED item)', v_status, v_total;
    end if;
    select count(*) into n from public.booking_requests br where br.id = v_r2 and br.status = 'REQUESTED';
    if n <> 1 then raise exception '12 FAILED: G2''s request changed'; end if;

    -- ═════════ 9. DELETING REQUESTS (check 13) ═════════
    v_stage := '13 delete';
    perform set_config('request.jwt.claim.sub', v_g1::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g1, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.booking_requests (user_id, stay_id) values (v_g1, null) returning id into v_r4;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count)
    values (v_r4, v_ea, current_date + 45, 'evening', 1) returning id into v_m1;
    delete from public.booking_requests where id = v_r4;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '13 FAILED: a request with a REQUESTED item was deleted'; end if;
    delete from public.booking_requests where id = v_r3;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '13 FAILED: a request with CONFIRMED/DECLINED items was deleted'; end if;
    delete from public.booking_requests where id = v_r2;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '13 FAILED: G1 deleted G2''s request'; end if;
    if not public.booking_item_withdraw(v_m1) then raise exception '13 FAILED: G1 cannot withdraw m1'; end if;
    delete from public.booking_requests where id = v_r4;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '13 FAILED: G1 cannot delete their own request whose items are all withdrawn'; end if;
    reset role;

    -- ═════════ 10. TRANSITION GUARD, AS POSTGRES (check 14) ═════════
    v_stage := '14 guard';
    for r in select * from (values
               ('update public.booking_request_items set status = ''CONFIRMED'' where id = $1', v_i2, 'DECLINED -> CONFIRMED'),
               ('update public.booking_request_items set status = ''REQUESTED'' where id = $1', v_i3, 'WITHDRAWN -> REQUESTED'),
               ('update public.booking_request_items set status = ''CONFIRMED'' where id = $1', v_i1, 'CANCELLED -> CONFIRMED'),
               ('update public.booking_request_items set status = ''CANCELLED'', cancelled_at = now(), cancelled_by = ''guest'', cancellation_reason = ''OTHER'' where id = $1', v_j2, 'REQUESTED -> CANCELLED'),
               ('update public.booking_request_items set status = ''WITHDRAWN'' where id = $1', v_j1, 'CONFIRMED -> WITHDRAWN'),
               ('update public.booking_request_items set status = ''DECLINED'' where id = $1', v_j1, 'CONFIRMED -> DECLINED'),
               ('update public.booking_request_items set price_per_person = 0.01 where id = $1', v_j2, 'a price change'),
               ('update public.booking_request_items set guest_count = 3 where id = $1', v_j2, 'a guest count change'),
               ('update public.booking_request_items set planned_date = planned_date + 1 where id = $1', v_j2, 'a date change'),
               ('update public.booking_request_items set planned_moment = ''evening'' where id = $1', v_j2, 'a moment change'),
               ('update public.booking_request_items set preferred_time = ''09:00'' where id = $1', v_j2, 'a preferred time change'),
               ('update public.booking_request_items set experience_id = $1 where id = $1', v_j2, 'an experience change'),
               ('update public.booking_request_items set completed_at = now() where id = $1', v_j2, 'completing a REQUESTED item'),
               ('update public.booking_request_items set decided_at = now() where id = $1', v_j1, 'decided_at on a CONFIRMED item'),
               ('update public.booking_request_items set decline_note = ''x'' where id = $1', v_i2, 'editing a decline afterwards'),
               ('update public.booking_request_items set cancellation_note = ''x'' where id = $1', v_i1, 'editing a cancellation afterwards'),
               ('update public.booking_requests set status = ''CONFIRMED'' where id = $1', v_r2, 'request REQUESTED -> CONFIRMED'),
               ('update public.booking_requests set status = ''REQUESTED'' where id = $1', v_r3, 'request WITHDRAWN -> REQUESTED'),
               ('update public.booking_requests set user_id = gen_random_uuid() where id = $1', v_r2, 'a request owner change')
             ) as t(stmt, target, what) loop
      begin
        execute r.stmt using r.target;
        raise exception '14 FAILED: the guard allowed %', r.what;
      exception when check_violation then null;
      end;
    end loop;
    begin
      insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, status)
      values (v_r2, v_eb, current_date + 22, 'evening', 1, 'CONFIRMED');
      raise exception '14 FAILED: an item was inserted as CONFIRMED';
    exception when check_violation then null;
    end;
    begin
      insert into public.booking_requests (user_id, stay_id, status) values (v_g1, null, 'CONFIRMED');
      raise exception '14 FAILED: a request was inserted as CONFIRMED';
    exception when check_violation then null;
    end;
    -- The 0016 completion job's write (completed_at on a CONFIRMED item) still works.
    update public.booking_request_items set completed_at = now() where id = v_j1;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '14 FAILED: completing a CONFIRMED item was refused'; end if;
    begin
      update public.booking_request_items set completed_at = now() - interval '1 day' where id = v_j1;
      raise exception '14 FAILED: completed_at was changed after being set';
    exception when check_violation then null;
    end;

    -- ═════════ 11. DATA (check 15) ═════════
    v_stage := '15 data';
    select bri.status into v_status from public.booking_request_items bri where bri.id = v_legacy_item;
    if v_status <> 'WITHDRAWN' then raise exception '15 FAILED: the legacy item is % instead of WITHDRAWN', v_status; end if;
    select br.estimated_total into v_total from public.booking_requests br where br.id = v_legacy_req;
    if v_total <> 0 then raise exception '15 FAILED: the legacy request total is % instead of 0', v_total; end if;
    select count(*) into n from public.booking_requests br
     where br.estimated_total is distinct from coalesce((select sum(bri.price_per_person * bri.guest_count)
                                                          from public.booking_request_items bri
                                                         where bri.booking_request_id = br.id
                                                           and bri.status in ('REQUESTED', 'CONFIRMED')), 0);
    if n <> 0 then raise exception '15 FAILED: % request(s) have an estimated_total that does not match their items', n; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
