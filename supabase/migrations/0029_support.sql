-- 0029: Felyn support — staff authorization, support threads and support messages
--
-- ONE SQL statement (a single DO block), same form as 0023-0028: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: guests and hosts need to reach the Felyn team inside Felyn (a "Felyn Team"
-- conversation in Messages), and the Felyn team needs an internal ticket view. Support
-- deliberately does NOT reuse public.messages: a messages row is one booking's
-- guest<->host conversation and BOTH participants can read it (0014), so a
-- booking-linked support conversation stored there would be visible to the host.
-- Support therefore lives in its own tables with its own rules, and public.messages,
-- its policies, its notification trigger and its realtime setup are not touched.
--
-- What it does:
--   * public.staff_members — who is Felyn staff (user_id, role 'support'|'admin').
--     RLS on with NO policies and no client privileges: nobody can read or change it
--     through the API. Rows are added by hand in the SQL Editor (see README).
--   * public.is_felyn_staff() — true when auth.uid() has a staff_members row. The
--     database-side staff check used by the policies and functions below.
--   * public.support_threads — one ticket. References the existing
--     booking_request_items.id when it is about a booking (nothing about the booking is
--     copied). requester_role ('guest'|'host') keeps the two sides of an account that is
--     both guest and host apart. status OPEN | RESOLVED | CLOSED, with resolved_at /
--     closed_at kept consistent by check constraints.
--     Duplicate prevention (partial unique indexes, so double clicks and races cannot
--     create two tickets):
--       - at most one non-CLOSED general thread per (user_id, requester_role);
--       - at most one non-CLOSED thread per (user_id, requester_role, booking item).
--     A guest's and a host's thread about the same booking are always separate rows
--     (different user_id, or for one account acting as both: different requester_role).
--   * public.support_messages — one message; sender_type 'user'|'staff', sender_user_id
--     records the real account for audit (the app shows staff as "Felyn Team").
--     Body 1-2000 characters, as public.messages.
--   * public.notifications.support_thread_id — additive nullable link
--     (on delete set null) for the in-app "Felyn Team replied" notification.
--   * triggers on support_messages: keep the thread's last_message_at/updated_at
--     current; on a staff reply, add a 'support_reply' notification for the thread's
--     owner (same in-app notification table 0009/0014/0020 use; no email).
--   * realtime: support_messages (new messages) and support_threads (status changes)
--     are added to supabase_realtime (as 0014 did for messages); realtime only
--     delivers rows the subscriber may SELECT, so a guest only ever receives their own.
--
-- Access model:
--   * Reads: authenticated users may SELECT only their own threads and the messages in
--     them; staff may SELECT all threads and messages. anon gets nothing.
--   * Writes: NO client may INSERT, UPDATE or DELETE any support table directly. Every
--     write goes through one of the SECURITY DEFINER functions below, each of which
--     checks auth.uid() itself (and, for staff functions, is_felyn_staff()):
--       support_open_thread(requester_role, category, body, booking_request_item_id)
--       support_send_message(thread_id, body)            -- thread owner
--       support_mark_read(thread_id)                     -- thread owner or staff
--       support_staff_reply(thread_id, body)             -- staff
--       support_staff_set_status(thread_id, status)      -- staff
--       support_staff_thread_context(thread_id)          -- staff
--       support_staff_list_threads(status, limit, before) -- staff (the ticket list)
--   * Error codes the app can rely on:
--       42501  not signed in / not allowed (not staff, host role without a host profile)
--       P0002  not found — also for a thread or booking that exists but isn't yours,
--              so another user's booking or ticket is never revealed
--       22023  invalid input (role, category, status, empty or too long body)
--       55000  the thread is CLOSED
--       23505  staff re-open/resolve blocked: the user already has a newer open thread
--
-- What it does NOT do: change public.messages (table, policies, grants, triggers,
-- realtime), any booking table, any existing policy or grant, or the email outbox.
-- No staff account is created; no email address appears anywhere.
--
-- Run as role `postgres`, the whole file, in one run, after 0027. It does not depend
-- on 0028 (the email outbox) and can be applied before or after it.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.staff_members') is not null
     or to_regclass('public.support_threads') is not null
     or to_regclass('public.support_messages') is not null then
    raise exception '0029 ABORTED: a support table already exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and (p.proname = 'is_felyn_staff' or p.proname like 'support\_%')) then
    raise exception '0029 ABORTED: a support function already exists';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'notifications' and column_name = 'support_thread_id') then
    raise exception '0029 ABORTED: notifications.support_thread_id already exists';
  end if;
  -- Every existing column the functions below read (no guessing: abort if one is missing).
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'booking_request_items' and column_name in
               ('id', 'booking_request_id', 'experience_id', 'planned_date', 'planned_moment',
                'preferred_time', 'guest_count', 'status'))
          or (table_name = 'booking_requests' and column_name in ('id', 'user_id', 'stay_id'))
          or (table_name = 'experiences' and column_name in ('id', 'provider_id', 'title'))
          or (table_name = 'providers' and column_name in ('id', 'user_id', 'display_name'))
          or (table_name = 'stays' and column_name in ('id', 'property_name'))
          or (table_name = 'user_contact_details' and column_name in ('user_id', 'phone_number'))
          or (table_name = 'notifications' and column_name in
               ('user_id', 'type', 'title', 'body', 'booking_request_item_id')))) <> 26 then
    raise exception '0029 ABORTED: an expected booking/provider/contact/notification column is missing';
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception '0029 ABORTED: publication supabase_realtime is missing';
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    raise exception '0029 ABORTED: public.messages is not in supabase_realtime (0014 baseline differs)';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'messages') <> 5 then
    raise exception '0029 ABORTED: public.messages does not have the 5 expected policies (0014/0021 baseline differs)';
  end if;

  -- ═════════ 2. MIGRATION ═════════
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

  -- ═════════ 3. POSTCONDITIONS (any failure rolls back everything above) ═════════
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'staff_members') <> 3
     or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'support_threads') <> 11
     or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'support_messages') <> 7 then
    raise exception '0029 ROLLED BACK: support table columns are not as intended';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.support_threads'::regclass and contype = 'f'
                   and confrelid = 'public.booking_request_items'::regclass and confdeltype = 'r')
     or not exists (select 1 from pg_constraint
                    where conrelid = 'public.support_messages'::regclass and contype = 'f'
                      and confrelid = 'public.support_threads'::regclass and confdeltype = 'c')
     or not exists (select 1 from pg_constraint
                    where conrelid = 'public.notifications'::regclass and contype = 'f'
                      and confrelid = 'public.support_threads'::regclass and confdeltype = 'n') then
    raise exception '0029 ROLLED BACK: foreign keys are not as intended';
  end if;
  if (select count(*) from pg_indexes
      where schemaname = 'public' and tablename = 'support_threads'
        and indexname in ('support_threads_one_open_general_idx', 'support_threads_one_open_per_booking_idx')
        and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%WHERE%') <> 2 then
    raise exception '0029 ROLLED BACK: duplicate-prevention indexes are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.staff_members'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.support_threads'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.support_messages'::regclass) then
    raise exception '0029 ROLLED BACK: RLS is not enabled on every support table';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'staff_members')
     or (select count(*) from pg_policies
         where schemaname = 'public' and tablename in ('support_threads', 'support_messages')
           and cmd = 'SELECT' and roles = '{authenticated}') <> 4
     or (select count(*) from pg_policies
         where schemaname = 'public' and tablename in ('support_threads', 'support_messages')) <> 4 then
    raise exception '0029 ROLLED BACK: support policies are not as intended';
  end if;
  if has_table_privilege('anon', 'public.staff_members', 'SELECT')
     or has_table_privilege('authenticated', 'public.staff_members', 'SELECT')
     or has_table_privilege('authenticated', 'public.staff_members', 'INSERT')
     or has_table_privilege('authenticated', 'public.staff_members', 'UPDATE')
     or has_table_privilege('authenticated', 'public.staff_members', 'DELETE')
     or has_table_privilege('anon', 'public.support_threads', 'SELECT')
     or has_table_privilege('anon', 'public.support_messages', 'SELECT')
     or not has_table_privilege('authenticated', 'public.support_threads', 'SELECT')
     or not has_table_privilege('authenticated', 'public.support_messages', 'SELECT')
     or has_table_privilege('authenticated', 'public.support_threads', 'INSERT')
     or has_table_privilege('authenticated', 'public.support_threads', 'UPDATE')
     or has_table_privilege('authenticated', 'public.support_threads', 'DELETE')
     or has_table_privilege('authenticated', 'public.support_threads', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.support_messages', 'INSERT')
     or has_table_privilege('authenticated', 'public.support_messages', 'UPDATE')
     or has_table_privilege('authenticated', 'public.support_messages', 'DELETE')
     or has_table_privilege('authenticated', 'public.support_messages', 'TRUNCATE')
     or has_column_privilege('authenticated', 'public.support_messages', 'sender_type', 'UPDATE')
     or has_column_privilege('authenticated', 'public.support_threads', 'status', 'UPDATE') then
    raise exception '0029 ROLLED BACK: support table privileges are not as intended';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('is_felyn_staff', 'support_open_thread', 'support_send_message', 'support_mark_read',
                                 'support_staff_reply', 'support_staff_set_status', 'support_staff_thread_context',
                                 'support_staff_list_threads')
               and (not p.prosecdef
                    or not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path=')))) then
    raise exception '0029 ROLLED BACK: a support function is not SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.is_felyn_staff()', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_open_thread(text,text,text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_send_message(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_mark_read(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_staff_reply(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_staff_set_status(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_staff_thread_context(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_staff_list_threads(text,integer,timestamptz,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.support_staff_list_threads(text,integer,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.support_messages_touch_thread()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.support_messages_notify_staff_reply()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_felyn_staff()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.support_open_thread(text,text,text,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.support_staff_reply(uuid,text)', 'EXECUTE') then
    raise exception '0029 ROLLED BACK: support function privileges are not as intended';
  end if;
  if (select count(*) from pg_trigger
      where tgrelid = 'public.support_messages'::regclass and not tgisinternal
        and tgname in ('support_messages_touch_thread', 'support_messages_notify_staff_reply')) <> 2 then
    raise exception '0029 ROLLED BACK: support_messages triggers are missing';
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'support_messages')
     or not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'support_threads')
     or not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    raise exception '0029 ROLLED BACK: realtime publication is not as intended';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'messages') <> 5 then
    raise exception '0029 ROLLED BACK: public.messages policies changed';
  end if;
  if exists (select 1 from public.staff_members) or exists (select 1 from public.support_threads) then
    raise exception '0029 ROLLED BACK: support tables are not empty';
  end if;
end
$migration$;
