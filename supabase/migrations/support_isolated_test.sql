-- NOT A MIGRATION. Fail-closed isolated test for 0029_support.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (the support tables, functions, triggers, policies,
-- the notifications column, the realtime change, test providers/experiences,
-- test bookings, tickets, messages and notifications), releases every lock, and
-- leaves the session idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0029 (it creates 0029's objects itself, then throws them away;
-- once 0029 is applied it fails at the first statement and should not be re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs four existing accounts in auth.users, at least one of which is not a
-- host (no providers row). Their data is only read. Where the test needs a host
-- profile for an account that has none, it creates one — rolled back like
-- everything else. The real checks run as the `authenticated` role with a
-- signed-in user's claims, so the row-level security rules are genuinely enforced
-- (not bypassed the way a plain postgres session would bypass them).
--
-- Accounts:  A = guest (no host profile)   B = another user, also a host
--            H = host of booking X          S = Felyn staff (test row only)
-- Bookings:  X = A books H's experience     Y = H books H's own experience
--            Z = B books B's experience
--
-- What it checks (numbers follow the Stage 1 brief):
--   1  staff recognition, staff_members unreadable, anon locked out
--   2  a user opens their own general thread
--   3  a second general request reuses it (and the database blocks a duplicate)
--   4  a user opens their own booking thread
--   5  a second booking request reuses it (and the database blocks a duplicate)
--   6  a guest cannot attach another user's booking (same error as "no such booking")
--   7  a host cannot attach another host's or a guest's booking; role must match
--   8  guest and host get separate threads (incl. one account acting as both)
--   9  a user cannot create, change or delete messages or threads directly
--   10 staff can reply (sender_type staff, notification for the owner)
--   11 a user cannot resolve/close
--   12 staff can resolve
--   13 a user reply re-opens a RESOLVED thread
--   14 CLOSED refuses user replies; a new request then opens a new thread
--   15 a user (and the booking's host) cannot read another user's thread
--   16 staff can read all threads and the live support context; mark-read
--   17 public.messages (policies, triggers, notification trigger, realtime) unchanged
--   18 realtime: support_messages and support_threads published, staff_members not
--   19 staff ticket list: staff only, by status, newest first, paging, names, unread
--
-- Run it as role `postgres`, as the whole file, in one run.

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_h uuid; v_s uuid;
  v_h_provider uuid; v_b_provider uuid;
  v_exp_h uuid; v_exp_b uuid;
  v_req uuid; v_item_x uuid; v_item_y uuid; v_item_z uuid;
  v_g1 uuid; v_again uuid; v_b1 uuid; v_b2 uuid; v_h1 uuid; v_yg uuid; v_yh uuid;
  v_row record; v_ctx record;
  v_err_not_owned text; v_err_missing text;
  v_before text; v_after text;
  v_messages_before int; n int;
  v_ids uuid[]; v_unread int;
  v_a_email text; v_a_first_name text; v_h_display_name text;
begin
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 0. BASELINE of public.messages (compared in check 17) ═════════
    v_stage := 'baseline';
    select coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|'
                               || coalesce(with_check, ''), E'\n' order by policyname), '')
      into v_before
      from pg_policies where schemaname = 'public' and tablename = 'messages';
    select v_before || E'\n' || coalesce(string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname), '')
      into v_before
      from pg_trigger t where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal;
    select v_before || E'\n' || md5(pg_get_functiondef('public.notify_on_new_message()'::regprocedure))
      into v_before;
    select v_before || E'\n' || coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
      into v_before
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'messages';

    -- ═════════ 1. 0029 BODY (section 2 of 0029_support.sql, verbatim) ═════════
    v_stage := 'migration';
    -- ── staff ──
    create table public.staff_members (
      user_id uuid primary key references auth.users(id) on delete cascade,
      role text not null default 'support',
      created_at timestamptz not null default now(),
      constraint staff_members_role_check check (role in ('support', 'admin'))
    );
    alter table public.staff_members enable row level security;
    revoke all on public.staff_members from public, anon, authenticated;

    create function public.is_felyn_staff()
    returns boolean language sql stable security definer set search_path = '' as $fn$
      select exists (select 1 from public.staff_members s where s.user_id = auth.uid());
    $fn$;

    -- ── threads ──
    create table public.support_threads (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete restrict,
      requester_role text not null,
      booking_request_item_id uuid references public.booking_request_items(id) on delete restrict,
      category text not null,
      status text not null default 'OPEN',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_message_at timestamptz not null default now(),
      resolved_at timestamptz,
      closed_at timestamptz,
      constraint support_threads_requester_role_check check (requester_role in ('guest', 'host')),
      constraint support_threads_category_check check (category in
        ('booking', 'cancellation', 'payment', 'experience', 'account', 'technical_issue', 'other')),
      constraint support_threads_status_check check (status in ('OPEN', 'RESOLVED', 'CLOSED')),
      -- closed_at is set exactly while CLOSED; an OPEN thread carries no resolution; a
      -- RESOLVED thread always records when.
      constraint support_threads_closed_at_check check ((status = 'CLOSED') = (closed_at is not null)),
      constraint support_threads_open_check check (status <> 'OPEN' or resolved_at is null),
      constraint support_threads_resolved_at_check check (status <> 'RESOLVED' or resolved_at is not null)
    );
    create unique index support_threads_one_open_general_idx
      on public.support_threads (user_id, requester_role)
      where booking_request_item_id is null and status <> 'CLOSED';
    create unique index support_threads_one_open_per_booking_idx
      on public.support_threads (user_id, requester_role, booking_request_item_id)
      where booking_request_item_id is not null and status <> 'CLOSED';
    create index support_threads_user_id_idx on public.support_threads (user_id);
    create index support_threads_booking_request_item_id_idx on public.support_threads (booking_request_item_id);
    create index support_threads_status_last_message_idx on public.support_threads (status, last_message_at desc);

    -- ── messages ──
    create table public.support_messages (
      id uuid primary key default gen_random_uuid(),
      support_thread_id uuid not null references public.support_threads(id) on delete cascade,
      sender_type text not null,
      sender_user_id uuid not null references auth.users(id) on delete restrict,
      body text not null,
      created_at timestamptz not null default now(),
      read_at timestamptz,
      constraint support_messages_sender_type_check check (sender_type in ('user', 'staff')),
      constraint support_messages_body_check check (char_length(body) between 1 and 2000)
    );
    create index support_messages_thread_idx on public.support_messages (support_thread_id, created_at);
    create index support_messages_unread_idx on public.support_messages (support_thread_id) where read_at is null;

    -- ── read access (RLS) and privileges ──
    alter table public.support_threads enable row level security;
    alter table public.support_messages enable row level security;
    create policy "Users read their own support threads" on public.support_threads
      for select to authenticated using (user_id = auth.uid());
    create policy "Staff read all support threads" on public.support_threads
      for select to authenticated using (public.is_felyn_staff());
    create policy "Users read messages in their own support threads" on public.support_messages
      for select to authenticated using (
        exists (select 1 from public.support_threads t
                where t.id = support_messages.support_thread_id and t.user_id = auth.uid()));
    create policy "Staff read all support messages" on public.support_messages
      for select to authenticated using (public.is_felyn_staff());
    -- Supabase's default privileges grant everything on new tables; replace them with
    -- read-only access. All writes go through the functions below.
    revoke all on public.support_threads from public, anon, authenticated;
    revoke all on public.support_messages from public, anon, authenticated;
    grant select on public.support_threads to authenticated;
    grant select on public.support_messages to authenticated;

    -- ── notifications link (additive) ──
    alter table public.notifications
      add column support_thread_id uuid references public.support_threads(id) on delete set null;
    create index notifications_support_thread_id_idx on public.notifications (support_thread_id);

    -- ── triggers on support_messages ──
    create function public.support_messages_touch_thread()
    returns trigger language plpgsql set search_path = '' as $fn$
    begin
      update public.support_threads
         set last_message_at = new.created_at, updated_at = now()
       where id = new.support_thread_id;
      return new;
    end $fn$;
    create trigger support_messages_touch_thread
      after insert on public.support_messages
      for each row execute function public.support_messages_touch_thread();

    create function public.support_messages_notify_staff_reply()
    returns trigger language plpgsql set search_path = '' as $fn$
    declare v_owner uuid;
    begin
      if new.sender_type <> 'staff' then
        return new;
      end if;
      select t.user_id into v_owner from public.support_threads t where t.id = new.support_thread_id;
      if v_owner is null or v_owner = new.sender_user_id then
        return new;
      end if;
      insert into public.notifications (user_id, type, title, body, support_thread_id)
      values (v_owner, 'support_reply', 'Felyn Team replied',
              'Felyn Team replied to your support request.', new.support_thread_id);
      return new;
    end $fn$;
    create trigger support_messages_notify_staff_reply
      after insert on public.support_messages
      for each row execute function public.support_messages_notify_staff_reply();

    -- ── user functions ──
    -- Opens a ticket, or continues the user's existing non-CLOSED one for the same
    -- (requester_role, booking item or none). Returns the thread id.
    create function public.support_open_thread(
      p_requester_role text, p_category text, p_body text, p_booking_request_item_id uuid default null
    ) returns uuid language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_body text := btrim(coalesce(p_body, ''));
      v_thread_id uuid;
      v_status text;
    begin
      if v_uid is null then
        raise exception 'Not signed in' using errcode = '42501';
      end if;
      if p_requester_role is null or p_requester_role not in ('guest', 'host') then
        raise exception 'Invalid requester role' using errcode = '22023';
      end if;
      if p_category is null or p_category not in
         ('booking', 'cancellation', 'payment', 'experience', 'account', 'technical_issue', 'other') then
        raise exception 'Invalid category' using errcode = '22023';
      end if;
      if char_length(v_body) not between 1 and 2000 then
        raise exception 'Message must be 1-2000 characters' using errcode = '22023';
      end if;
      if p_requester_role = 'host'
         and not exists (select 1 from public.providers p where p.user_id = v_uid) then
        raise exception 'Not allowed' using errcode = '42501';
      end if;

      -- The booking must be the caller's, in the role they are asking as. A booking that
      -- doesn't exist and one that belongs to someone else give the same error.
      if p_booking_request_item_id is not null then
        if p_requester_role = 'guest' and not exists (
             select 1 from public.booking_request_items bri
             join public.booking_requests br on br.id = bri.booking_request_id
             where bri.id = p_booking_request_item_id and br.user_id = v_uid) then
          raise exception 'Booking not found' using errcode = 'P0002';
        end if;
        if p_requester_role = 'host' and not exists (
             select 1 from public.booking_request_items bri
             join public.experiences e on e.id = bri.experience_id
             join public.providers p on p.id = e.provider_id
             where bri.id = p_booking_request_item_id and p.user_id = v_uid) then
          raise exception 'Booking not found' using errcode = 'P0002';
        end if;
      end if;

      -- Reuse the open thread, or create one. ON CONFLICT DO NOTHING plus the partial
      -- unique indexes make a concurrent duplicate wait, find nothing inserted, and loop
      -- back to pick up the other request's thread.
      for i in 1..3 loop
        select t.id, t.status into v_thread_id, v_status
          from public.support_threads t
         where t.user_id = v_uid
           and t.requester_role = p_requester_role
           and t.booking_request_item_id is not distinct from p_booking_request_item_id
           and t.status <> 'CLOSED'
         for update;
        if found then
          if v_status = 'RESOLVED' then
            update public.support_threads
               set status = 'OPEN', resolved_at = null, updated_at = now()
             where id = v_thread_id;
          end if;
          exit;
        end if;
        insert into public.support_threads (user_id, requester_role, booking_request_item_id, category)
        values (v_uid, p_requester_role, p_booking_request_item_id, p_category)
        on conflict do nothing
        returning id into v_thread_id;
        exit when v_thread_id is not null;
      end loop;
      if v_thread_id is null then
        raise exception 'Could not open the support conversation, please try again' using errcode = '40001';
      end if;

      insert into public.support_messages (support_thread_id, sender_type, sender_user_id, body)
      values (v_thread_id, 'user', v_uid, v_body);
      return v_thread_id;
    end $fn$;

    -- The thread owner adds a message. A RESOLVED thread re-opens; a CLOSED one refuses.
    create function public.support_send_message(p_thread_id uuid, p_body text)
    returns public.support_messages language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_body text := btrim(coalesce(p_body, ''));
      v_status text;
      v_message public.support_messages;
    begin
      if v_uid is null then
        raise exception 'Not signed in' using errcode = '42501';
      end if;
      if char_length(v_body) not between 1 and 2000 then
        raise exception 'Message must be 1-2000 characters' using errcode = '22023';
      end if;
      select t.status into v_status from public.support_threads t
       where t.id = p_thread_id and t.user_id = v_uid
       for update;
      if not found then
        raise exception 'Support conversation not found' using errcode = 'P0002';
      end if;
      if v_status = 'CLOSED' then
        raise exception 'This support conversation is closed' using errcode = '55000';
      end if;
      if v_status = 'RESOLVED' then
        update public.support_threads
           set status = 'OPEN', resolved_at = null, updated_at = now()
         where id = p_thread_id;
      end if;
      insert into public.support_messages (support_thread_id, sender_type, sender_user_id, body)
      values (p_thread_id, 'user', v_uid, v_body)
      returning * into v_message;
      return v_message;
    end $fn$;

    -- Marks the OTHER side's unread messages read: the owner reads staff messages, staff
    -- read the user's. Returns how many were marked.
    create function public.support_mark_read(p_thread_id uuid)
    returns integer language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_owner uuid;
      v_other_side text;
      v_count integer;
    begin
      if v_uid is null then
        raise exception 'Not signed in' using errcode = '42501';
      end if;
      select t.user_id into v_owner from public.support_threads t where t.id = p_thread_id;
      if v_owner is not null and v_owner = v_uid then
        v_other_side := 'staff';
      elsif v_owner is not null and public.is_felyn_staff() then
        v_other_side := 'user';
      else
        raise exception 'Support conversation not found' using errcode = 'P0002';
      end if;
      update public.support_messages
         set read_at = now()
       where support_thread_id = p_thread_id and sender_type = v_other_side and read_at is null;
      get diagnostics v_count = row_count;
      return v_count;
    end $fn$;

    -- ── staff functions ──
    -- A Felyn Team reply. Does not change the status (staff use support_staff_set_status);
    -- a CLOSED thread must be re-opened first.
    create function public.support_staff_reply(p_thread_id uuid, p_body text)
    returns public.support_messages language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_body text := btrim(coalesce(p_body, ''));
      v_status text;
      v_message public.support_messages;
    begin
      if v_uid is null or not public.is_felyn_staff() then
        raise exception 'Not allowed' using errcode = '42501';
      end if;
      if char_length(v_body) not between 1 and 2000 then
        raise exception 'Message must be 1-2000 characters' using errcode = '22023';
      end if;
      select t.status into v_status from public.support_threads t where t.id = p_thread_id for update;
      if not found then
        raise exception 'Support conversation not found' using errcode = 'P0002';
      end if;
      if v_status = 'CLOSED' then
        raise exception 'This support conversation is closed' using errcode = '55000';
      end if;
      insert into public.support_messages (support_thread_id, sender_type, sender_user_id, body)
      values (p_thread_id, 'staff', v_uid, v_body)
      returning * into v_message;
      return v_message;
    end $fn$;

    -- OPEN clears resolved_at/closed_at; RESOLVED stamps resolved_at (clears closed_at);
    -- CLOSED stamps closed_at (keeps resolved_at). Setting the current status is a no-op.
    create function public.support_staff_set_status(p_thread_id uuid, p_status text)
    returns public.support_threads language plpgsql security definer set search_path = '' as $fn$
    declare
      v_uid uuid := auth.uid();
      v_thread public.support_threads;
    begin
      if v_uid is null or not public.is_felyn_staff() then
        raise exception 'Not allowed' using errcode = '42501';
      end if;
      if p_status is null or p_status not in ('OPEN', 'RESOLVED', 'CLOSED') then
        raise exception 'Invalid status' using errcode = '22023';
      end if;
      select * into v_thread from public.support_threads t where t.id = p_thread_id for update;
      if not found then
        raise exception 'Support conversation not found' using errcode = 'P0002';
      end if;
      if v_thread.status = p_status then
        return v_thread;
      end if;
      begin
        update public.support_threads
           set status = p_status,
               resolved_at = case p_status when 'OPEN' then null when 'RESOLVED' then now() else resolved_at end,
               closed_at = case p_status when 'CLOSED' then now() else null end,
               updated_at = now()
         where id = p_thread_id
        returning * into v_thread;
      exception when unique_violation then
        raise exception 'This user already has another open support conversation for this'
          using errcode = '23505';
      end;
      return v_thread;
    end $fn$;

    -- Everything the admin ticket page shows, read live from the user's account, contact
    -- record and the linked booking (never copied into support_threads).
    create function public.support_staff_thread_context(p_thread_id uuid)
    returns table (
      thread_id uuid,
      user_id uuid,
      requester_role text,
      category text,
      status text,
      booking_request_item_id uuid,
      created_at timestamptz,
      updated_at timestamptz,
      last_message_at timestamptz,
      resolved_at timestamptz,
      closed_at timestamptz,
      user_first_name text,
      user_last_name text,
      user_email text,
      user_phone text,
      requester_provider_display_name text,
      booking_experience_title text,
      booking_host_display_name text,
      booking_guest_first_name text,
      booking_planned_date date,
      booking_planned_moment text,
      booking_preferred_time time,
      booking_guest_count integer,
      booking_status text,
      booking_stay_name text
    ) language plpgsql stable security definer set search_path = '' as $fn$
    begin
      if auth.uid() is null or not public.is_felyn_staff() then
        raise exception 'Not allowed' using errcode = '42501';
      end if;
      return query
        select t.id, t.user_id, t.requester_role, t.category, t.status, t.booking_request_item_id,
               t.created_at, t.updated_at, t.last_message_at, t.resolved_at, t.closed_at,
               nullif(btrim(u.raw_user_meta_data ->> 'first_name'), ''),
               nullif(btrim(u.raw_user_meta_data ->> 'last_name'), ''),
               u.email::text,
               ucd.phone_number,
               rp.display_name,
               e.title,
               bp.display_name,
               nullif(btrim(gu.raw_user_meta_data ->> 'first_name'), ''),
               bri.planned_date,
               bri.planned_moment,
               bri.preferred_time,
               bri.guest_count,
               bri.status,
               s.property_name
          from public.support_threads t
          join auth.users u on u.id = t.user_id
          left join public.user_contact_details ucd on ucd.user_id = t.user_id
          left join public.providers rp on rp.user_id = t.user_id
          left join public.booking_request_items bri on bri.id = t.booking_request_item_id
          left join public.booking_requests br on br.id = bri.booking_request_id
          left join auth.users gu on gu.id = br.user_id
          left join public.experiences e on e.id = bri.experience_id
          left join public.providers bp on bp.id = e.provider_id
          left join public.stays s on s.id = br.stay_id
         where t.id = p_thread_id;
      if not found then
        raise exception 'Support conversation not found' using errcode = 'P0002';
      end if;
    end $fn$;

    -- The admin ticket list: one page of threads in one status, newest activity first,
    -- with the customer's name/email (from auth.users, which staff cannot read directly),
    -- the booking's experience, a preview of the latest message and how many guest
    -- messages are unread — one query instead of one context call per ticket. Keyset
    -- paging on (last_message_at, id): pass the last row's values to get the next page.
    create function public.support_staff_list_threads(
      p_status text,
      p_limit integer default 50,
      p_before_at timestamptz default null,
      p_before_id uuid default null
    ) returns table (
      thread_id uuid,
      requester_role text,
      category text,
      status text,
      is_booking boolean,
      created_at timestamptz,
      last_message_at timestamptz,
      user_first_name text,
      user_last_name text,
      user_email text,
      booking_experience_title text,
      last_message_body text,
      last_message_sender_type text,
      unread_count integer
    ) language plpgsql stable security definer set search_path = '' as $fn$
    begin
      if auth.uid() is null or not public.is_felyn_staff() then
        raise exception 'Not allowed' using errcode = '42501';
      end if;
      if p_status is null or p_status not in ('OPEN', 'RESOLVED', 'CLOSED') then
        raise exception 'Invalid status' using errcode = '22023';
      end if;
      return query
        select t.id, t.requester_role, t.category, t.status, t.booking_request_item_id is not null,
               t.created_at, t.last_message_at,
               nullif(btrim(u.raw_user_meta_data ->> 'first_name'), ''),
               nullif(btrim(u.raw_user_meta_data ->> 'last_name'), ''),
               u.email::text,
               e.title,
               left(lm.body, 200),
               lm.sender_type,
               (select count(*)::integer from public.support_messages um
                 where um.support_thread_id = t.id and um.sender_type = 'user' and um.read_at is null)
          from public.support_threads t
          join auth.users u on u.id = t.user_id
          left join public.booking_request_items bri on bri.id = t.booking_request_item_id
          left join public.experiences e on e.id = bri.experience_id
          left join lateral (
            select m.body, m.sender_type from public.support_messages m
             where m.support_thread_id = t.id
             order by m.created_at desc, m.id desc
             limit 1
          ) lm on true
         where t.status = p_status
           and (p_before_at is null or (t.last_message_at, t.id) < (p_before_at, p_before_id))
         order by t.last_message_at desc, t.id desc
         limit least(greatest(coalesce(p_limit, 50), 1), 100);
    end $fn$;

    -- ── function privileges ──
    -- Supabase's default privileges grant EXECUTE on new functions to anon,
    -- authenticated and service_role; reset to exactly: the callable functions for
    -- authenticated only, the trigger functions for nobody.
    revoke execute on function public.is_felyn_staff() from public, anon, authenticated, service_role;
    revoke execute on function public.support_messages_touch_thread() from public, anon, authenticated, service_role;
    revoke execute on function public.support_messages_notify_staff_reply() from public, anon, authenticated, service_role;
    revoke execute on function public.support_open_thread(text, text, text, uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.support_send_message(uuid, text) from public, anon, authenticated, service_role;
    revoke execute on function public.support_mark_read(uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.support_staff_reply(uuid, text) from public, anon, authenticated, service_role;
    revoke execute on function public.support_staff_set_status(uuid, text) from public, anon, authenticated, service_role;
    revoke execute on function public.support_staff_thread_context(uuid) from public, anon, authenticated, service_role;
    revoke execute on function public.support_staff_list_threads(text, integer, timestamptz, uuid) from public, anon, authenticated, service_role;
    grant execute on function public.is_felyn_staff() to authenticated;
    grant execute on function public.support_open_thread(text, text, text, uuid) to authenticated;
    grant execute on function public.support_send_message(uuid, text) to authenticated;
    grant execute on function public.support_mark_read(uuid) to authenticated;
    grant execute on function public.support_staff_reply(uuid, text) to authenticated;
    grant execute on function public.support_staff_set_status(uuid, text) to authenticated;
    grant execute on function public.support_staff_thread_context(uuid) to authenticated;
    grant execute on function public.support_staff_list_threads(text, integer, timestamptz, uuid) to authenticated;

    -- ── realtime ──
    alter publication supabase_realtime add table public.support_messages;
    alter publication supabase_realtime add table public.support_threads;

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    select u.id into v_a from auth.users u
     where not exists (select 1 from public.providers p where p.user_id = u.id)
     order by u.created_at limit 1;
    select u.id into v_b from auth.users u where u.id <> v_a order by u.created_at limit 1;
    select u.id into v_h from auth.users u where u.id not in (v_a, v_b) order by u.created_at limit 1;
    select u.id into v_s from auth.users u where u.id not in (v_a, v_b, v_h) order by u.created_at limit 1;
    if v_a is null or v_b is null or v_h is null or v_s is null then
      raise exception 'SETUP: need four accounts in auth.users, one of them without a host profile';
    end if;

    select p.id into v_h_provider from public.providers p where p.user_id = v_h;
    if v_h_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_h, 'SUPPORT TEST HOST H (rolled back)', 'verified') returning id into v_h_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'SUPPORT TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;

    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
    values (v_h_provider, 'SUPPORT TEST EXPERIENCE H (rolled back)', 'food', 50, 1, 6, 120) returning id into v_exp_h;
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
    values (v_b_provider, 'SUPPORT TEST EXPERIENCE B (rolled back)', 'drink', 40, 1, 6, 90) returning id into v_exp_b;

    insert into public.booking_requests (user_id, stay_id, estimated_total) values (v_a, null, 100) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp_h, current_date + 7, 'evening', 2, 50) returning id into v_item_x;
    insert into public.booking_requests (user_id, stay_id, estimated_total) values (v_h, null, 50) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp_h, current_date + 8, 'morning', 1, 50) returning id into v_item_y;
    insert into public.booking_requests (user_id, stay_id, estimated_total) values (v_b, null, 40) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person)
    values (v_req, v_exp_b, current_date + 9, 'afternoon', 1, 40) returning id into v_item_z;

    insert into public.staff_members (user_id, role) values (v_s, 'support');
    -- Expected values for check 16, read here as postgres (signed-in users cannot read
    -- auth.users or another host's providers row, which is exactly why the staff
    -- context function exists).
    select u.email::text, nullif(btrim(u.raw_user_meta_data ->> 'first_name'), '')
      into v_a_email, v_a_first_name from auth.users u where u.id = v_a;
    select p.display_name into v_h_display_name from public.providers p where p.id = v_h_provider;
    select count(*) into v_messages_before from public.messages;

    -- ═════════ 3. STAFF RECOGNITION (check 1) ═════════
    v_stage := '1 staff recognition';
    set local role anon;
    begin
      perform public.is_felyn_staff();
      raise exception '1 FAILED: anon can call is_felyn_staff()';
    exception when insufficient_privilege then null;
    end;
    begin
      select count(*) into n from public.support_threads;
      raise exception '1 FAILED: anon can read support_threads';
    exception when insufficient_privilege then null;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_s::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.is_felyn_staff() then raise exception '1 FAILED: the staff account is not recognised'; end if;
    begin
      select count(*) into n from public.staff_members;
      raise exception '1 FAILED: staff can read staff_members through the API';
    exception when insufficient_privilege then null;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.is_felyn_staff() then raise exception '1 FAILED: a normal user is recognised as staff'; end if;
    begin
      insert into public.staff_members (user_id) values (v_a);
      raise exception '1 FAILED: a user could make themselves staff';
    exception when insufficient_privilege then null;
    end;

    -- ═════════ 4. GENERAL THREADS (checks 2-3), still as A ═════════
    v_stage := '2-3 general threads';
    v_g1 := public.support_open_thread('guest', 'account', '  I cannot change my email.  ', null);
    select * into v_row from public.support_threads where id = v_g1;
    if v_row.user_id <> v_a or v_row.requester_role <> 'guest' or v_row.status <> 'OPEN'
       or v_row.category <> 'account' or v_row.booking_request_item_id is not null then
      raise exception '2 FAILED: the general thread is not as expected';
    end if;
    select * into v_row from public.support_messages where support_thread_id = v_g1;
    if v_row.sender_type <> 'user' or v_row.sender_user_id <> v_a or v_row.body <> 'I cannot change my email.' then
      raise exception '2 FAILED: the first message is not as expected (sender/trim)';
    end if;
    v_again := public.support_open_thread('guest', 'payment', 'Also a payment question.', null);
    if v_again <> v_g1 then raise exception '3 FAILED: a second general request created a new thread'; end if;
    select count(*) into n from public.support_messages where support_thread_id = v_g1;
    if n <> 2 then raise exception '3 FAILED: the reused thread has % messages, expected 2', n; end if;
    if (select category from public.support_threads where id = v_g1) <> 'account' then
      raise exception '3 FAILED: reusing the thread changed its category';
    end if;
    begin
      perform public.support_open_thread('guest', 'not_a_category', 'x', null);
      raise exception '2 FAILED: an unknown category was accepted';
    exception when sqlstate '22023' then null;
    end;
    begin
      perform public.support_open_thread('guest', 'other', '   ', null);
      raise exception '2 FAILED: an empty message was accepted';
    exception when sqlstate '22023' then null;
    end;
    begin
      perform public.support_open_thread('guest', 'other', repeat('x', 2001), null);
      raise exception '2 FAILED: a 2001-character message was accepted';
    exception when sqlstate '22023' then null;
    end;
    begin
      perform public.support_open_thread('staff', 'other', 'x', null);
      raise exception '2 FAILED: an invalid requester role was accepted';
    exception when sqlstate '22023' then null;
    end;

    -- ═════════ 5. BOOKING THREADS (checks 4-6), still as A ═════════
    v_stage := '4-6 booking threads';
    v_b1 := public.support_open_thread('guest', 'booking', 'Can we come at 8pm instead?', v_item_x);
    if v_b1 = v_g1 then raise exception '4 FAILED: the booking thread reused the general thread'; end if;
    if (select booking_request_item_id from public.support_threads where id = v_b1) <> v_item_x then
      raise exception '4 FAILED: the booking thread is not linked to booking X';
    end if;
    v_again := public.support_open_thread('guest', 'cancellation', 'Following up.', v_item_x);
    if v_again <> v_b1 then raise exception '5 FAILED: a second request for booking X created a new thread'; end if;
    begin
      perform public.support_open_thread('guest', 'booking', 'Not mine.', v_item_z);
      raise exception '6 FAILED: guest A attached booking Z (belongs to B)';
    exception when sqlstate 'P0002' then v_err_not_owned := sqlerrm;
    end;
    begin
      perform public.support_open_thread('guest', 'booking', 'Does not exist.', gen_random_uuid());
      raise exception '6 FAILED: a non-existent booking was accepted';
    exception when sqlstate 'P0002' then v_err_missing := sqlerrm;
    end;
    if v_err_not_owned is distinct from v_err_missing then
      raise exception '6 FAILED: another user''s booking gives a different error than a missing one';
    end if;
    begin
      perform public.support_open_thread('host', 'booking', 'I am not a host.', v_item_x);
      raise exception '7 FAILED: a non-host opened a host thread';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- The database itself refuses a duplicate even when the function is bypassed (as postgres).
    begin
      insert into public.support_threads (user_id, requester_role, category) values (v_a, 'guest', 'other');
      raise exception '3 FAILED: the database allowed a second open general thread';
    exception when unique_violation then null;
    end;
    begin
      insert into public.support_threads (user_id, requester_role, booking_request_item_id, category)
      values (v_a, 'guest', v_item_x, 'other');
      raise exception '5 FAILED: the database allowed a second open thread for booking X';
    exception when unique_violation then null;
    end;

    -- ═════════ 6. GUEST B (checks 6, 15) ═════════
    v_stage := '6/15 guest B';
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.support_open_thread('guest', 'booking', 'Not mine.', v_item_x);
      raise exception '6 FAILED: guest B attached booking X (belongs to A)';
    exception when sqlstate 'P0002' then null;
    end;
    begin
      perform public.support_open_thread('host', 'booking', 'Not my experience.', v_item_x);
      raise exception '7 FAILED: host B attached booking X (H''s experience)';
    exception when sqlstate 'P0002' then null;
    end;
    select count(*) into n from public.support_threads where user_id = v_a;
    if n <> 0 then raise exception '15 FAILED: user B can see % of user A''s threads', n; end if;
    select count(*) into n from public.support_messages where support_thread_id in (v_g1, v_b1);
    if n <> 0 then raise exception '15 FAILED: user B can read user A''s support messages'; end if;
    begin
      perform public.support_send_message(v_b1, 'Writing into A''s ticket.');
      raise exception '15 FAILED: user B posted into user A''s thread';
    exception when sqlstate 'P0002' then null;
    end;
    begin
      perform public.support_mark_read(v_b1);
      raise exception '15 FAILED: user B could mark user A''s thread read';
    exception when sqlstate 'P0002' then null;
    end;
    begin
      perform * from public.support_staff_thread_context(v_b1);
      raise exception '15 FAILED: user B read the staff context of A''s thread';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 7. HOST H (checks 7, 8, 15) ═════════
    v_stage := '7-8 host H';
    perform set_config('request.jwt.claim.sub', v_h::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_h, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.support_open_thread('host', 'booking', 'Not my experience.', v_item_z);
      raise exception '7 FAILED: host H attached booking Z (B''s experience)';
    exception when sqlstate 'P0002' then null;
    end;
    begin
      perform public.support_open_thread('guest', 'booking', 'I am the host here, not the guest.', v_item_x);
      raise exception '7 FAILED: host H opened a GUEST thread for a booking they only host';
    exception when sqlstate 'P0002' then null;
    end;
    v_h1 := public.support_open_thread('host', 'experience', 'The guest asked for a vegan menu.', v_item_x);
    if v_h1 = v_b1 then raise exception '8 FAILED: host and guest share a thread for booking X'; end if;
    if (select requester_role from public.support_threads where id = v_h1) <> 'host' then
      raise exception '8 FAILED: the host thread is not marked requester_role host';
    end if;
    -- One account acting as both guest and host of booking Y gets two separate threads.
    v_yg := public.support_open_thread('guest', 'booking', 'As the guest.', v_item_y);
    v_yh := public.support_open_thread('host', 'booking', 'As the host.', v_item_y);
    if v_yg = v_yh then raise exception '8 FAILED: guest and host side of one account share a thread'; end if;
    -- The host of booking X must not see the guest's support conversation about it.
    select count(*) into n from public.support_threads where id = v_b1;
    if n <> 0 then raise exception '15 FAILED: the host can see the guest''s support thread for their booking'; end if;
    select count(*) into n from public.support_messages where support_thread_id = v_b1;
    if n <> 0 then raise exception '15 FAILED: the host can read the guest''s support messages for their booking'; end if;
    reset role;

    -- ═════════ 8. USER A: NO DIRECT WRITES (checks 9, 11) ═════════
    v_stage := '9/11 direct writes';
    -- Structural: no client write privilege and no write policy at all, so nothing below
    -- passes merely because some other object (e.g. a trigger) happened to fail.
    if has_table_privilege('authenticated', 'public.support_messages', 'INSERT')
       or has_table_privilege('authenticated', 'public.support_messages', 'UPDATE')
       or has_table_privilege('authenticated', 'public.support_messages', 'DELETE')
       or has_table_privilege('authenticated', 'public.support_threads', 'INSERT')
       or has_table_privilege('authenticated', 'public.support_threads', 'UPDATE')
       or has_table_privilege('authenticated', 'public.support_threads', 'DELETE')
       or exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename in ('support_threads', 'support_messages')
                    and cmd <> 'SELECT') then
      raise exception '9 FAILED: clients have a write privilege or write policy on a support table';
    end if;
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      insert into public.support_messages (support_thread_id, sender_type, sender_user_id, body)
      values (v_b1, 'staff', v_a, 'Felyn Team here (forged).');
      raise exception '9 FAILED: a user inserted a staff message directly';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.support_staff_reply(v_b1, 'Felyn Team here (forged).');
      raise exception '9 FAILED: a user called support_staff_reply';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.support_messages set sender_type = 'staff' where support_thread_id = v_b1;
      raise exception '9 FAILED: a user changed sender_type';
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.support_messages where support_thread_id = v_b1;
      raise exception '9 FAILED: a user deleted support messages';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.support_threads (user_id, requester_role, category) values (v_a, 'host', 'other');
      raise exception '9 FAILED: a user inserted a thread directly';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.support_threads set status = 'CLOSED' where id = v_b1;
      raise exception '11 FAILED: a user changed a thread status directly';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.support_staff_set_status(v_b1, 'RESOLVED');
      raise exception '11 FAILED: a user called support_staff_set_status';
    exception when insufficient_privilege then null;
    end;
    select count(*) into n from public.support_threads;
    if n <> 2 then raise exception '15 FAILED: user A sees % threads, expected exactly their own 2', n; end if;
    reset role;

    -- ═════════ 9. STAFF REPLY, RESOLVE, REOPEN, CLOSE (checks 10, 12-14, 16) ═════════
    v_stage := '10/12 staff reply and resolve';
    perform set_config('request.jwt.claim.sub', v_s::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.support_threads where id in (v_g1, v_b1, v_h1, v_yg, v_yh);
    if n <> 5 then raise exception '16 FAILED: staff can see % of the 5 test threads', n; end if;
    select * into v_row from public.support_staff_reply(v_b1, '  Of course, 8pm is fine.  ');
    if v_row.sender_type <> 'staff' or v_row.sender_user_id <> v_s or v_row.body <> 'Of course, 8pm is fine.' then
      raise exception '10 FAILED: the staff reply is not as expected';
    end if;
    if (select last_message_at from public.support_threads where id = v_b1) <> v_row.created_at then
      raise exception '10 FAILED: last_message_at was not updated by the reply';
    end if;
    if (select status from public.support_threads where id = v_b1) <> 'OPEN' then
      raise exception '10 FAILED: a staff reply changed the status';
    end if;
    select * into v_row from public.support_staff_set_status(v_b1, 'RESOLVED');
    if v_row.status <> 'RESOLVED' or v_row.resolved_at is null or v_row.closed_at is not null then
      raise exception '12 FAILED: resolving did not set status/resolved_at correctly';
    end if;
    begin
      perform public.support_staff_set_status(v_b1, 'PENDING');
      raise exception '12 FAILED: an unknown status was accepted';
    exception when sqlstate '22023' then null;
    end;

    v_stage := '16 staff context';
    select * into v_ctx from public.support_staff_thread_context(v_b1);
    if v_ctx.thread_id <> v_b1 or v_ctx.user_id <> v_a or v_ctx.requester_role <> 'guest'
       or v_ctx.category <> 'booking' or v_ctx.status <> 'RESOLVED'
       or v_ctx.user_email is distinct from v_a_email
       or v_ctx.booking_request_item_id <> v_item_x
       or v_ctx.booking_experience_title <> 'SUPPORT TEST EXPERIENCE H (rolled back)'
       or v_ctx.booking_host_display_name is distinct from v_h_display_name
       or v_ctx.booking_planned_date <> current_date + 7 or v_ctx.booking_planned_moment <> 'evening'
       or v_ctx.booking_guest_count <> 2 or v_ctx.booking_status <> 'REQUESTED'
       or v_ctx.booking_stay_name is not null then
      raise exception '16 FAILED: the staff context for booking thread X is not as expected';
    end if;
    select * into v_ctx from public.support_staff_thread_context(v_g1);
    if v_ctx.booking_request_item_id is not null or v_ctx.booking_experience_title is not null then
      raise exception '16 FAILED: a general thread returned booking details';
    end if;
    select * into v_ctx from public.support_staff_thread_context(v_h1);
    if v_ctx.requester_role <> 'host'
       or v_ctx.requester_provider_display_name is distinct from v_h_display_name
       or v_ctx.booking_guest_first_name is distinct from v_a_first_name then
      raise exception '16 FAILED: the staff context for the host thread is not as expected';
    end if;
    begin
      perform * from public.support_staff_thread_context(gen_random_uuid());
      raise exception '16 FAILED: context for a missing thread did not raise not-found';
    exception when sqlstate 'P0002' then null;
    end;

    v_stage := '16 mark read';
    n := public.support_mark_read(v_b1);   -- staff marks the user's messages
    if n <> 2 then raise exception '16 FAILED: staff marked % user messages read, expected 2', n; end if;
    if exists (select 1 from public.support_messages
               where support_thread_id = v_b1 and sender_type = 'staff' and read_at is not null) then
      raise exception '16 FAILED: staff mark-read touched staff messages';
    end if;
    reset role;

    v_stage := '10 notification';
    select count(*) into n from public.notifications
     where user_id = v_a and type = 'support_reply' and support_thread_id = v_b1 and booking_request_item_id is null;
    if n <> 1 then raise exception '10 FAILED: expected 1 support_reply notification for the owner, found %', n; end if;
    select count(*) into n from public.notifications where support_thread_id is not null and user_id <> v_a;
    if n <> 0 then raise exception '10 FAILED: a support notification went to someone other than the owner'; end if;

    v_stage := '13-14 reopen and close';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    n := public.support_mark_read(v_b1);   -- the owner marks staff messages
    if n <> 1 then raise exception '16 FAILED: the owner marked % staff messages read, expected 1', n; end if;
    select * into v_row from public.support_send_message(v_b1, 'Sorry, one more thing.');
    if v_row.sender_type <> 'user' or v_row.sender_user_id <> v_a then
      raise exception '13 FAILED: the user message is not as expected';
    end if;
    select * into v_row from public.support_threads where id = v_b1;
    if v_row.status <> 'OPEN' or v_row.resolved_at is not null then
      raise exception '13 FAILED: a user reply did not re-open the RESOLVED thread';
    end if;
    reset role;

    perform set_config('request.jwt.claim.sub', v_s::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select * into v_row from public.support_staff_set_status(v_b1, 'CLOSED');
    if v_row.status <> 'CLOSED' or v_row.closed_at is null then
      raise exception '14 FAILED: closing did not set status/closed_at correctly';
    end if;
    begin
      perform public.support_staff_reply(v_b1, 'Reply to a closed thread.');
      raise exception '14 FAILED: staff replied to a CLOSED thread without re-opening it';
    exception when sqlstate '55000' then null;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.support_send_message(v_b1, 'Are you there?');
      raise exception '14 FAILED: a user posted into a CLOSED thread';
    exception when sqlstate '55000' then null;
    end;
    v_b2 := public.support_open_thread('guest', 'booking', 'New question about the same booking.', v_item_x);
    if v_b2 = v_b1 then raise exception '14 FAILED: a CLOSED thread was reused'; end if;
    reset role;

    perform set_config('request.jwt.claim.sub', v_s::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform public.support_staff_set_status(v_b1, 'OPEN');
      raise exception '14 FAILED: re-opening created a second open thread for booking X';
    exception when unique_violation then null;
    end;
    select * into v_row from public.support_staff_set_status(v_b2, 'CLOSED');
    select * into v_row from public.support_staff_set_status(v_b1, 'OPEN');
    if v_row.status <> 'OPEN' or v_row.closed_at is not null or v_row.resolved_at is not null then
      raise exception '14 FAILED: re-opening did not clear closed_at/resolved_at';
    end if;
    reset role;

    -- ═════════ 9b. STAFF TICKET LIST (check 19) ═════════
    v_stage := '19 staff ticket list';
    -- Distinct activity times (inside one transaction every now() is the same).
    update public.support_threads set last_message_at = now() - interval '1 minute' where id = v_b1;
    update public.support_threads set last_message_at = now() - interval '2 minutes' where id = v_yh;
    update public.support_threads set last_message_at = now() - interval '3 minutes' where id = v_h1;
    update public.support_threads set last_message_at = now() - interval '4 minutes' where id = v_yg;
    update public.support_threads set last_message_at = now() - interval '5 minutes' where id = v_g1;
    select count(*) into v_unread from public.support_messages
     where support_thread_id = v_b1 and sender_type = 'user' and read_at is null;

    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      perform * from public.support_staff_list_threads('OPEN');
      raise exception '19 FAILED: a normal user listed support tickets';
    exception when insufficient_privilege then null;
    end;
    reset role;

    perform set_config('request.jwt.claim.sub', v_s::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select array_agg(l.thread_id order by l.ordinality) into v_ids
      from public.support_staff_list_threads('OPEN', 100) with ordinality l;
    if v_ids is distinct from array[v_b1, v_yh, v_h1, v_yg, v_g1] then
      raise exception '19 FAILED: OPEN list is not exactly the 5 open threads, newest activity first';
    end if;
    select array_agg(l.thread_id order by l.ordinality) into v_ids
      from public.support_staff_list_threads('OPEN', 2) with ordinality l;
    if v_ids is distinct from array[v_b1, v_yh] then
      raise exception '19 FAILED: the first page of 2 is wrong';
    end if;
    select array_agg(l.thread_id order by l.ordinality) into v_ids
      from public.support_staff_list_threads('OPEN', 100,
             (select last_message_at from public.support_threads where id = v_yh), v_yh) with ordinality l;
    if v_ids is distinct from array[v_h1, v_yg, v_g1] then
      raise exception '19 FAILED: the next page does not continue exactly after the first';
    end if;
    select array_agg(l.thread_id) into v_ids from public.support_staff_list_threads('CLOSED') l;
    if v_ids is distinct from array[v_b2] then raise exception '19 FAILED: CLOSED list is wrong'; end if;
    select count(*) into n from public.support_staff_list_threads('RESOLVED');
    if n <> 0 then raise exception '19 FAILED: RESOLVED list should be empty'; end if;
    select * into v_row from public.support_staff_list_threads('OPEN', 1);
    if v_row.thread_id <> v_b1 or v_row.requester_role <> 'guest' or v_row.category <> 'booking' or not v_row.is_booking
       or v_row.user_email is distinct from v_a_email or v_row.user_first_name is distinct from v_a_first_name
       or v_row.booking_experience_title <> 'SUPPORT TEST EXPERIENCE H (rolled back)'
       or v_row.last_message_body is null or v_row.last_message_sender_type not in ('user', 'staff')
       or v_row.unread_count <> v_unread then
      raise exception '19 FAILED: the list row for booking thread X is not as expected';
    end if;
    select * into v_row from public.support_staff_list_threads('OPEN', 100) l where l.thread_id = v_g1;
    if v_row.is_booking or v_row.booking_experience_title is not null then
      raise exception '19 FAILED: a general thread shows booking details in the list';
    end if;
    begin
      perform * from public.support_staff_list_threads('PENDING');
      raise exception '19 FAILED: an unknown status was accepted';
    exception when sqlstate '22023' then null;
    end;
    reset role;

    -- ═════════ 10. public.messages UNTOUCHED (check 17) ═════════
    v_stage := '17 messages unchanged';
    select coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|'
                               || coalesce(with_check, ''), E'\n' order by policyname), '')
      into v_after
      from pg_policies where schemaname = 'public' and tablename = 'messages';
    select v_after || E'\n' || coalesce(string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname), '')
      into v_after
      from pg_trigger t where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal;
    select v_after || E'\n' || md5(pg_get_functiondef('public.notify_on_new_message()'::regprocedure))
      into v_after;
    select v_after || E'\n' || coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
      into v_after
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'messages';
    if v_after is distinct from v_before then
      raise exception '17 FAILED: public.messages policies, triggers, notification trigger or grants changed';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
      raise exception '17 FAILED: public.messages left the realtime publication';
    end if;
    v_stage := '18 realtime';
    -- 18: both support tables publish to realtime (new messages AND live status
    -- changes), and nothing else changed in the publication.
    if (select count(*) from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename in ('support_messages', 'support_threads')) <> 2 then
      raise exception '18 FAILED: support_messages and support_threads are not both in supabase_realtime';
    end if;
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff_members') then
      raise exception '18 FAILED: staff_members must not be published to realtime';
    end if;
    select count(*) into n from public.messages;
    if n <> v_messages_before then raise exception '17 FAILED: support activity wrote to public.messages'; end if;

    -- Guest<->host messaging still works exactly as before on booking X.
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    insert into public.messages (booking_request_item_id, sender_id, body) values (v_item_x, v_a, 'Hello host!');
    reset role;
    perform set_config('request.jwt.claim.sub', v_h::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_h, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.messages where booking_request_item_id = v_item_x and body = 'Hello host!';
    if n <> 1 then raise exception '17 FAILED: the host cannot read the guest''s booking message'; end if;
    reset role;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.messages where booking_request_item_id = v_item_x;
    if n <> 0 then raise exception '17 FAILED: an unrelated user can read booking X''s messages'; end if;
    reset role;
    select count(*) into n from public.notifications
     where user_id = v_h and type = 'new_message' and booking_request_item_id = v_item_x;
    if n <> 1 then raise exception '17 FAILED: the guest->host new_message notification did not fire'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
