-- M4: Provider & Experience Foundation
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.
--
-- This is the structured supply-side catalogue (providers + experiences),
-- NOT the recommendation engine, provider dashboard, or booking flow.
-- Those come later and are designed to plug into provider_id/experience_id
-- without reshaping this schema.

-- ── providers ────────────────────────────────────────────────────────────
-- One profile per provider. user_id is nullable+unique on purpose: demo
-- providers (Maria, Lucas, Sofia, Daniel) are fictional and have no real
-- Felyn login yet, so their row is "unclaimed" (user_id = null). A future
-- provider-signup flow claims a profile by setting user_id, or a brand new
-- provider gets a fresh row with user_id set from the start. Keeping
-- provider_id separate from user_id (rather than using auth.users.id as the
-- primary key) is what lets a business/team operate a provider profile
-- later without redesigning this table.
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  display_name text not null,
  profile_photo_url text,
  bio text,
  base_location text,
  -- Controlled status, not a boolean, so a future 'suspended' state can be
  -- added later by extending this check constraint (no redesign needed).
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.providers enable row level security;

drop policy if exists "Providers manage their own profile" on public.providers;
create policy "Providers manage their own profile" on public.providers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No guest SELECT policy on this base table on purpose — verification_status
-- and user_id must never reach guests (see provider_public_profiles, created
-- further below once the experiences table it depends on exists).
-- Ratings/review_count are deliberately NOT columns here: they will be
-- computed from real reviews in a later milestone, never stored/edited here.

-- ── provider_languages ───────────────────────────────────────────────────
create table if not exists public.provider_languages (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  language text not null,
  unique (provider_id, language)
);

alter table public.provider_languages enable row level security;

drop policy if exists "Providers manage their own languages" on public.provider_languages;
create policy "Providers manage their own languages" on public.provider_languages
  for all using (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  );

-- Guest read policy for this table is defined further below, after
-- public.experiences exists (its USING clause references that table).

create index if not exists provider_languages_provider_id_idx on public.provider_languages(provider_id);

-- ── provider_gallery ─────────────────────────────────────────────────────
-- The provider's personal gallery (who they are) — separate from any one
-- experience's own gallery below.
create table if not exists public.provider_gallery (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  image_url text not null,
  caption text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.provider_gallery enable row level security;

drop policy if exists "Providers manage their own gallery" on public.provider_gallery;
create policy "Providers manage their own gallery" on public.provider_gallery
  for all using (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  );

-- Guest read policy for this table is defined further below, after
-- public.experiences exists (its USING clause references that table).

create index if not exists provider_gallery_provider_id_idx on public.provider_gallery(provider_id);

-- ── service_locations ────────────────────────────────────────────────────
-- Where a provider currently offers experiences — NOT the same thing as
-- their base_location. A provider based in Tenerife may temporarily offer
-- experiences in Bali; starts_at/ends_at + is_current model that without
-- building a real calendar system yet.
create table if not exists public.service_locations (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  location_text text not null,
  latitude numeric,
  longitude numeric,
  starts_at date,
  ends_at date,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or ends_at >= starts_at)
);

alter table public.service_locations enable row level security;

drop policy if exists "Providers manage their own service locations" on public.service_locations;
create policy "Providers manage their own service locations" on public.service_locations
  for all using (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  );

-- Guest read policy for this table is defined further below, after
-- public.experiences exists (its USING clause references that table).

create index if not exists service_locations_provider_id_idx on public.service_locations(provider_id);

-- ── experiences ──────────────────────────────────────────────────────────
-- Platform is Food & Drink only for now; category is kept as an extensible
-- text+check (like verification_status) so future categories (Wellness,
-- Activities, ...) are a constraint change, not a schema redesign.
create table if not exists public.experiences (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  title text not null,
  short_description text,
  description text,
  category text not null check (category in ('food', 'drink', 'food_drink')),
  cuisine text,
  price_per_person numeric(10, 2) not null check (price_per_person >= 0),
  currency text not null default 'EUR',
  min_guests integer not null check (min_guests > 0),
  max_guests integer not null check (max_guests >= min_guests),
  duration_minutes integer not null check (duration_minutes > 0),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.experiences enable row level security;

drop policy if exists "Providers manage their own experiences" on public.experiences;
create policy "Providers manage their own experiences" on public.experiences
  for all using (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.providers p where p.id = provider_id and p.user_id = auth.uid())
  );

drop policy if exists "Guests read published experiences" on public.experiences;
create policy "Guests read published experiences" on public.experiences
  for select to authenticated using (published = true);

create index if not exists experiences_provider_id_idx on public.experiences(provider_id);
create index if not exists experiences_published_idx on public.experiences(published);

