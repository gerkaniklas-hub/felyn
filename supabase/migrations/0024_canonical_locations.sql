-- 0024: canonical locations catalogue (+ nullable experiences.location_id)
--
-- ONE SQL statement (a single DO block), same form as 0023: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- What it does:
--   * creates public.locations: Felyn's own, hand-maintained place hierarchy
--     (island -> towns). Canonical: one row per place; alternative names live in
--     `aliases`, never as extra rows. No geocoding / GIS.
--   * seeds the Tenerife launch catalogue with FIXED ids (70000000-... prefix, the
--     next free one after the 0003 demo seed), so ids are identical in every
--     environment. Mirrors src/lib/locations.ts (slugs match) minus Ibiza.
--   * signed-in users may only READ locations. Nobody but the database owner /
--     service_role can write them: no insert/update/delete grant, no write policy.
--   * adds a NULLABLE experiences.location_id foreign key for the future host-side
--     location picker. No existing experience is touched: every row keeps NULL.
--
-- What it does NOT do: change any existing row, assign locations to experiences,
-- or change any existing policy or grant.
--
-- Run as role `postgres`, the whole file, in one run.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  v_tenerife constant uuid := '70000000-0000-4000-8000-000000000001';
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.locations') is not null then
    raise exception '0024 ABORTED: public.locations already exists';
  end if;
  if to_regclass('public.experiences') is null then
    raise exception '0024 ABORTED: public.experiences does not exist';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'experiences' and column_name = 'location_id') then
    raise exception '0024 ABORTED: public.experiences.location_id already exists';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  create table public.locations (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name text not null check (char_length(btrim(name)) between 1 and 120),
    -- Hierarchy: towns point at their island. A place can't be its own parent, and a
    -- parent that still has children (or experiences) can't be deleted.
    parent_id uuid references public.locations(id) on delete restrict,
    -- Stored on every row (not only the top level) so a place can be displayed and
    -- filtered without walking up the tree.
    region text,
    country text not null check (char_length(btrim(country)) between 1 and 80),
    -- Other names guests may type for the same place. Search help only.
    aliases text[] not null default '{}',
    created_at timestamptz not null default now(),
    check (parent_id is null or parent_id <> id)
  );
  create index locations_parent_id_idx on public.locations(parent_id);

  alter table public.locations enable row level security;
  create policy "Signed-in users read canonical locations" on public.locations
    for select to authenticated using (true);
  revoke all on public.locations from anon, authenticated;
  grant select on public.locations to authenticated;

  insert into public.locations (id, slug, name, parent_id, region, country, aliases) values
    (v_tenerife, 'tenerife', 'Tenerife', null, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000011', 'santa-cruz-de-tenerife', 'Santa Cruz de Tenerife', v_tenerife, 'Canary Islands', 'Spain', '{"Santa Cruz"}'),
    ('70000000-0000-4000-8000-000000000012', 'la-laguna', 'San Cristóbal de La Laguna', v_tenerife, 'Canary Islands', 'Spain', '{"La Laguna"}'),
    ('70000000-0000-4000-8000-000000000013', 'puerto-de-la-cruz', 'Puerto de la Cruz', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000014', 'la-orotava', 'La Orotava', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000015', 'los-realejos', 'Los Realejos', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000016', 'icod-de-los-vinos', 'Icod de los Vinos', v_tenerife, 'Canary Islands', 'Spain', '{"Icod"}'),
    ('70000000-0000-4000-8000-000000000017', 'garachico', 'Garachico', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000018', 'los-gigantes', 'Los Gigantes', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000019', 'adeje', 'Adeje', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000020', 'costa-adeje', 'Costa Adeje', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000021', 'los-cristianos', 'Los Cristianos', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000022', 'playa-de-las-americas', 'Playa de las Américas', v_tenerife, 'Canary Islands', 'Spain', '{"Las Américas"}'),
    ('70000000-0000-4000-8000-000000000023', 'arona', 'Arona', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000024', 'el-medano', 'El Médano', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000025', 'candelaria', 'Candelaria', v_tenerife, 'Canary Islands', 'Spain', '{}'),
    ('70000000-0000-4000-8000-000000000026', 'guimar', 'Güímar', v_tenerife, 'Canary Islands', 'Spain', '{}');

  -- Nullable, no default: a metadata-only change, no table rewrite, every existing row is NULL.
  alter table public.experiences
    add column location_id uuid references public.locations(id) on delete restrict;
  create index experiences_location_id_idx on public.experiences(location_id);

  -- ═════════ 3. POSTCONDITIONS (any failure rolls back everything above) ═════════
  if (select count(*) from public.locations) <> 17 then
    raise exception '0024 ROLLED BACK: expected 17 locations';
  end if;
  if (select count(*) from public.locations where parent_id is null) <> 1
     or not exists (select 1 from public.locations where id = v_tenerife and parent_id is null and slug = 'tenerife') then
    raise exception '0024 ROLLED BACK: Tenerife must be the only top-level location';
  end if;
  if (select count(*) from public.locations where parent_id = v_tenerife) <> 16 then
    raise exception '0024 ROLLED BACK: expected 16 towns under Tenerife';
  end if;
  if exists (select 1 from public.locations where slug = 'ibiza' or name ilike '%ibiza%') then
    raise exception '0024 ROLLED BACK: Ibiza must not be in the launch catalogue';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.locations'::regclass) then
    raise exception '0024 ROLLED BACK: RLS is not enabled on public.locations';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'locations') <> 1
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'locations'
                      and policyname = 'Signed-in users read canonical locations'
                      and cmd = 'SELECT' and roles = '{authenticated}' and qual = 'true') then
    raise exception '0024 ROLLED BACK: locations policies are not exactly the single read policy';
  end if;
  if not has_table_privilege('authenticated', 'public.locations', 'SELECT')
     or has_table_privilege('authenticated', 'public.locations', 'INSERT')
     or has_table_privilege('authenticated', 'public.locations', 'UPDATE')
     or has_table_privilege('authenticated', 'public.locations', 'DELETE')
     or has_table_privilege('anon', 'public.locations', 'SELECT')
     or has_table_privilege('anon', 'public.locations', 'INSERT')
     or has_table_privilege('anon', 'public.locations', 'UPDATE')
     or has_table_privilege('anon', 'public.locations', 'DELETE') then
    raise exception '0024 ROLLED BACK: locations grants are not read-only for authenticated / none for anon';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'experiences'
                   and column_name = 'location_id' and is_nullable = 'YES' and data_type = 'uuid') then
    raise exception '0024 ROLLED BACK: experiences.location_id is missing or not a nullable uuid';
  end if;
  if exists (select 1 from public.experiences where location_id is not null) then
    raise exception '0024 ROLLED BACK: an existing experience has a location_id';
  end if;
end
$migration$;
