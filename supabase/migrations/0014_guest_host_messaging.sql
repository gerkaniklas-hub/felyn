-- P2: Guest-host messaging
-- Run this once in the Supabase SQL Editor, after 0001-0013 have been applied.
--
-- One conversation per booking_request_item — there is deliberately no
-- separate `conversations` table. "The conversation" for an item is simply
-- every row in `messages` sharing its booking_request_item_id. The two
-- participants are never stored redundantly on the message itself; both
-- are resolved LIVE on every read/write from the existing relationships:
--   guest = booking_requests.user_id      (via the item's parent request)
--   host  = providers.user_id             (via the item's experience)
-- This means neither RLS nor the notification trigger below ever trusts a
-- client-supplied participant/recipient id — both are always looked up
-- from the database's own foreign keys.

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  booking_request_item_id uuid not null references public.booking_request_items(id) on delete cascade,
  -- Deliberately NOT "on delete cascade": cascading here would silently
  -- delete the OTHER participant's copy of a conversation too if this
  -- sender's account were ever removed, destroying real booking history
  -- the same way 0010 specifically chose "on delete restrict" over cascade
  -- for stays -> booking_requests. There is no account-deletion feature
  -- anywhere in this app yet, so RESTRICT costs nothing today; if one is
  -- built later it must make its own deliberate choice here (anonymize the
  -- sender vs. block the deletion vs. archive), not silently inherit this.
  sender_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index messages_thread_idx on public.messages (booking_request_item_id, created_at);
create index messages_unread_idx on public.messages (booking_request_item_id) where read_at is null;

alter table public.messages enable row level security;

-- ── column-level privilege lockdown ─────────────────────────────────────
-- Belt-and-braces below the RLS policies further down: no authenticated
-- client can ever UPDATE body/sender_id/booking_request_item_id through
-- any policy, because the UPDATE privilege on those columns is revoked
-- entirely at the grant level (Postgres checks this before RLS is even
-- evaluated). The only column any client can ever set via UPDATE is
-- read_at — and even that value itself is force-overwritten by a trigger
-- below, never taken from the client.
revoke update on public.messages from authenticated;
grant update (read_at) on public.messages to authenticated;

-- ── SELECT: either genuine participant, any status — history is permanent.
-- Knowing a booking_request_item's UUID grants nothing on its own; every
-- policy below re-derives the caller's relationship to that specific item
-- from booking_requests/experiences/providers on every request. Neither of
-- those tables' own policies reference `messages`, so this cannot create a
-- recursive policy cycle the way booking_requests <-> booking_request_items
-- once did (see 0008) — the dependency here is one-directional.
create policy "Guests view messages for their own items" on public.messages
  for select to authenticated using (
    exists (
      select 1 from public.booking_request_items bri
      join public.booking_requests br on br.id = bri.booking_request_id
      where bri.id = messages.booking_request_item_id
        and br.user_id = auth.uid()
    )
  );

create policy "Providers view messages for their experiences" on public.messages
  for select to authenticated using (
    exists (
      select 1 from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
      where bri.id = messages.booking_request_item_id
        and p.user_id = auth.uid()
    )
  );

-- ── INSERT: sender must genuinely BE a participant, item must be active ──
-- Re-evaluated against the LIVE row on every single insert attempt — a
-- stale client (or a direct API call, or anything arriving via a realtime
-- channel, which still has to go through an ordinary insert to exist at
-- all) that believes an item is still REQUESTED gets a hard rejection the
-- instant the database itself says DECLINED/WITHDRAWN. The application
-- layer additionally always sets sender_id from the server-verified
-- session, never from client input (see lib/messaging/actions.ts) — this
-- check is the non-bypassable backstop either way.
create policy "Guests send messages on their own active items" on public.messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.booking_request_items bri
      join public.booking_requests br on br.id = bri.booking_request_id
      where bri.id = messages.booking_request_item_id
        and br.user_id = auth.uid()
        and bri.status in ('REQUESTED', 'CONFIRMED')
    )
  );

