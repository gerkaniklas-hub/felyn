-- M3: Stay & Guest Onboarding
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.

-- ── stays ────────────────────────────────────────────────────────────────
-- The central object per spec: one row per accommodation stay a guest adds.
-- onboarding_completed_at is null until the guest finishes the review step;
-- until then, /home sends them back to the start of onboarding.
create table if not exists public.stays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  property_name text not null,
  location_text text not null,
  check_in date not null,
  check_out date not null,
  guest_count integer not null check (guest_count > 0),
  source text not null default 'manual' check (source in ('manual', 'upload', 'import_stub')),
  budget_min integer,
  budget_max integer,
  budget_flexible boolean not null default false,
  check (check_out > check_in),
  check (budget_min is null or budget_min >= 0),
  check (budget_max is null or budget_max >= 0),
  check (budget_min is null or budget_max is null or budget_max >= budget_min),
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stays enable row level security;

drop policy if exists "Users manage their own stays" on public.stays;
create policy "Users manage their own stays" on public.stays
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── stay_occasions ───────────────────────────────────────────────────────
-- Multi-select "what brings you together" — one row per selected occasion.
create table if not exists public.stay_occasions (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null references public.stays(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  occasion text not null check (occasion in (
    'birthday', 'anniversary', 'family_trip', 'friends_getaway',
    'couples_trip', 'wedding', 'team_trip', 'reunion', 'getting_away', 'other'
  )),
  created_at timestamptz not null default now(),
  unique (stay_id, occasion)
);

alter table public.stay_occasions enable row level security;

drop policy if exists "Users manage their own stay occasions" on public.stay_occasions;
create policy "Users manage their own stay occasions" on public.stay_occasions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── stay_preferences ─────────────────────────────────────────────────────
-- 1:1 per stay. Free text for now; AI-extracted structured fields
-- (atmosphere, setting, timing, ...) land in a later milestone.
create table if not exists public.stay_preferences (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null unique references public.stays(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stay_preferences enable row level security;

drop policy if exists "Users manage their own stay preferences" on public.stay_preferences;
create policy "Users manage their own stay preferences" on public.stay_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── stay_dietary_requirements ────────────────────────────────────────────
-- One row per selected dietary type; guest_count is how many guests it
-- applies to, notes carries free-text detail (used for allergy specifics).
create table if not exists public.stay_dietary_requirements (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null references public.stays(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in (
    'vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'allergy', 'other'
  )),
  guest_count integer,
  notes text,
  created_at timestamptz not null default now(),
  unique (stay_id, type),
  check (guest_count is null or guest_count > 0)
);

alter table public.stay_dietary_requirements enable row level security;

drop policy if exists "Users manage their own dietary requirements" on public.stay_dietary_requirements;
create policy "Users manage their own dietary requirements" on public.stay_dietary_requirements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
