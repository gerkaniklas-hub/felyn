-- NOT A MIGRATION. Fail-closed isolated test for 0028_email_outbox.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (the outbox table, functions, triggers, the test
-- provider/experience copies, test booking requests and items, outbox rows),
-- releases every lock, and leaves the session idle. There is no code path that
-- finishes normally.
--
-- Run it BEFORE 0028 (it creates 0028's objects itself, then throws them away;
-- once 0028 is applied it fails at the first statement and should not be re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs: two accounts in auth.users, and one experience whose provider is
-- linked to an account (providers.user_id not null). It reads them only; the
-- test inserts its own booking request/items (and a copy of that provider
-- WITHOUT an account, plus a copy of the experience for it), all rolled back.
-- While it runs, the in-app notification triggers (0009/0020) also fire on the
-- test items; those notification rows are rolled back too.
--
-- What it checks:
--   G  grouping: one insert statement -> one guest event + one event per host
--   K  event keys and duplicate prevention (replay, re-transition, unique key)
--   T  transitions: confirm / decline / cancel by guest / cancel by provider,
--      and that irrelevant changes create nothing
--   P  payload privacy: no notes, no price for hosts, only allowed keys
--   M  missing provider account -> host event recorded as skipped
--   C  claim semantics: due rows only, no double claim, stale lease, limit
--   R  role privileges: anon/authenticated locked out, service_role select/update/claim only
--   F  a failing email trigger never blocks the booking change
--
-- Run it as role `postgres`, as the whole file, in one run.

do $test$
declare
  v_stage text := 'start';
  v_guest uuid; v_host uuid; v_prov uuid; v_exp uuid;
  v_prov_nouser uuid; v_exp_nouser uuid;
  v_req uuid;
  v_i1 uuid; v_i2 uuid; v_i3 uuid; v_i4 uuid; v_i5 uuid;
  v_payload jsonb;
  v_key text;
  n int; n2 int;
begin
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 1. 0028 BODY (section 2 of 0028_email_outbox.sql, verbatim) ═════════
    v_stage := 'migration';
    create table public.email_outbox (
      id uuid primary key default gen_random_uuid(),
      event_key text not null,
      event_type text not null,
      recipient_role text not null,
      recipient_user_id uuid references auth.users(id) on delete set null,
      booking_request_id uuid not null references public.booking_requests(id) on delete cascade,
      booking_request_item_ids uuid[] not null,
      payload jsonb not null default '{}'::jsonb,
      status text not null default 'pending',
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      claimed_at timestamptz,
      claim_token uuid,
      sent_at timestamptz,
      provider_message_id text,
      last_error text,
      skip_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint email_outbox_event_key_key unique (event_key),
      constraint email_outbox_event_key_check check (char_length(event_key) between 1 and 200),
      constraint email_outbox_event_type_check check (event_type in (
        'request_created_guest', 'request_created_host', 'request_confirmed_guest', 'request_declined_guest',
        'booking_cancelled_by_guest_host', 'booking_cancelled_by_host_guest', 'booking_cancelled_by_guest_guest',
        'booking_cancelled_by_host_host')),
      constraint email_outbox_recipient_role_check check (
        recipient_role = case when event_type like '%\_host' then 'host' else 'guest' end),
      constraint email_outbox_item_ids_check check (cardinality(booking_request_item_ids) >= 1),
      constraint email_outbox_payload_check check (jsonb_typeof(payload) = 'object'),
      constraint email_outbox_status_check check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
      constraint email_outbox_attempts_check check (attempts >= 0),
      constraint email_outbox_claim_check check ((status = 'sending') = (claim_token is not null and claimed_at is not null)),
      constraint email_outbox_sent_check check ((status = 'sent') = (sent_at is not null)),
      constraint email_outbox_skipped_check check ((status = 'skipped') = (skip_reason is not null)),
      constraint email_outbox_last_error_check check (last_error is null or char_length(last_error) <= 1000),
      constraint email_outbox_skip_reason_check check (skip_reason is null or char_length(skip_reason) <= 200),
      constraint email_outbox_provider_message_id_check check (provider_message_id is null or char_length(provider_message_id) <= 200)
    );
    create index email_outbox_due_idx on public.email_outbox (next_attempt_at) where status = 'pending';
    create index email_outbox_sending_idx on public.email_outbox (claimed_at) where status = 'sending';
    create index email_outbox_booking_request_id_idx on public.email_outbox (booking_request_id);
    create index email_outbox_recipient_user_id_idx on public.email_outbox (recipient_user_id);

    alter table public.email_outbox enable row level security;
    -- No policies: only service_role (which bypasses RLS) and the SECURITY DEFINER triggers reach rows.
    revoke all on public.email_outbox from public, anon, authenticated, service_role;
    grant select, update on public.email_outbox to service_role;

    -- Rendering snapshot. Only the fields an email may show (see the header). Price and
    -- currency only for guest recipients. Items in date / time-of-day order.
    create function public.email_outbox_payload(p_item_ids uuid[], p_recipient_role text)
    returns jsonb language sql stable set search_path = '' as $fn$
      select jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                   'title', e.title,
                   'planned_date', to_char(bri.planned_date, 'YYYY-MM-DD'),
                   'planned_moment', bri.planned_moment,
                   'preferred_time', to_char(bri.preferred_time, 'HH24:MI'),
                   'guest_count', bri.guest_count,
                   'price_per_person', case when p_recipient_role = 'guest' then bri.price_per_person end,
                   'currency', case when p_recipient_role = 'guest' then e.currency end,
                   'host_display_name', p.display_name))
                 order by bri.planned_date,
                          case bri.planned_moment when 'morning' then 1 when 'afternoon' then 2 else 3 end,
                          bri.id)
          from public.booking_request_items bri
          join public.experiences e on e.id = bri.experience_id
          join public.providers p on p.id = e.provider_id
          where bri.id = any(p_item_ids)), '[]'::jsonb),
        'guest_first_name', (
          select nullif(btrim(u.raw_user_meta_data->>'first_name'), '')
          from public.booking_request_items bri
          join public.booking_requests br on br.id = bri.booking_request_id
          join auth.users u on u.id = br.user_id
          where bri.id = p_item_ids[1]),
        'stay_town', (
          select l.name
          from public.booking_request_items bri
          join public.booking_requests br on br.id = bri.booking_request_id
          join public.stays s on s.id = br.stay_id
          join public.locations l on l.id = s.location_id
          where bri.id = p_item_ids[1]))
    $fn$;

    -- One outbox row; a NULL recipient (no account) is recorded as skipped. ON CONFLICT
    -- on the unique event_key makes every replay of the same event a no-op.
    create function public.email_outbox_enqueue(
      p_event_type text, p_recipient_role text, p_recipient_user_id uuid,
      p_booking_request_id uuid, p_item_ids uuid[], p_extra jsonb default '{}'::jsonb
    ) returns void language plpgsql set search_path = '' as $fn$
    begin
      insert into public.email_outbox (event_key, event_type, recipient_role, recipient_user_id, booking_request_id,
                                       booking_request_item_ids, payload, status, skip_reason)
      values (
        p_event_type || ':' || (select min(x::text) from unnest(p_item_ids) as x),
        p_event_type, p_recipient_role, p_recipient_user_id, p_booking_request_id, p_item_ids,
        public.email_outbox_payload(p_item_ids, p_recipient_role) || coalesce(p_extra, '{}'::jsonb),
        case when p_recipient_user_id is null then 'skipped' else 'pending' end,
        case when p_recipient_user_id is null then 'no_recipient_account' end)
      on conflict (event_key) do nothing;
    end
    $fn$;

    create function public.email_outbox_on_items_inserted()
    returns trigger language plpgsql security definer set search_path = '' as $fn$
    declare
      r record;
    begin
      begin
        for r in
          select ni.booking_request_id, br.user_id as recipient, array_agg(ni.id) as item_ids
          from new_items ni
          join public.booking_requests br on br.id = ni.booking_request_id
          where ni.status = 'REQUESTED'
          group by ni.booking_request_id, br.user_id
        loop
          perform public.email_outbox_enqueue('request_created_guest', 'guest', r.recipient, r.booking_request_id, r.item_ids);
        end loop;
        for r in
          select ni.booking_request_id, p.user_id as recipient, array_agg(ni.id) as item_ids
          from new_items ni
          join public.experiences e on e.id = ni.experience_id
          join public.providers p on p.id = e.provider_id
          where ni.status = 'REQUESTED'
          group by ni.booking_request_id, p.id, p.user_id
        loop
          perform public.email_outbox_enqueue('request_created_host', 'host', r.recipient, r.booking_request_id, r.item_ids);
        end loop;
      exception when others then
        raise warning 'email_outbox: request_created events not recorded (SQLSTATE %): %', sqlstate, sqlerrm;
      end;
      return null;
    end
    $fn$;

    create function public.email_outbox_on_item_status_change()
    returns trigger language plpgsql security definer set search_path = '' as $fn$
    declare
      v_guest uuid;
      v_host uuid;
      v_reason jsonb;
    begin
      if not ((old.status = 'REQUESTED' and new.status in ('CONFIRMED', 'DECLINED'))
              or (old.status = 'CONFIRMED' and new.status = 'CANCELLED' and new.cancelled_by in ('guest', 'provider'))) then
        return null;
      end if;
      begin
        select br.user_id into v_guest from public.booking_requests br where br.id = new.booking_request_id;
        if new.status = 'CONFIRMED' then
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

    create trigger email_outbox_items_inserted
      after insert on public.booking_request_items
      referencing new table as new_items
      for each statement execute function public.email_outbox_on_items_inserted();
    create trigger email_outbox_item_status_changed
      after update of status on public.booking_request_items
      for each row
      when (old.status is distinct from new.status)
      execute function public.email_outbox_on_item_status_change();

    create function public.claim_email_outbox(p_limit integer)
    returns setof public.email_outbox language plpgsql set search_path = '' as $fn$
    begin
      return query
      update public.email_outbox o
         set status = 'sending',
             claimed_at = now(),
             claim_token = gen_random_uuid(),
             attempts = o.attempts + 1,
             updated_at = now()
       where o.id in (
         select c.id from public.email_outbox c
         where (c.status = 'pending' and c.next_attempt_at <= now())
            or (c.status = 'sending' and c.claimed_at < now() - interval '10 minutes')
         order by c.next_attempt_at, c.created_at
         limit greatest(1, least(coalesce(p_limit, 10), 50))
         for update skip locked)
      returning o.*;
    end
    $fn$;

    revoke execute on function public.email_outbox_payload(uuid[], text) from public, anon, authenticated, service_role;
    revoke execute on function public.email_outbox_enqueue(text, text, uuid, uuid, uuid[], jsonb) from public, anon, authenticated, service_role;
    revoke execute on function public.email_outbox_on_items_inserted() from public, anon, authenticated, service_role;
    revoke execute on function public.email_outbox_on_item_status_change() from public, anon, authenticated, service_role;
    revoke execute on function public.claim_email_outbox(integer) from public, anon, authenticated, service_role;
    grant execute on function public.claim_email_outbox(integer) to service_role;

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    select e.id, p.id, p.user_id into v_exp, v_prov, v_host
    from public.experiences e join public.providers p on p.id = e.provider_id
    where p.user_id is not null
    order by e.created_at limit 1;
    if v_exp is null then raise exception 'SETUP: need one experience whose provider has an account'; end if;
    select u.id into v_guest from auth.users u where u.id <> v_host order by u.created_at limit 1;
    if v_guest is null then raise exception 'SETUP: need a second account in auth.users'; end if;

    -- A copy of the provider WITHOUT an account, and a copy of the experience for it.
    v_prov_nouser := gen_random_uuid();
    insert into public.providers
    select (jsonb_populate_record(null::public.providers,
              to_jsonb(p) || jsonb_build_object('id', v_prov_nouser, 'user_id', null))).*
    from public.providers p where p.id = v_prov;
    v_exp_nouser := gen_random_uuid();
    insert into public.experiences
    select (jsonb_populate_record(null::public.experiences,
              to_jsonb(e) || jsonb_build_object('id', v_exp_nouser, 'provider_id', v_prov_nouser))).*
    from public.experiences e where e.id = v_exp;

    -- ═════════ 3. GROUPING (G1-G6), as the signed-in guest ═════════
    v_stage := 'grouping (G1-G6)';
    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.booking_requests (user_id, stay_id, estimated_total) values (v_guest, null, 0) returning id into v_req;
    -- ONE statement, three items, two hosts (one with an account, one without).
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, preferred_time, host_note)
    values (v_req, v_exp, date '2030-06-01', 'morning', 2, 40, '10:30', 'FELYN-SECRET-HOST-NOTE'),
           (v_req, v_exp, date '2030-06-01', 'evening', 2, 40, null, null),
           (v_req, v_exp_nouser, date '2030-06-02', 'afternoon', 3, 25, null, null);
    reset role;
    select id into v_i1 from public.booking_request_items where booking_request_id = v_req and planned_moment = 'morning';
    select id into v_i2 from public.booking_request_items where booking_request_id = v_req and planned_moment = 'evening';
    select id into v_i3 from public.booking_request_items where booking_request_id = v_req and experience_id = v_exp_nouser;

    select count(*) into n from public.email_outbox where event_type = 'request_created_guest';
    if n <> 1 then raise exception 'G1 FAILED: % request_created_guest rows for one submission (expected 1)', n; end if;
    select count(*) into n from public.email_outbox
    where event_type = 'request_created_guest' and recipient_user_id = v_guest and recipient_role = 'guest'
      and status = 'pending' and cardinality(booking_request_item_ids) = 3 and booking_request_id = v_req
      and event_key = 'request_created_guest:' || least(v_i1::text, v_i2::text, v_i3::text);
    if n <> 1 then raise exception 'G2 FAILED: the guest event is not as expected (recipient/items/key)'; end if;
    select count(*) into n from public.email_outbox where event_type = 'request_created_host';
    if n <> 2 then raise exception 'G3 FAILED: % request_created_host rows (expected one per host = 2)', n; end if;
    select count(*) into n from public.email_outbox
    where event_type = 'request_created_host' and recipient_user_id = v_host and status = 'pending'
      and booking_request_item_ids @> array[v_i1, v_i2] and cardinality(booking_request_item_ids) = 2;
    if n <> 1 then raise exception 'G4 FAILED: the host event does not group that host''s two items'; end if;
    select payload into v_payload from public.email_outbox where event_type = 'request_created_guest';
    if jsonb_array_length(v_payload->'items') <> 3
       or v_payload->'items'->0->>'planned_moment' <> 'morning'
       or v_payload->'items'->0->>'preferred_time' <> '10:30'
       or (v_payload->'items'->0->>'guest_count')::int <> 2
       or v_payload->'items'->0->>'price_per_person' is null
       or v_payload->'items'->0->>'title' is null
       or v_payload->'items'->0->>'host_display_name' is null then
      raise exception 'G5 FAILED: guest payload items are not as expected: %', v_payload;
    end if;
    -- A second submission is a separate logical event.
    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp, date '2030-06-03', 'afternoon', 1, 40) returning id into v_i4;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp, date '2030-06-04', 'afternoon', 1, 40) returning id into v_i5;
    reset role;
    select count(*) into n from public.email_outbox where event_type = 'request_created_guest';
    select count(*) into n2 from public.email_outbox where event_type = 'request_created_host';
    if n <> 3 or n2 <> 4 then raise exception 'G6 FAILED: later submissions gave % guest / % host rows (expected 3 / 4)', n, n2; end if;

    -- ═════════ 4. PAYLOAD PRIVACY (P1-P4) ═════════
    v_stage := 'payload privacy (P1-P4)';
    if exists (select 1 from public.email_outbox where payload::text like '%FELYN-SECRET%') then
      raise exception 'P1 FAILED: a host_note reached an outbox payload';
    end if;
    if exists (select 1 from public.email_outbox o, jsonb_array_elements(o.payload->'items') it
               where o.recipient_role = 'host' and (it ? 'price_per_person' or it ? 'currency')) then
      raise exception 'P2 FAILED: a host payload contains price or currency';
    end if;
    if exists (select 1 from public.email_outbox o, jsonb_object_keys(o.payload) k
               where k not in ('items', 'guest_first_name', 'stay_town', 'cancellation_reason')) then
      raise exception 'P3 FAILED: a payload has a key outside the allowed set';
    end if;
    if exists (select 1 from public.email_outbox o, jsonb_array_elements(o.payload->'items') it, jsonb_object_keys(it) k
               where k not in ('title', 'planned_date', 'planned_moment', 'preferred_time', 'guest_count',
                               'price_per_person', 'currency', 'host_display_name')) then
      raise exception 'P4 FAILED: a payload item has a key outside the allowed set';
    end if;

    -- ═════════ 5. MISSING PROVIDER ACCOUNT (M1) ═════════
    v_stage := 'missing provider account (M1)';
    select count(*) into n from public.email_outbox
    where event_type = 'request_created_host' and recipient_user_id is null and status = 'skipped'
      and skip_reason = 'no_recipient_account' and booking_request_item_ids = array[v_i3];
    if n <> 1 then raise exception 'M1 FAILED: the host event for a provider without an account is not recorded as skipped'; end if;

    -- ═════════ 6. TRANSITIONS AND KEYS (T1-T9, K1-K3) ═════════
    v_stage := 'transitions (T1-T9, K1-K3)';
    select count(*) into n2 from public.email_outbox;
    -- irrelevant change: no status change
    update public.booking_request_items set guest_count = 3 where id = v_i1;
    -- confirm (as the host)
    perform set_config('request.jwt.claim.sub', v_host::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_host, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_i1 and status = 'REQUESTED';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'T1 FAILED: the host could not confirm (test setup)'; end if;
    update public.booking_request_items
       set status = 'DECLINED', decline_reason = 'other', decline_note = 'FELYN-SECRET-DECLINE-NOTE', decided_at = now()
     where id = v_i2 and status = 'REQUESTED';
    update public.booking_request_items set status = 'CONFIRMED' where id = v_i4 and status = 'REQUESTED';
    reset role;
    select count(*) into n from public.email_outbox
    where event_type = 'request_confirmed_guest' and event_key = 'request_confirmed_guest:' || v_i1
      and recipient_user_id = v_guest and status = 'pending';
    if n <> 1 then raise exception 'T2 FAILED: confirmation did not create exactly one request_confirmed_guest event'; end if;
    select count(*) into n from public.email_outbox
    where event_type = 'request_declined_guest' and event_key = 'request_declined_guest:' || v_i2 and recipient_user_id = v_guest;
    if n <> 1 then raise exception 'T3 FAILED: decline did not create exactly one request_declined_guest event'; end if;
    if exists (select 1 from public.email_outbox where payload::text like '%FELYN-SECRET%' or payload::text like '%decline%') then
      raise exception 'T4 FAILED: decline_note or decline data reached a payload';
    end if;
    if (select count(*) from public.email_outbox) <> n2 + 3 then
      raise exception 'T5 FAILED: expected exactly 3 new events (2 confirmations + 1 decline), got %', (select count(*) from public.email_outbox) - n2;
    end if;
    -- K1: re-transition of the same item (CONFIRMED -> REQUESTED -> CONFIRMED) is not a second event
    update public.booking_request_items set status = 'REQUESTED' where id = v_i1;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_i1;
    select count(*) into n from public.email_outbox where event_type = 'request_confirmed_guest' and booking_request_item_ids = array[v_i1];
    if n <> 1 then raise exception 'K1 FAILED: a repeated confirmation created % events', n; end if;
    -- K2: replaying an event through the enqueue helper is a no-op
    select count(*) into n2 from public.email_outbox;
    perform public.email_outbox_enqueue('request_created_guest', 'guest', v_guest, v_req, array[v_i1, v_i2, v_i3]);
    perform public.email_outbox_enqueue('request_confirmed_guest', 'guest', v_guest, v_req, array[v_i1]);
    if (select count(*) from public.email_outbox) <> n2 then raise exception 'K2 FAILED: a replayed event created a new row'; end if;
    -- K3: the unique key itself rejects a duplicate row
    begin
      insert into public.email_outbox (event_key, event_type, recipient_role, recipient_user_id, booking_request_id, booking_request_item_ids)
      values ('request_confirmed_guest:' || v_i1, 'request_confirmed_guest', 'guest', v_guest, v_req, array[v_i1]);
      raise exception 'K3 FAILED: a duplicate event_key was accepted';
    exception when unique_violation then null;
    end;
    -- cancel by the guest (CONFIRMED -> CANCELLED)
    select count(*) into n2 from public.email_outbox;
    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.booking_request_items
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'guest',
           cancellation_reason = 'CHANGE_OF_PLANS', cancellation_note = 'FELYN-SECRET-CANCEL-NOTE'
     where id = v_i1 and status = 'CONFIRMED';
    -- withdrawal is not an email event
    update public.booking_request_items set status = 'WITHDRAWN' where id = v_i5 and status = 'REQUESTED';
    reset role;
    if (select count(*) from public.email_outbox) <> n2 + 2 then
      raise exception 'T6 FAILED: guest cancellation + withdrawal created % events (expected 2)', (select count(*) from public.email_outbox) - n2;
    end if;
    select count(*) into n from public.email_outbox
    where booking_request_item_ids = array[v_i1]
      and ((event_type = 'booking_cancelled_by_guest_host' and recipient_role = 'host' and recipient_user_id = v_host)
        or (event_type = 'booking_cancelled_by_guest_guest' and recipient_role = 'guest' and recipient_user_id = v_guest))
      and payload->>'cancellation_reason' = 'CHANGE_OF_PLANS' and status = 'pending';
    if n <> 2 then raise exception 'T7 FAILED: guest cancellation events are not one host + one guest receipt with the reason'; end if;
    if exists (select 1 from public.email_outbox where payload::text like '%FELYN-SECRET%') then
      raise exception 'T8 FAILED: a cancellation_note reached a payload';
    end if;
    -- cancel by the provider (CONFIRMED -> CANCELLED)
    perform set_config('request.jwt.claim.sub', v_host::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_host, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.booking_request_items
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'provider', cancellation_reason = 'UNABLE_TO_PROVIDE_EXPERIENCE'
     where id = v_i4 and status = 'CONFIRMED';
    reset role;
    select count(*) into n from public.email_outbox where booking_request_item_ids = array[v_i4] and event_type like 'booking_cancelled%';
    select count(*) into n2 from public.email_outbox
    where booking_request_item_ids = array[v_i4] and payload->>'cancellation_reason' = 'UNABLE_TO_PROVIDE_EXPERIENCE' and status = 'pending'
      and ((event_type = 'booking_cancelled_by_host_guest' and recipient_role = 'guest' and recipient_user_id = v_guest)
        or (event_type = 'booking_cancelled_by_host_host' and recipient_role = 'host' and recipient_user_id = v_host));
    if n <> 2 or n2 <> 2 then
      raise exception 'T9 FAILED: provider cancellation must create exactly one booking_cancelled_by_host_guest and one booking_cancelled_by_host_host';
    end if;
    -- guest cancels the experience of the provider without an account: host event skipped, guest receipt pending
    update public.booking_request_items set status = 'CONFIRMED' where id = v_i3;
    update public.booking_request_items
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'guest', cancellation_reason = 'OTHER'
     where id = v_i3;
    if (select status from public.email_outbox where event_type = 'booking_cancelled_by_guest_host' and booking_request_item_ids = array[v_i3]) <> 'skipped'
       or (select status from public.email_outbox where event_type = 'booking_cancelled_by_guest_guest' and booking_request_item_ids = array[v_i3]) <> 'pending' then
      raise exception 'M2 FAILED: cancellation for a provider without an account is not skipped-host / pending-guest';
    end if;

    -- ═════════ 7. CLAIM SEMANTICS (C1-C6) ═════════
    v_stage := 'claim semantics (C1-C6)';
    select count(*) into n2 from public.email_outbox where status = 'pending';
    if n2 < 3 or n2 > 50 then raise exception 'C0: unexpected number of pending rows (%)', n2; end if;
    select count(*) into n from public.claim_email_outbox(1);
    if n <> 1 then raise exception 'C1 FAILED: claim(1) returned % rows', n; end if;
    select count(*), count(distinct claim_token) into n, n2 from public.claim_email_outbox(50);
    if n <> n2 or n <> (select count(*) from public.email_outbox where status = 'sending') - 1 then
      raise exception 'C2 FAILED: claim did not take every remaining due row exactly once with distinct tokens';
    end if;
    if exists (select 1 from public.email_outbox where status = 'skipped' and (claim_token is not null or attempts <> 0)) then
      raise exception 'C3 FAILED: a skipped row was claimed';
    end if;
    select count(*) into n from public.claim_email_outbox(50);
    if n <> 0 then raise exception 'C4 FAILED: rows already being sent were claimed again (% rows)', n; end if;
    -- a stale lease (crashed sender) is reclaimed with a new token and a second attempt
    select event_key into v_key from public.email_outbox where status = 'sending' order by event_key limit 1;
    update public.email_outbox set claimed_at = now() - interval '11 minutes' where event_key = v_key;
    select count(*) into n from public.claim_email_outbox(50) c where c.event_key = v_key and c.attempts = 2;
    if n <> 1 or (select count(*) from public.claim_email_outbox(50)) <> 0 then
      raise exception 'C5 FAILED: a stale lease was not reclaimed exactly once';
    end if;
    -- a row waiting for its retry time is not claimed early; once due it is
    update public.email_outbox
       set status = 'pending', claim_token = null, claimed_at = null, next_attempt_at = now() + interval '5 minutes'
     where event_key = v_key;
    select count(*) into n from public.claim_email_outbox(50);
    update public.email_outbox set next_attempt_at = now() - interval '1 second' where event_key = v_key;
    select count(*) into n2 from public.claim_email_outbox(50);
    if n <> 0 or n2 <> 1 then raise exception 'C6 FAILED: retry timing not respected (early %, due %)', n, n2; end if;

    -- ═════════ 8. ROLE PRIVILEGES (R1-R7) ═════════
    v_stage := 'role privileges (R1-R7)';
    set local role anon;
    begin
      select count(*) into n from public.email_outbox;
      raise exception 'R1 FAILED: anon can read email_outbox';
    exception when insufficient_privilege then null;
    end;
    reset role;
    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      select count(*) into n from public.email_outbox;
      raise exception 'R2 FAILED: a signed-in user can read email_outbox';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.email_outbox set status = 'sent', sent_at = now();
      raise exception 'R3 FAILED: a signed-in user can update email_outbox';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.claim_email_outbox(1);
      raise exception 'R4 FAILED: a signed-in user can claim outbox rows';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.email_outbox_enqueue('request_confirmed_guest', 'guest', v_guest, v_req, array[v_i2]);
      raise exception 'R5 FAILED: a signed-in user can enqueue events';
    exception when insufficient_privilege then null;
    end;
    reset role;
    set local role service_role;
    select count(*) into n from public.email_outbox;
    if n = 0 then raise exception 'R6 FAILED: service_role cannot see outbox rows'; end if;
    perform public.claim_email_outbox(1);
    begin
      insert into public.email_outbox (event_key, event_type, recipient_role, recipient_user_id, booking_request_id, booking_request_item_ids)
      values ('request_confirmed_guest:' || v_i2, 'request_confirmed_guest', 'guest', v_guest, v_req, array[v_i2]);
      raise exception 'R7 FAILED: service_role can insert outbox rows';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 9. EMAIL FAILURE NEVER BLOCKS THE BOOKING (F1-F2) ═════════
    v_stage := 'failure isolation (F1-F2)';
    -- Make every new outbox row invalid, then insert and confirm items: the booking
    -- changes must succeed and no event is recorded.
    alter table public.email_outbox add constraint felyn_test_block check (event_type = 'none') not valid;
    select count(*) into n2 from public.email_outbox;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp, date '2030-06-05', 'morning', 1, 40) returning id into v_i5;
    update public.booking_request_items set status = 'CONFIRMED' where id = v_i5;
    if (select status from public.booking_request_items where id = v_i5) <> 'CONFIRMED' then
      raise exception 'F1 FAILED: the booking change did not persist when the email trigger failed';
    end if;
    if (select count(*) from public.email_outbox) <> n2 then
      raise exception 'F2 FAILED: an event was recorded despite the blocking constraint';
    end if;
    alter table public.email_outbox drop constraint felyn_test_block;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
