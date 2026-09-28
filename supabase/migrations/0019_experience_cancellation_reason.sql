-- 0019_experience_cancellation_reason.sql
-- Stage 2a of the booking lifecycle migration: cancellation reason/note
-- columns, plus a status/cancelled_at consistency constraint. Run this
-- once in the Supabase SQL Editor, after 0018 has been applied and
-- verified.
--
-- Purely additive: two new nullable columns, four new CHECK constraints.
-- No row is updated. No RLS, trigger, function, or application code is
-- touched. No cancellation behavior is introduced — this only prepares
-- the schema for Stage 2c's cancellation actions.

begin;

-- ── safety checks: confirm Stage 1 landed exactly as expected, and that
--    no existing row would violate anything this migration adds ────────
do $$
declare
  v_condef text;
  v_actual_values text[];
  v_expected_values text[] := array['CANCELLED', 'CONFIRMED', 'DECLINED', 'REQUESTED', 'WITHDRAWN'];
  v_status_pair_violations bigint;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_request_items' and column_name = 'cancelled_at'
  ) then
    raise exception 'Aborting: expected Stage 1 column cancelled_at is missing. Apply migration 0018 first.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_request_items'::regclass and contype = 'c'
      and conname = 'booking_request_items_cancelled_pair_check'
  ) then
    raise exception 'Aborting: booking_request_items_cancelled_pair_check (from 0018) does not exist.';
  end if;

  select pg_get_constraintdef(oid) into v_condef
  from pg_constraint
  where conrelid = 'public.booking_request_items'::regclass and contype = 'c'
    and conname = 'booking_request_items_status_check';

  if v_condef is null then
    raise exception 'Aborting: booking_request_items_status_check does not exist.';
  end if;

  select array_agg(lit order by lit) into v_actual_values
  from (
    select distinct (regexp_matches(v_condef, '''([^'']*)''', 'g'))[1] as lit
  ) matches;

  if v_actual_values is distinct from v_expected_values then
    raise exception
      'Aborting: booking_request_items_status_check does not reference exactly the five expected values (0018 should have added CANCELLED). Expected %, found % (raw definition: %).',
      v_expected_values, v_actual_values, v_condef;
  end if;

  -- Extra check specific to the new status/cancelled_at pairing constraint
  -- below: directly tests the exact condition it will enforce, rather
  -- than trusting that "no CANCELLED rows exist" alone is sufficient.
  select count(*) into v_status_pair_violations
  from public.booking_request_items
  where (status = 'CANCELLED') is distinct from (cancelled_at is not null);

  if v_status_pair_violations > 0 then
    raise exception
      'Aborting: % row(s) already disagree between status=''CANCELLED'' and cancelled_at being populated — adding booking_request_items_cancelled_status_pair_check would fail.',
      v_status_pair_violations;
  end if;

  raise notice 'Preflight passed. Status constraint: %. Zero status/cancelled_at inconsistencies found.', v_condef;
end $$;

-- ── new columns ───────────────────────────────────────────────────────────
alter table public.booking_request_items
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_note text;

-- ── reason must be one of the approved values for the actual actor ──────
-- Combines value-list validity and actor-consistency in one constraint so
-- the two can never drift apart.
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancellation_reason_actor_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancellation_reason_actor_check
  check (
    cancellation_reason is null
    or (
      cancelled_by = 'guest'
      and cancellation_reason in (
        'CHANGE_OF_PLANS', 'NO_LONGER_NEEDED', 'DATE_OR_TIME_NO_LONGER_WORKS',
        'UNEXPECTED_CIRCUMSTANCES', 'OTHER'
      )
    )
    or (
      cancelled_by = 'provider'
      and cancellation_reason in (
        'DATE_OR_TIME_NO_LONGER_WORKS', 'UNABLE_TO_PROVIDE_EXPERIENCE',
        'UNEXPECTED_CIRCUMSTANCES', 'OTHER'
      )
    )
  );

-- ── reason required exactly when cancelled_at is populated ──────────────
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancellation_reason_pair_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancellation_reason_pair_check
  check ((cancelled_at is null) = (cancellation_reason is null));

-- ── note is optional, but can't exist without a real cancellation, and
--    is capped at 500 chars (matching host_note's existing precedent,
--    0012) ─────────────────────────────────────────────────────────────
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancellation_note_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancellation_note_check
  check (cancellation_note is null or (cancelled_at is not null and char_length(cancellation_note) <= 500));

-- ── status itself must agree with cancelled_at — closes the loop so
--    status/cancelled_at/cancelled_by/cancellation_reason can only ever
--    be all-populated (a real cancellation) or all-null (never cancelled) ─
alter table public.booking_request_items
  drop constraint if exists booking_request_items_cancelled_status_pair_check;
alter table public.booking_request_items
  add constraint booking_request_items_cancelled_status_pair_check
  check ((status = 'CANCELLED') = (cancelled_at is not null));

commit;
