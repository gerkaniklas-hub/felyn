-- 0021_post_decision_messaging_windows.sql
-- Stage 2c-B: post-decision messaging windows. Run this once in the
-- Supabase SQL Editor, after 0001-0020 have been applied.
--
-- SCHEMA NOTE: supabase/migrations/0018_experience_cancellation_columns.sql
-- is missing from this repository's local files, even though it was
-- applied and verified earlier (0019's own preflight already depends on
-- it, and this project's whole cancellation feature works against it).
-- That original 0018 is understood to have added decided_at alongside
-- cancelled_at/cancelled_by, so `decided_at` may already exist. Part A
-- below uses `add column if not exists`, which is correct and safe
-- regardless of whether it's already there — this migration does not
-- attempt to guess or reconstruct 0018's exact original text.
--
-- A. Adds decided_at (nullable timestamptz) if not already present.
-- B. Backfills decided_at for EXISTING DECLINED rows only, using one
--    single, stable transaction timestamp (not per-row now()).
-- C. (Application-side, not in this file) declineBookingRequestItem now
--    writes decided_at on every future decline.
-- D. Extends both messages INSERT policies' status condition to allow a
--    30-day reply window after DECLINED/CANCELLED, anchored to
--    decided_at/cancelled_at respectively. Every other clause in both
--    policies (participant/ownership checks) is preserved byte-for-byte
--    from 0014 — only the trailing status condition changes.
--
-- Does not touch: SELECT/read-history policies, the UPDATE (mark-read)
-- policy, realtime, the notification triggers (0009/0014/0020), migration
-- 0008 or its functions, or any cancellation behavior from 0018/0019/0020.

begin;

-- ── safety checks ─────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_request_items' and column_name = 'cancelled_at'
  ) then
    raise exception 'Aborting: expected cancellation column cancelled_at is missing. Apply the cancellation schema first.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'messages'
      and policyname = 'Guests send messages on their own active items'
  ) then
    raise exception 'Aborting: expected policy "Guests send messages on their own active items" (0014) not found.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'messages'
      and policyname = 'Providers send messages on their own active items'
  ) then
    raise exception 'Aborting: expected policy "Providers send messages on their own active items" (0014) not found.';
  end if;

  raise notice 'Preflight passed: cancellation schema and both target messaging INSERT policies confirmed present.';
end $$;

-- ── A: decided_at (idempotent — may already exist) ───────────────────
alter table public.booking_request_items add column if not exists decided_at timestamptz;

-- ── B: legacy backfill — DECLINED rows only, one stable timestamp ────
-- now() is stable within a single transaction (it returns the
-- transaction's start time, not the current statement's), but the value
-- is captured explicitly into a variable regardless, so this is not
-- dependent on that implementation detail and reads unambiguously as
-- "computed once, reused for every row" rather than "reads now() on
-- every row" (which per-row now() calls, in a single UPDATE statement,
-- would be anyway — this makes the intent explicit rather than relying
-- on a subtlety).
do $$
declare
  v_backfill_at timestamptz := now();
  v_backfilled_count bigint;
begin
  update public.booking_request_items
  set decided_at = v_backfill_at
  where status = 'DECLINED' and decided_at is null;

  get diagnostics v_backfilled_count = row_count;
  raise notice 'Backfilled decided_at for % legacy DECLINED row(s) using timestamp %. No other status was touched.', v_backfilled_count, v_backfill_at;
end $$;

-- ── D: messaging INSERT policies — status condition extended only ────
-- Participant/ownership predicates below are copied verbatim from 0014;
-- only the trailing status disjunction changed. Boundary is inclusive:
-- a send exactly at the 30-day mark is allowed, strictly after is denied,
-- consistently for both roles.
drop policy if exists "Guests send messages on their own active items" on public.messages;
create policy "Guests send messages on their own active items" on public.messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.booking_request_items bri
      join public.booking_requests br on br.id = bri.booking_request_id
      where bri.id = messages.booking_request_item_id
        and br.user_id = auth.uid()
        and (
          bri.status in ('REQUESTED', 'CONFIRMED')
          or (bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days')
          or (bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days')
        )
    )
  );

drop policy if exists "Providers send messages on their own active items" on public.messages;
create policy "Providers send messages on their own active items" on public.messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
      where bri.id = messages.booking_request_item_id
        and p.user_id = auth.uid()
        and (
          bri.status in ('REQUESTED', 'CONFIRMED')
          or (bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days')
          or (bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days')
        )
    )
  );

commit;