-- ── provider_public_profiles ────────────────────────────────────────────
-- Safe, guest-readable subset of providers: only the columns a guest is
-- ever allowed to see, for providers that have at least one published
-- experience. Views in Postgres check permissions as the view's OWNER by
-- default (the migration-running role), so this view can read the
-- owner-only-RLS providers table and re-expose just these columns to
-- guests — verification_status and user_id are never included, so they
-- can never leak through this path regardless of what a client requests.
-- Defined here, after experiences, since it references that table.
create or replace view public.provider_public_profiles as
select
  p.id,
  p.display_name,
  p.profile_photo_url,
  p.bio,
  p.base_location,
  p.created_at
from public.providers p
where exists (
  select 1 from public.experiences e
  where e.provider_id = p.id and e.published = true
);

revoke all on public.provider_public_profiles from public, anon;
grant select on public.provider_public_profiles to authenticated;

-- ── deferred guest-read policies ────────────────────────────────────────
-- These belong to provider_languages / provider_gallery / service_locations
-- (defined earlier above) but are created here, after public.experiences
-- exists, because their USING clause queries it.

drop policy if exists "Guests read languages of published providers" on public.provider_languages;
create policy "Guests read languages of published providers" on public.provider_languages
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.provider_id = provider_languages.provider_id and e.published = true
    )
  );

drop policy if exists "Guests read gallery of published providers" on public.provider_gallery;
create policy "Guests read gallery of published providers" on public.provider_gallery
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.provider_id = provider_gallery.provider_id and e.published = true
    )
  );

drop policy if exists "Guests read service locations of published providers" on public.service_locations;
create policy "Guests read service locations of published providers" on public.service_locations
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.provider_id = service_locations.provider_id and e.published = true
    )
  );

-- ── experience_attributes ───────────────────────────────────────────────
-- Flexible soft-matching tags only (atmosphere, setting, style, occasion,
-- specialty, dietary-friendliness). Hard constraints (price, capacity,
-- duration, budget) stay as proper columns on experiences/stays and are
-- handled by application filtering, never stored here.
create table if not exists public.experience_attributes (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.experiences(id) on delete cascade,
  attribute_type text not null check (attribute_type in (
    'atmosphere', 'setting', 'style', 'occasion', 'specialty', 'dietary'
  )),
  attribute_value text not null,
  unique (experience_id, attribute_type, attribute_value)
);

alter table public.experience_attributes enable row level security;

drop policy if exists "Providers manage their own experience attributes" on public.experience_attributes;
create policy "Providers manage their own experience attributes" on public.experience_attributes
  for all using (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "Guests read attributes of published experiences" on public.experience_attributes;
create policy "Guests read attributes of published experiences" on public.experience_attributes
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.id = experience_attributes.experience_id and e.published = true
    )
  );

create index if not exists experience_attributes_experience_id_idx on public.experience_attributes(experience_id);
create index if not exists experience_attributes_type_idx on public.experience_attributes(attribute_type);

-- ── experience_gallery ───────────────────────────────────────────────────
-- What THIS experience looks like — separate from the provider's own
-- personal gallery above.
create table if not exists public.experience_gallery (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.experiences(id) on delete cascade,
  image_url text not null,
  caption text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.experience_gallery enable row level security;

drop policy if exists "Providers manage their own experience gallery" on public.experience_gallery;
create policy "Providers manage their own experience gallery" on public.experience_gallery
  for all using (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "Guests read gallery of published experiences" on public.experience_gallery;
create policy "Guests read gallery of published experiences" on public.experience_gallery
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.id = experience_gallery.experience_id and e.published = true
    )
  );

create index if not exists experience_gallery_experience_id_idx on public.experience_gallery(experience_id);

-- ── experience_availability ─────────────────────────────────────────────
-- Intentionally simple MVP availability: date windows an experience could
-- potentially be offered in, not a real provider calendar. Good enough for
-- the future matching engine to hard-filter by a guest's stay dates.
create table if not exists public.experience_availability (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.experiences(id) on delete cascade,
  available_from date not null,
  available_until date not null,
  start_time time,
  end_time time,
  max_bookings integer,
  created_at timestamptz not null default now(),
  check (available_until >= available_from),
  check (max_bookings is null or max_bookings > 0)
);

alter table public.experience_availability enable row level security;

drop policy if exists "Providers manage their own availability" on public.experience_availability;
create policy "Providers manage their own availability" on public.experience_availability
  for all using (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = experience_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "Guests read availability of published experiences" on public.experience_availability;
create policy "Guests read availability of published experiences" on public.experience_availability
  for select to authenticated using (
    exists (
      select 1 from public.experiences e
      where e.id = experience_availability.experience_id and e.published = true
    )
  );

create index if not exists experience_availability_experience_id_idx on public.experience_availability(experience_id);
