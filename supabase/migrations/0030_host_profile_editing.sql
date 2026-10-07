-- 0030: approved hosts edit their own public profile (name, bio, location, photo)
--
-- ONE SQL statement (a single DO block), same form as 0023-0029: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: since 0023 the providers table is read-only for every client (hosts can only
-- SELECT their own row; the row itself is created by felyn_admin.approve_host_application).
-- Hosts now manage the information guests see on their public profile themselves.
--
-- What it does, on public.providers only:
--   * column-limited UPDATE: authenticated may update ONLY display_name, bio,
--     base_location and profile_photo_url. id, user_id, verification_status,
--     created_at and updated_at stay client-unwritable (no table-level UPDATE).
--   * one UPDATE policy, "Approved hosts update their own public profile": only the
--     row whose user_id is the caller (auth.uid()) and whose verification_status is
--     'verified'. Host A can never reach host B's row; a guest has no row; anon has
--     no privilege at all.
--   * length limits (CHECK constraints): display_name 1-80 characters (trimmed),
--     bio up to 1000, base_location up to 120.
--   * a BEFORE UPDATE trigger, providers_before_update(): keeps updated_at current,
--     and when a signed-in client changes profile_photo_url it must be NULL or this
--     provider's own photo in the experience-images bucket:
--       https://<host>/storage/v1/object/public/experience-images/<this provider id>/profile/<file>
--     (that bucket's 0022 storage policies already let a host write only under their
--     own "<provider_id>/" folder; this stops a host pointing their photo anywhere else).
--
-- What it does NOT do: change any row; change the existing SELECT policy, the
-- provider_public_profiles view (who appears publicly is unchanged), or any other
-- table's policies or grants. Languages need no change: provider_languages keeps its
-- 0002 owner policy (checked in section 1).
--
-- Run as role `postgres`, the whole file, in one run, after 0029.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  -- providers is exactly as 0023 left it: one SELECT policy, no client writes.
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'providers') <> 1
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'providers'
                      and policyname = 'Providers read their own profile' and cmd = 'SELECT') then
    raise exception '0030 ABORTED: providers policies are not exactly 0023''s "Providers read their own profile"';
  end if;
  if has_table_privilege('authenticated', 'public.providers', 'UPDATE')
     or has_table_privilege('anon', 'public.providers', 'UPDATE')
     or has_table_privilege('authenticated', 'public.providers', 'INSERT')
     or has_table_privilege('authenticated', 'public.providers', 'DELETE') then
    raise exception '0030 ABORTED: providers grants are not 0023''s read-only state';
  end if;
  for r in select unnest(array['display_name', 'bio', 'base_location', 'profile_photo_url']) as col loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'providers'
                     and column_name = r.col and data_type = 'text') then
      raise exception '0030 ABORTED: public.providers.% is missing or not text', r.col;
    end if;
  end loop;
  if exists (select 1 from pg_constraint where conrelid = 'public.providers'::regclass
             and conname in ('providers_display_name_length_check', 'providers_bio_length_check',
                             'providers_base_location_length_check')) then
    raise exception '0030 ABORTED: a providers length constraint already exists';
  end if;
  if to_regprocedure('public.providers_before_update()') is not null then
    raise exception '0030 ABORTED: public.providers_before_update() already exists';
  end if;
  -- Existing rows must already fit the new limits (the constraints would refuse them).
  if exists (select 1 from public.providers
             where char_length(btrim(display_name)) not between 1 and 80
                or char_length(bio) > 1000
                or char_length(base_location) > 120) then
    raise exception '0030 ABORTED: an existing provider row exceeds the new length limits';
  end if;
  -- Languages: hosts already add/remove their own through 0002's owner policy.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'provider_languages'
                   and policyname = 'Providers manage their own languages' and cmd = 'ALL')
     or not has_table_privilege('authenticated', 'public.provider_languages', 'SELECT')
     or not has_table_privilege('authenticated', 'public.provider_languages', 'INSERT')
     or not has_table_privilege('authenticated', 'public.provider_languages', 'DELETE') then
    raise exception '0030 ABORTED: provider_languages is not as 0002 left it (owner policy + SELECT/INSERT/DELETE)';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  alter table public.providers
    add constraint providers_display_name_length_check check (char_length(btrim(display_name)) between 1 and 80),
    add constraint providers_bio_length_check check (bio is null or char_length(bio) <= 1000),
    add constraint providers_base_location_length_check check (base_location is null or char_length(base_location) <= 120);

  create function public.providers_before_update()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    -- A signed-in client (auth.uid() set) may only point the photo at its own
    -- profile folder in the public experience-images bucket, or clear it.
    if auth.uid() is not null
       and new.profile_photo_url is distinct from old.profile_photo_url
       and new.profile_photo_url is not null
       and new.profile_photo_url !~ ('^https://[^/]+/storage/v1/object/public/experience-images/'
                                     || new.id::text || '/profile/[A-Za-z0-9._-]+$') then
      raise exception 'profile_photo_url must be this host''s own uploaded profile photo'
        using errcode = '22023';
    end if;
    new.updated_at := now();
    return new;
  end $fn$;
  revoke execute on function public.providers_before_update() from public, anon, authenticated;
  create trigger providers_before_update
    before update on public.providers
    for each row execute function public.providers_before_update();

  grant update (display_name, bio, base_location, profile_photo_url) on public.providers to authenticated;

  create policy "Approved hosts update their own public profile" on public.providers
    for update to authenticated
    using (auth.uid() = user_id and verification_status = 'verified')
    with check (auth.uid() = user_id and verification_status = 'verified');

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'providers') <> 2
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'providers'
                    and policyname = 'Approved hosts update their own public profile' and cmd = 'UPDATE') then
    raise exception '0030 VERIFY FAILED: providers policies are not exactly read-own + update-own';
  end if;
  if has_table_privilege('authenticated', 'public.providers', 'UPDATE')
     or has_table_privilege('authenticated', 'public.providers', 'INSERT')
     or has_table_privilege('authenticated', 'public.providers', 'DELETE')
     or has_table_privilege('anon', 'public.providers', 'UPDATE')
     or has_table_privilege('anon', 'public.providers', 'INSERT')
     or has_table_privilege('anon', 'public.providers', 'DELETE') then
    raise exception '0030 VERIFY FAILED: a table-level write privilege exists on providers';
  end if;
  for r in select column_name::text as col from information_schema.columns
           where table_schema = 'public' and table_name = 'providers' loop
    if has_column_privilege('anon', 'public.providers', r.col, 'UPDATE') then
      raise exception '0030 VERIFY FAILED: anon can update providers.%', r.col;
    end if;
    if has_column_privilege('authenticated', 'public.providers', r.col, 'UPDATE')
       <> (r.col in ('display_name', 'bio', 'base_location', 'profile_photo_url')) then
      raise exception '0030 VERIFY FAILED: authenticated UPDATE on providers.% is not as intended', r.col;
    end if;
  end loop;
  if (select count(*) from pg_constraint where conrelid = 'public.providers'::regclass
      and conname in ('providers_display_name_length_check', 'providers_bio_length_check',
                      'providers_base_location_length_check')) <> 3 then
    raise exception '0030 VERIFY FAILED: length constraints missing';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.providers'::regclass
                 and tgname = 'providers_before_update' and not tgisinternal) then
    raise exception '0030 VERIFY FAILED: providers_before_update trigger missing';
  end if;
end
$migration$;
