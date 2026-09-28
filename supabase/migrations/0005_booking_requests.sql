-- M7.1: Request these experiences
-- Run this once in the Supabase SQL Editor, after 0001-0004 have been applied.
--
-- Minimum schema for a guest to submit a request for their selected plan.
-- No provider accounts, payments, or provider notifications yet — status
-- starts (and, for this milestone, stays) at 'REQUESTED'. The full status
-- enum from the product spec is included as a check constraint up front
-- (same pattern as providers.verification_status in 0002) so later
-- milestones extend behavior, not schema.

-- ── booking_requests ─────────────────────────────────────────────────────
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stay_id uuid not null references public.stays(id) on delete cascade,
  status text not null default 'REQUESTED' check (status in (
    'REQUESTED', 'PENDING_PROVIDER_CONFIRMATION', 'CONFIRMED',
    'DECLINED', 'CANCELLED', 'COMPLETED'
  )),
  estimated_total numeric(10, 2) not null check (estimated_total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.booking_requests enable row level security;

drop policy if exists "Users manage their own booking requests" on public.booking_requests;
create policy "Users manage their own booking requests" on public.booking_requests
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.stays s where s.id = stay_id and s.user_id = auth.uid())
  );

create index if not exists booking_requests_user_id_idx on public.booking_requests(user_id);
create index if not exists booking_requests_stay_id_idx on public.booking_requests(stay_id);

-- ── booking_request_items ────────────────────────────────────────────────
-- One row per experience in the request. experience_id is "on delete
-- restrict" (not cascade) so a historical request can't silently lose rows
-- if an experience is later removed from the catalogue.
create table if not exists public.booking_request_items (
  id uuid primary key default gen_random_uuid(),
  booking_request_id uuid not null references public.booking_requests(id) on delete cascade,
  experience_id uuid not null references public.experiences(id) on delete restrict,
  planned_date date not null,
  planned_moment text not null check (planned_moment in ('morning', 'afternoon', 'evening')),
  guest_count integer not null check (guest_count > 0),
  price_per_person numeric(10, 2) not null check (price_per_person >= 0),
  created_at timestamptz not null default now()
);

alter table public.booking_request_items enable row level security;

drop policy if exists "Users manage their own booking request items" on public.booking_request_items;
create policy "Users manage their own booking request items" on public.booking_request_items
  for all using (
    exists (
      select 1 from public.booking_requests br
      where br.id = booking_request_id and br.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.booking_requests br
      where br.id = booking_request_id and br.user_id = auth.uid()
    )
  );

create index if not exists booking_request_items_booking_request_id_idx on public.booking_request_items(booking_request_id);
create index if not exists booking_request_items_experience_id_idx on public.booking_request_items(experience_id);
