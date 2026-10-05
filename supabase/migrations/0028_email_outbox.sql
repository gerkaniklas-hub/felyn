-- 0028: public.email_outbox — database-generated transactional email events
--
-- ONE SQL statement (a single DO block), same form as 0023-0027: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: Felyn sends transactional emails for the experience request lifecycle. An
-- email must never go out before the booking change it describes has committed, must
-- never be sent twice for the same event, and must never block or undo a booking when
-- the email provider is unavailable. The database therefore records each email as an
-- outbox row IN THE SAME TRANSACTION as the booking change (the same trigger pattern
-- 0009/0020 use for in-app notifications), and the app's server-only sender delivers
-- the rows afterwards, retrying when delivery fails.
--
-- What it does:
--   * creates public.email_outbox, one row per (event, recipient):
--       - event_key: UNIQUE identity of the event — "<event_type>:<booking item id>"
--         (for a grouped request, the smallest item id in the group). A repeated or
--         replayed transition can never create a second row.
--       - event_type: one of eight events (see the CHECK below); recipient_role is
--         derived from the event name's suffix and checked to match.
--       - recipient_user_id: a reference to the recipient's account. The email
--         ADDRESS is never stored here; the sender resolves it at send time.
--         NULL when there is no account (a provider without a user): such a row is
--         created as 'skipped' with skip_reason 'no_recipient_account'.
--       - booking_request_id / booking_request_item_ids: the booking rows the event
--         is about (deleted with the request).
--       - payload: a minimal snapshot for rendering — experience title, date, time of
--         day, preferred time, guest count, host display name, guest first name, the
--         stay's town, the structured cancellation reason, and (guest emails only)
--         price and currency. Never phone numbers, email addresses, addresses,
--         dietary/occasion data, host_note, decline_note or cancellation_note.
--       - status pending -> sending -> sent | pending (retry) | failed | skipped,
--         attempts, next_attempt_at, claimed_at, claim_token, sent_at,
--         provider_message_id, last_error, skip_reason, created_at, updated_at.
--   * RLS enabled with NO policies; anon and authenticated have no privileges at all.
--     service_role (the app's server-only sender) may SELECT and UPDATE only — it
--     never inserts or deletes; rows are created by the triggers below.
--   * public.claim_email_outbox(p_limit): the only way rows are taken for delivery.
--     Atomically moves up to p_limit due rows (pending and due, or 'sending' with a
--     lease older than 10 minutes — a crashed sender) to 'sending' with a fresh
--     claim_token, using FOR UPDATE SKIP LOCKED so two concurrent senders can never
--     claim the same row. Executable by service_role only.
--   * two trigger functions on public.booking_request_items (SECURITY DEFINER,
--     search_path ''), separate from the untouched 0009/0020 notification triggers:
--       - AFTER INSERT, FOR EACH STATEMENT (transition table): new REQUESTED items ->
--         ONE request_created_guest per booking request and ONE request_created_host
--         per host, so a planner submission of several items yields one email per
--         recipient, not one per item.
--       - AFTER UPDATE OF status, FOR EACH ROW:
--           REQUESTED -> CONFIRMED                       request_confirmed_guest
--           REQUESTED -> DECLINED                        request_declined_guest
--           CONFIRMED -> CANCELLED, cancelled_by guest   booking_cancelled_by_guest_host
--                                                        booking_cancelled_by_guest_guest
--           CONFIRMED -> CANCELLED, cancelled_by provider booking_cancelled_by_host_guest
--                                                        booking_cancelled_by_host_host
--         Every other change (including any WITHDRAWN transition) creates nothing.
--     Both swallow their own errors (RAISE WARNING): a failure to record an email
--     can never roll back the booking change that caused it.
--   * two internal helpers used only by those triggers (executable by nobody else):
--     email_outbox_payload() and email_outbox_enqueue().
--
-- What it does NOT do: change any existing table, row, policy, grant, trigger or
-- function; touch the in-app notification triggers (0009, 0014, 0020); schedule any
-- cron job; send anything. Nothing is delivered until the app's sender is configured.
--
-- Run as role `postgres`, the whole file, in one run, after 0027.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.email_outbox') is not null then
    raise exception '0028 ABORTED: public.email_outbox already exists';
  end if;
  if to_regprocedure('public.email_outbox_payload(uuid[], text)') is not null
     or to_regprocedure('public.email_outbox_enqueue(text, text, uuid, uuid, uuid[], jsonb)') is not null
     or to_regprocedure('public.email_outbox_on_items_inserted()') is not null
     or to_regprocedure('public.email_outbox_on_item_status_change()') is not null
     or to_regprocedure('public.claim_email_outbox(integer)') is not null then
    raise exception '0028 ABORTED: an email_outbox function already exists';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
               and tgname in ('email_outbox_items_inserted', 'email_outbox_item_status_changed')) then
    raise exception '0028 ABORTED: an email_outbox trigger already exists on booking_request_items';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'booking_request_items' and column_name in
               ('id', 'booking_request_id', 'experience_id', 'planned_date', 'planned_moment', 'preferred_time',
                'guest_count', 'price_per_person', 'status', 'cancelled_by', 'cancellation_reason'))
          or (table_name = 'booking_requests' and column_name in ('id', 'user_id', 'stay_id'))
          or (table_name = 'experiences' and column_name in ('id', 'provider_id', 'title', 'currency'))
          or (table_name = 'providers' and column_name in ('id', 'user_id', 'display_name'))
          or (table_name = 'stays' and column_name in ('id', 'location_id'))
          or (table_name = 'locations' and column_name in ('id', 'name')))) <> 25 then
    raise exception '0028 ABORTED: a booking/experience/provider/stay/location column this migration reads is missing';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.booking_request_items'::regclass
                   and conname = 'booking_request_items_status_check'
                   and pg_get_constraintdef(oid) like '%CANCELLED%') then
    raise exception '0028 ABORTED: booking_request_items_status_check does not include CANCELLED (0018 missing?)';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
                   and tgname = 'booking_request_item_status_notify' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.booking_request_items'::regclass
                      and tgname = 'booking_request_item_cancellation_notify' and not tgisinternal) then
    raise exception '0028 ABORTED: the 0009/0020 notification triggers are not as expected';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS ═════════
  if not (select relrowsecurity from pg_class where oid = 'public.email_outbox'::regclass) then
    raise exception '0028 ROLLED BACK: RLS is not enabled on public.email_outbox';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_outbox') then
    raise exception '0028 ROLLED BACK: public.email_outbox has policies (expected none)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.email_outbox'::regclass
                   and contype = 'u' and conname = 'email_outbox_event_key_key') then
    raise exception '0028 ROLLED BACK: unique constraint on event_key is missing';
  end if;
  if has_table_privilege('anon', 'public.email_outbox', 'SELECT')
     or has_table_privilege('anon', 'public.email_outbox', 'INSERT')
     or has_table_privilege('anon', 'public.email_outbox', 'UPDATE')
     or has_table_privilege('anon', 'public.email_outbox', 'DELETE')
     or has_table_privilege('authenticated', 'public.email_outbox', 'SELECT')
     or has_table_privilege('authenticated', 'public.email_outbox', 'INSERT')
     or has_table_privilege('authenticated', 'public.email_outbox', 'UPDATE')
     or has_table_privilege('authenticated', 'public.email_outbox', 'DELETE')
     or has_table_privilege('authenticated', 'public.email_outbox', 'TRUNCATE') then
    raise exception '0028 ROLLED BACK: anon or authenticated has privileges on public.email_outbox';
  end if;
  if not has_table_privilege('service_role', 'public.email_outbox', 'SELECT')
     or not has_table_privilege('service_role', 'public.email_outbox', 'UPDATE')
     or has_table_privilege('service_role', 'public.email_outbox', 'INSERT')
     or has_table_privilege('service_role', 'public.email_outbox', 'DELETE')
     or has_table_privilege('service_role', 'public.email_outbox', 'TRUNCATE') then
    raise exception '0028 ROLLED BACK: service_role privileges on public.email_outbox are not SELECT, UPDATE only';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and p.proname in ('email_outbox_on_items_inserted', 'email_outbox_on_item_status_change')) <> 2
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prosecdef
                  and p.proname in ('email_outbox_payload', 'email_outbox_enqueue', 'claim_email_outbox')) then
    raise exception '0028 ROLLED BACK: SECURITY DEFINER is not exactly on the two trigger functions';
  end if;
  if has_function_privilege('anon', 'public.claim_email_outbox(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_email_outbox(integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_email_outbox(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.email_outbox_payload(uuid[], text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.email_outbox_payload(uuid[], text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.email_outbox_payload(uuid[], text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.email_outbox_enqueue(text, text, uuid, uuid, uuid[], jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.email_outbox_enqueue(text, text, uuid, uuid, uuid[], jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.email_outbox_enqueue(text, text, uuid, uuid, uuid[], jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.email_outbox_on_items_inserted()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.email_outbox_on_item_status_change()', 'EXECUTE') then
    raise exception '0028 ROLLED BACK: email_outbox function privileges are not as intended';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.booking_request_items'::regclass and not tgisinternal
        and tgenabled = 'O'
        and tgname in ('email_outbox_items_inserted', 'email_outbox_item_status_changed',
                       'booking_request_item_status_notify', 'booking_request_item_cancellation_notify')) <> 4 then
    raise exception '0028 ROLLED BACK: the email_outbox and notification triggers are not all present and enabled';
  end if;
  if exists (select 1 from public.email_outbox) then
    raise exception '0028 ROLLED BACK: public.email_outbox is not empty';
  end if;
end
$migration$;
