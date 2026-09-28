-- Stay Planner redesign: per-item preferred time + host note
-- Run this once in the Supabase SQL Editor, after 0001-0011 have been applied.
--
-- Purely additive: two nullable columns on booking_request_items. Existing
-- rows keep working untouched (NULL = "no preferred time" / "no note").
--
-- guest_count already exists on this table (0005) and was previously always
-- written as the stay's own guest_count; the app now writes the guest's
-- per-experience choice instead. No schema change is needed for that.
--
-- No RLS change is needed either:
--   * the guest's existing owner policy (0005, "for all") already covers
--     inserting/reading these columns on their own request's items;
--   * the provider's existing SELECT policy (0007) is row-level, so a provider
--     sees these columns only on items for their OWN experiences.
-- Nobody else can read them, and they are never exposed through any public
-- view.

alter table public.booking_request_items
  add column if not exists preferred_time time,
  add column if not exists host_note text;

-- The note is plain text capped at 500 characters. The app trims/normalises
-- and validates server-side before insert; this is the database backstop.
alter table public.booking_request_items
  drop constraint if exists booking_request_items_host_note_length;
alter table public.booking_request_items
  add constraint booking_request_items_host_note_length
  check (host_note is null or char_length(host_note) <= 500);
