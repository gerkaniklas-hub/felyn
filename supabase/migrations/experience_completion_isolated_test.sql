-- NOT A MIGRATION — do not apply this as part of the numbered sequence.
-- A standalone test for 0016's complete_past_experiences() function. Run
-- this in the Supabase SQL Editor AFTER 0016 has been applied (it does
-- not need 0017/pg_cron — it calls the function directly).
--
-- This is NOT a read-only script: it performs real INSERT and UPDATE
-- statements against your live database. What makes it safe is that all
-- of it runs inside one transaction ending in ROLLBACK, so none of those
-- writes are ever committed or visible to any other session — your real
-- stays, requests, and items are never touched, regardless of what
-- happens inside the block. That said, be aware of what a rolled-back
-- transaction does NOT undo:
--   * It briefly takes row-level locks on the rows it inserts, and the
--     pg_sleep(1) below holds the transaction (and those locks) open for
--     at least one extra second. On a live/busy database this is a real,
--     if small and short-lived, resource cost — not "nothing happens."
--   * It still writes to the write-ahead log (WAL) and leaves dead tuples
--     behind for autovacuum to reclaim, exactly like any other attempted
--     write in Postgres. Neither is visible to any query and both are
--     routine, but "no WAL/no disk activity at all" would be inaccurate.
--   * Verified (by reading every relevant CREATE TABLE in 0001-0015):
--     every primary key this test touches (stays, booking_requests,
--     booking_request_items, experiences) is `uuid default
--     gen_random_uuid()`, not a sequence/serial column, so the classic
--     "sequences don't roll back" gotcha does not apply here — no
--     sequence anywhere in this schema advances because of this test.
--   * Verified (by grepping every `create trigger` in 0001-0015): the
--     only triggers in this schema are booking_request_item_status_notify
--     (fires only on UPDATE OF status on booking_request_items) and two
--     message-related triggers on the unrelated `messages` table. This
--     test only ever updates completed_at and planned_date, never
--     status, and never touches messages — so none of these triggers
--     fire during this test, and no notification rows are created.
--
-- Every check below raises an exception on failure (not just a notice),
-- so this script cannot appear to "pass" while actually failing.

begin;

do $$
declare
  v_user_id uuid;
  v_experience_id uuid;
  v_stay_id uuid;
  v_request_id uuid;
  v_item_id uuid;
  v_completed_1 timestamptz;
  v_completed_2 timestamptz;
begin
  -- Read-only references (never modified) — fail clearly rather than
  -- crash on a confusing foreign-key error if the dev database has no
  -- fixture data to reference.
  select id into v_user_id from auth.users limit 1;
  if v_user_id is null then
    raise exception 'TEST SETUP FAILED: no rows in auth.users to reference.';
  end if;

  select id into v_experience_id from public.experiences where published = true limit 1;
  if v_experience_id is null then
    raise exception 'TEST SETUP FAILED: no published experience to reference.';
  end if;

  -- A disposable stay/request/item chain — not one of your real stays.
  -- Discarded by ROLLBACK at the end of this script no matter what
  -- happens inside this block.
  insert into public.stays (user_id, property_name, location_text, check_in, check_out, guest_count, source, onboarding_completed_at)
  values (v_user_id, 'TEST STAY (rolled back, not real)', 'Test', current_date, current_date + 7, 2, 'manual', now())
  returning id into v_stay_id;

  insert into public.booking_requests (user_id, stay_id, status, estimated_total)
  values (v_user_id, v_stay_id, 'CONFIRMED', 100)
  returning id into v_request_id;

  -- Backdated so it's immediately eligible for completion.
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date - 1, 'evening', 2, 50, 'CONFIRMED')
  returning id into v_item_id;

  -- Assertion 1: the first run must complete it.
  perform public.complete_past_experiences();
  select completed_at into v_completed_1 from public.booking_request_items where id = v_item_id;
  if v_completed_1 is null then
    raise exception 'ASSERTION FAILED: completed_at is NULL after first run (expected NOT NULL)';
  end if;

  -- Assertions 2 & 3: a second run must not null it out or change it.
  perform pg_sleep(1);
  perform public.complete_past_experiences();
  select completed_at into v_completed_2 from public.booking_request_items where id = v_item_id;
  if v_completed_2 is null then
    raise exception 'ASSERTION FAILED: completed_at became NULL after second run';
  end if;
  if v_completed_1 is distinct from v_completed_2 then
    raise exception 'ASSERTION FAILED: completed_at changed between runs (% vs %)', v_completed_1, v_completed_2;
  end if;

  -- Assertion 4: a future-dated CONFIRMED item must never be completed.
  update public.booking_request_items set planned_date = current_date + 3, completed_at = null where id = v_item_id;
  perform public.complete_past_experiences();
  if exists (select 1 from public.booking_request_items where id = v_item_id and completed_at is not null) then
    raise exception 'ASSERTION FAILED: a future-dated item was marked completed';
  end if;

  raise notice 'ALL ASSERTIONS PASSED.';
end $$;

rollback;
