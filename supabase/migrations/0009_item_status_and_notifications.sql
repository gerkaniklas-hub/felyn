-- P1.1: Provider Request Management, Calendar & Per-Experience Status
-- Run this once in the Supabase SQL Editor, after 0001-0008 have been applied.
--
-- Two things:
-- 1. Each booking_request_item gets its OWN status (REQUESTED/CONFIRMED/
--    DECLINED), independent of the parent booking_request's status. A
--    provider confirming/declining ONE item never touches
--    booking_requests.status — that stays whatever it already was
--    (REQUESTED/CONFIRMED/WITHDRAWN, from 0006), exactly as required.
-- 2. A minimal notifications table + a trigger that creates a guest
--    notification whenever one of their items is confirmed/declined —
--    written as a SECURITY DEFINER trigger function (same pattern as
--    0008's fix) since the acting role is the PROVIDER, who has no RLS
--    access to insert a row for the GUEST's user_id.

-- ── booking_request_items.status ────────────────────────────────────────
alter table public.booking_request_items
  add column if not exists status text not null default 'REQUESTED'
    check (status in ('REQUESTED', 'CONFIRMED', 'DECLINED'));

-- Providers may UPDATE (status only, enforced by the app — never
-- INSERT/DELETE) items belonging to their own experiences. Additive to the
-- existing owner "for all" policy (0005) and the provider SELECT policy
-- (0007) — neither is changed. This mirrors 0007's "Providers view items
-- for their experiences" shape exactly, so it carries no RLS-recursion
-- risk (it only touches experiences/providers, never booking_requests).
drop policy if exists "Providers update items for their experiences" on public.booking_request_items;
create policy "Providers update items for their experiences" on public.booking_request_items
  for update to authenticated
  using (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = booking_request_items.experience_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = booking_request_items.experience_id
        and p.user_id = auth.uid()
    )
  );

-- ── notifications ────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  booking_request_item_id uuid references public.booking_request_items(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

drop policy if exists "Users manage their own notifications" on public.notifications;
create policy "Users manage their own notifications" on public.notifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists notifications_user_id_idx on public.notifications(user_id);

-- ── auto-notify the guest on item status change ─────────────────────────
-- SECURITY DEFINER (+ pinned search_path) so this can insert a notification
-- row for the GUEST while running as the PROVIDER's session — the same
-- RLS-bypass-via-table-owner mechanism 0008 already relies on. This is
-- exactly the kind of event hook a later push-notification worker can hang
-- off of (e.g. a second trigger, or a listener on this same table).
create or replace function public.notify_guest_on_item_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  guest_user_id uuid;
  experience_title text;
  provider_display_name text;
  moment_word text;
begin
  if new.status = old.status or new.status not in ('CONFIRMED', 'DECLINED') then
    return new;
  end if;

  select br.user_id into guest_user_id
  from public.booking_requests br
  where br.id = new.booking_request_id;

  select e.title, p.display_name into experience_title, provider_display_name
  from public.experiences e
  join public.providers p on p.id = e.provider_id
  where e.id = new.experience_id;

  moment_word := lower(new.planned_moment);

  insert into public.notifications (user_id, type, title, body, booking_request_item_id)
  values (
    guest_user_id,
    case when new.status = 'CONFIRMED' then 'booking_item_confirmed' else 'booking_item_declined' end,
    case when new.status = 'CONFIRMED' then 'Your experience is confirmed' else 'An experience couldn''t be confirmed' end,
    case
      when new.status = 'CONFIRMED' then
        coalesce(provider_display_name, 'Your host') || ' has confirmed your ' || coalesce(experience_title, 'experience')
          || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '.'
      else
        coalesce(provider_display_name, 'Your host') || ' couldn''t confirm your ' || coalesce(experience_title, 'experience')
          || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '. You can request another experience for that slot.'
    end,
    new.id
  );

  return new;
end;
$$;

drop trigger if exists booking_request_item_status_notify on public.booking_request_items;
create trigger booking_request_item_status_notify
  after update of status on public.booking_request_items
  for each row
  execute function public.notify_guest_on_item_status_change();
