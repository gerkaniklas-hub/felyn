-- 0018_experience_cancellation_columns.sql
-- Stage 1 of the booking lifecycle migration: additive schema only.
-- Run this once in the Supabase SQL Editor, after 0001-0017 have been
-- applied, and only after you've run the preflight query above and
-- confirmed booking_request_items_status_check looks as expected.
--
-- Adds three nullable columns to booking_request_items and widens its
-- status CHECK constraint to include CANCELLED. No row is updated. No
-- application code, RLS policy, trigger, or function is touched.
-- Wrapped in an explicit transaction: if the in-transaction safety check
-- below raises, the ENTIRE migration is rolled back, leaving the schema
-- completely unchanged.

begin;

-- ── new columns ───────────────────────────────────────────────────────────
alter table public.booking_request_items
  add column if not exists decided_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text;

-- ── cancelled_by value restriction ───────────────────────────────────────
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancelled_by_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancelled_by_check
  check (cancelled_by is null or cancelled_by in ('guest', 'provider'));

-- ── cancelled_at / cancelled_by must be both-null or both-populated ─────
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancelled_pair_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancelled_pair_check
  check ((cancelled_at is null) = (cancelled_by is null));

-- ── safety check: confirm the EXISTING status constraint references
--    exactly the four expected values, before touching it in any way ────
-- Deliberately checks ONLY the value set, not the constraint's full
-- textual structure — see this migration's own limitations note. This
-- catches the realistic drift this table has actually seen (a status
-- value added, removed, or renamed by a migration this script doesn't
-- know about), which is a real, meaningful safeguard even though it does
-- not attempt to algebraically prove there is no additional compound
-- condition mixed into the same constraint.
do $$
declare
  v_condef text;
  v_actual_values text[];
  v_expected_values text[] := array['CONFIRMED', 'DECLINED', 'REQUESTED', 'WITHDRAWN'];
begin
  select pg_get_constraintdef(oid) into v_condef
  from pg_constraint
  where conrelid = 'public.booking_request_items'::regclass
    and contype = 'c'
    and conname = 'booking_request_items_status_check';

  if v_condef is null then
    raise exception
      'Aborting: booking_request_items_status_check does not exist on public.booking_request_items. Stage 1 expects it to already exist (from migration 0011) before running.';
  end if;

  select array_agg(lit order by lit) into v_actual_values
  from (
    select distinct (regexp_matches(v_condef, '''([^'']*)''', 'g'))[1] as lit
  ) matches;

  if v_actual_values is distinct from v_expected_values then
    raise exception
      'Aborting: booking_request_items_status_check does not reference exactly the expected four values. Expected %, found % (raw definition: %). Run the separate preflight query and compare by hand before proceeding.',
      v_expected_values, v_actual_values, v_condef;
  end if;

  raise notice
    'Value-set check passed. Raw definition: %. This confirms the four expected status values and nothing else appear in the definition — it does NOT independently prove the constraint has no additional condition beyond a simple value check. If you have not already run the separate preflight query and visually confirmed that, do so before trusting this result.',
    v_condef;
end $$;

-- ── widen the status constraint — only reached if the check above
--    passed without raising ──────────────────────────────────────────────
alter table public.booking_request_items
  drop constraint if exists booking_request_items_status_check;
alter table public.booking_request_items
  add constraint booking_request_items_status_check
  check (status in ('REQUESTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'CANCELLED'));

commit;
