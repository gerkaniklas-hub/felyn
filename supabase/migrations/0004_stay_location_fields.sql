-- M6.5: Structured stay location fields
-- Run this once in the Supabase SQL Editor, after 0001-0003 have been applied.
-- Purely additive: every new column is nullable, so existing stays (which
-- have none of this data) continue to work unchanged. No RLS changes are
-- needed — the existing "Users manage their own stays" policy on
-- public.stays already covers these columns via its `for all`.
--
-- location_text remains the source of truth for free-text display and for
-- M5.1's text-based location matching (unchanged). These columns exist so
-- a future geocoding integration has somewhere to write structured,
-- verified location data — no geocoding provider is configured in this
-- codebase yet, so every existing and new stay simply has these as null
-- ("location not yet verified") until that integration exists. Nothing
-- here invents or backfills coordinates.

alter table public.stays
  add column if not exists formatted_address text,
  add column if not exists locality text,
  add column if not exists postcode text,
  add column if not exists country text,
  add column if not exists latitude numeric,
  add column if not exists longitude numeric,
  add column if not exists place_id text;