create policy "Providers send messages on their own active items" on public.messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
      where bri.id = messages.booking_request_item_id
        and p.user_id = auth.uid()
        and bri.status in ('REQUESTED', 'CONFIRMED')
    )
  );

-- ── UPDATE: only the RECIPIENT, only null -> read, never reversible ─────
-- USING is evaluated against the OLD row (must currently be unread and
-- belong to someone who is NOT the sender); WITH CHECK is evaluated
-- against the NEW row (must now be read). Together the transition is
-- strictly one-way and single-use: once read_at is set, no policy below
-- ever matches that row again for anyone, so it can never be reset or
-- reapplied. Combined with the column-level grant above, this is the only
-- kind of write a client can make to an existing message.
create policy "Recipients mark messages read" on public.messages
  for update to authenticated
  using (
    sender_id <> auth.uid()
    and read_at is null
    and (
      exists (
        select 1 from public.booking_request_items bri
        join public.booking_requests br on br.id = bri.booking_request_id
        where bri.id = messages.booking_request_item_id and br.user_id = auth.uid()
      )
      or exists (
        select 1 from public.booking_request_items bri
        join public.experiences e on e.id = bri.experience_id
        join public.providers p on p.id = e.provider_id
        where bri.id = messages.booking_request_item_id and p.user_id = auth.uid()
      )
    )
  )
  with check (read_at is not null);

-- The client can only ever prove "read_at is not null" (per the policy
-- above), never a specific value — this trigger forces it to the
-- database's own clock on every such update, so "when was this read" is
-- never client-controlled even indirectly.
create or replace function public.set_message_read_at()
returns trigger
language plpgsql
as $$
begin
  new.read_at := now();
  return new;
end;
$$;

create trigger messages_force_read_at
  before update of read_at on public.messages
  for each row
  execute function public.set_message_read_at();

-- ── realtime ──────────────────────────────────────────────────────────────
-- Supabase enforces the SAME RLS policies above on realtime subscriptions
-- as on ordinary queries (using the subscriber's own JWT) — a client can
-- only ever receive change events for rows it could already SELECT, so no
-- separate authorization layer is needed for live updates.
alter publication supabase_realtime add table public.messages;

-- ── notification on new message ─────────────────────────────────────────
-- Mirrors 0009's notify_guest_on_item_status_change exactly: SECURITY
-- DEFINER so it can insert a notifications row for the RECIPIENT while
-- running as the SENDER's own session (the same RLS-bypass-via-table-
-- owner mechanism 0008 already relies on). Both real participants are
-- resolved from the booking relationships themselves, never from anything
-- the client supplied; the recipient is always whichever one did NOT send
-- this message, and only that one user ever gets notified. No schema
-- change to `notifications` — booking_request_item_id already exists on
-- it and deep-links straight to this exact conversation, and `type` has no
-- check constraint restricting its values, so 'new_message' needs none.
create or replace function public.notify_on_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  guest_user_id uuid;
  host_user_id uuid;
  recipient_id uuid;
  experience_title text;
begin
  select br.user_id into guest_user_id
  from public.booking_request_items bri
  join public.booking_requests br on br.id = bri.booking_request_id
  where bri.id = new.booking_request_item_id;

  select p.user_id, e.title into host_user_id, experience_title
  from public.booking_request_items bri
  join public.experiences e on e.id = bri.experience_id
  join public.providers p on p.id = e.provider_id
  where bri.id = new.booking_request_item_id;

  recipient_id := case when new.sender_id = guest_user_id then host_user_id else guest_user_id end;

  -- An unclaimed demo provider (providers.user_id is null — see 0002) has
  -- no real user to notify; nothing to do rather than insert a notification
  -- with a null user_id.
  if recipient_id is null then
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, booking_request_item_id)
  values (
    recipient_id,
    'new_message',
    'New message',
    'You have a new message about ' || coalesce(experience_title, 'your experience') || '.',
    new.booking_request_item_id
  );

  return new;
end;
$$;

create trigger messages_notify_on_insert
  after insert on public.messages
  for each row
  execute function public.notify_on_new_message();
