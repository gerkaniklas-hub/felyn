-- Milestone 1 (guest profile): a private Supabase Storage bucket for guest
-- profile photos.
-- Run this once in the Supabase SQL Editor, after 0001-0014 have been
-- applied. Purely additive — no existing table or policy is touched.
--
-- Design:
--   * The bucket is PRIVATE (public = false). There is no public URL for
--     any avatar; the app reads photos exclusively via short-lived signed
--     URLs generated server-side (see getSignedAvatarUrl in
--     src/lib/storage/avatars.ts), scoped by the same RLS below.
--   * Every object's path is "<user_id>/avatar" (no extension, fixed name,
--     one object per guest). Uploading a new photo overwrites this exact
--     path (upsert) rather than accumulating orphaned files.
--   * allowed_mime_types/file_size_limit are enforced by Storage itself
--     (server-side), not just the client — a request outside these bounds
--     is rejected before any object is written, regardless of what the
--     browser claims about the file.
--   * RLS on storage.objects scopes every operation to the folder matching
--     the caller's own auth.uid() — a guest can never read, replace, or
--     delete another guest's photo. (storage.objects itself already has
--     RLS enabled by Supabase; this file only adds policies, it does not
--     enable RLS on a table it doesn't own.)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Guests read their own avatar" on storage.objects;
create policy "Guests read their own avatar" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Guests upload their own avatar" on storage.objects;
create policy "Guests upload their own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Guests replace their own avatar" on storage.objects;
create policy "Guests replace their own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Guests delete their own avatar" on storage.objects;
create policy "Guests delete their own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
