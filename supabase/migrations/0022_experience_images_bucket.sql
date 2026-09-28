-- 0022_experience_images_bucket.sql
-- Stage 3: host experience-photo storage. Run this once in the Supabase
-- SQL Editor, after 0001-0021 have been applied. Purely additive — no
-- existing table, policy, or bucket is touched or weakened.
--
-- DESIGN
-- ------
-- Unlike the "avatars" bucket (0015 — private, signed-URL-only, one
-- object per guest), experience photos must be readable by every
-- authenticated guest without a signed-URL round trip on every card
-- render: explore.ts/hard-filter.ts/provider-profile.ts already render
-- experience_gallery.image_url / provider_gallery.image_url directly as
-- a plain <img src> everywhere. So this bucket is PUBLIC for reads.
-- Writes (insert/update/delete) remain owner-only, enforced the same way
-- every other provider-owned table's RLS already is in this project:
-- resolved against the CALLER's own providers.user_id = auth.uid(), never
-- trusted from client input.
--
-- PATH CONVENTION
-- ----------------
-- "<provider_id>/<experience_id>/<filename>" — the first path segment is
-- the OWNING PROVIDER's providers.id (not the experience id), so
-- ownership can be checked with a single exists() against providers,
-- mirroring the pattern every other provider-scoped RLS policy in this
-- project already uses. The bucket itself does not need to know which
-- experience a given object belongs to — that association lives only in
-- experience_gallery.image_url, written by the app after a successful
-- upload. A provider can freely reuse their own folder across any of
-- their experiences; nothing here depends on the experience_id segment
-- being valid or matching a real row, since the outer provider_id
-- ownership check is what RLS actually enforces.
--
-- SCOPE
-- -----
-- Adds exactly one new bucket + four new storage.objects policies. Does
-- not alter any existing bucket, any existing storage.objects policy
-- (0015's avatar policies are untouched), or any table/RLS policy from
-- 0001-0021.

begin;

-- ── safety checks ─────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'providers'
  ) then
    raise exception 'Aborting: public.providers does not exist. Apply 0002 first.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'experience_gallery'
  ) then
    raise exception 'Aborting: public.experience_gallery does not exist. Apply 0002 first.';
  end if;

  if exists (
    select 1 from storage.buckets where id = 'experience-images'
  ) then
    raise notice 'Bucket "experience-images" already exists — its config will be updated (upsert), not recreated.';
  end if;

  raise notice 'Preflight passed: public.providers and public.experience_gallery confirmed present.';
end $$;

-- ── bucket: public read, 5MB, jpeg/png/webp (same limits as 0015) ──────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('experience-images', 'experience-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── read: public. The bucket's own public=true only affects how Storage
--    serves the object URL itself; SELECT on storage.objects still goes
--    through RLS, so an explicit permissive policy is required here too. ─
drop policy if exists "Anyone reads experience images" on storage.objects;
create policy "Anyone reads experience images" on storage.objects
  for select
  using (bucket_id = 'experience-images');

-- ── write/delete: only the owning provider, folder-scoped ──────────────
drop policy if exists "Providers upload their own experience images" on storage.objects;
create policy "Providers upload their own experience images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'experience-images'
    and exists (
      select 1 from public.providers p
      where p.user_id = auth.uid() and p.id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists "Providers replace their own experience images" on storage.objects;
create policy "Providers replace their own experience images" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'experience-images'
    and exists (
      select 1 from public.providers p
      where p.user_id = auth.uid() and p.id::text = (storage.foldername(name))[1]
    )
  )
  with check (
    bucket_id = 'experience-images'
    and exists (
      select 1 from public.providers p
      where p.user_id = auth.uid() and p.id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists "Providers delete their own experience images" on storage.objects;
create policy "Providers delete their own experience images" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'experience-images'
    and exists (
      select 1 from public.providers p
      where p.user_id = auth.uid() and p.id::text = (storage.foldername(name))[1]
    )
  );

commit;

-- ── read-only verification (not part of the DDL) ────────────────────────
--
--   select id, public, file_size_limit, allowed_mime_types
--   from storage.buckets where id = 'experience-images';
--
--   select policyname, cmd, roles from pg_policies
--   where schemaname = 'storage' and tablename = 'objects'
--     and policyname like '%experience images%'
--   order by policyname;
