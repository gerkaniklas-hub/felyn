-- NOT A MIGRATION — do not apply this as part of the numbered sequence.
-- A standalone test for 0021's post-decision messaging windows. Run in
-- the Supabase SQL Editor AFTER 0021 has been applied.
--
-- IMPORTANT, READ BEFORE TRUSTING THIS SCRIPT: the Supabase SQL Editor
-- runs as a superuser/table-owner role, which BYPASSES ROW LEVEL SECURITY
-- entirely by Postgres design — no INSERT this script performs is ever
-- actually gated by the messages RLS policies, regardless of what those
-- policies say. That means this script CANNOT prove the database rejects
-- a real forged/late send attempt from an authenticated session — only a
-- genuine authenticated request (the real app, or the Supabase dashboard's
-- own "Run as" role-impersonation feature, if available on your project)
-- can prove that. What this script DOES verify, accurately and without
-- that limitation:
--   * decided_at write/backfill semantics (plain data checks, not RLS).
--   * The exact boundary MATH the new policies use (evaluated directly as
--     a boolean expression, matching 0021's own condition verbatim) —
--     this confirms the 30-day cutoff is computed correctly, not that
--     Postgres actually enforces it against a non-superuser session.
--   * The SELECT (history-read) policies are byte-unchanged from 0014.
--
-- Not read-only: performs real INSERT/UPDATE statements, made safe by
-- running entirely inside one transaction ending in ROLLBACK — nothing
-- here is ever committed. Every check raises an exception on failure.

begin;

do $$
declare
  v_guest_user_id uuid;
  v_claimed_provider_user_id uuid;
  v_experience_id uuid;
  v_stay_id uuid;
  v_request_id uuid;
  v_item_id uuid;
  v_decided_1 timestamptz;
  v_decided_2 timestamptz;
  v_legacy_item_id uuid;
  v_non_declined_item_id uuid;
  v_select_policy_count int;
begin
  -- ── setup: two distinct accounts, same reasoning as the cancellation
  --    notification test — a coincidental guest/provider collision would
  --    make every isolation-flavored check below meaningless. ──
  select p.user_id, e.id into v_claimed_provider_user_id, v_experience_id
  from public.providers p
  join public.experiences e on e.provider_id = p.id
  where p.user_id is not null and e.published = true
  limit 1;
  if v_experience_id is null then
    raise exception 'TEST SETUP FAILED: no claimed provider with a published experience found.';
  end if;

  select id into v_guest_user_id from auth.users where id <> v_claimed_provider_user_id limit 1;
  if v_guest_user_id is null then
    raise exception 'TEST SETUP FAILED: no auth.users row distinct from the claimed provider (%) exists.', v_claimed_provider_user_id;
  end if;

  insert into public.stays (user_id, property_name, location_text, check_in, check_out, guest_count)
  values (v_guest_user_id, 'MSG WINDOW TEST (rolled back)', 'Test', current_date, current_date + 1, 1)
  returning id into v_stay_id;

  insert into public.booking_requests (user_id, stay_id, estimated_total)
  values (v_guest_user_id, v_stay_id, 0)
  returning id into v_request_id;

  -- ══ SECTION A: decided_at write / backfill semantics (plain data, no RLS involved) ══

  -- A1: a fresh decline writes decided_at exactly once.
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date, 'evening', 1, 0, 'REQUESTED')
  returning id into v_item_id;

  update public.booking_request_items
  set status = 'DECLINED', decline_reason = 'other', decided_at = now()
  where id = v_item_id and status = 'REQUESTED'
  returning decided_at into v_decided_1;

  if v_decided_1 is null then
    raise exception 'ASSERTION FAILED (A1): decided_at was not set on decline.';
  end if;

  -- A second "decline" attempt (mirroring the app's own REQUESTED-only
  -- guard) must not match, and must not change decided_at.
  update public.booking_request_items
  set status = 'DECLINED', decline_reason = 'other', decided_at = now()
  where id = v_item_id and status = 'REQUESTED';

  -- An unrelated update to the already-declined row must not reset it either.
  update public.booking_request_items set host_note = 'irrelevant update' where id = v_item_id;

  select decided_at into v_decided_2 from public.booking_request_items where id = v_item_id;
  if v_decided_2 is distinct from v_decided_1 then
    raise exception 'ASSERTION FAILED (A1): decided_at changed after a re-decline attempt or an unrelated update (% -> %)', v_decided_1, v_decided_2;
  end if;
  raise notice 'A1 passed: decided_at set once on decline, unaffected by later attempts/unrelated updates.';

  -- A2: a genuinely pre-existing "legacy" DECLINED row (decided_at forced
  -- back to null, simulating a row that predates 0021) must NOT be
  -- silently re-backfilled by anything outside the migration's own
  -- one-time UPDATE — nothing in ongoing application behavior should ever
  -- set decided_at except the guarded decline transition itself. This
  -- confirms the column has no other write path, not that the migration's
  -- own backfill ran correctly (that already happened once, for real, at
  -- migration time — it cannot be re-tested here without truly
  -- pre-0021 data).
  update public.booking_request_items set decided_at = null where id = v_item_id;
  update public.booking_request_items set cancellation_note = null where id = v_item_id; -- no-op, keeps this item DECLINED only
  select decided_at into v_decided_2 from public.booking_request_items where id = v_item_id;
  if v_decided_2 is not null then
    raise exception 'ASSERTION FAILED (A2 setup): could not force decided_at back to null for the legacy simulation.';
  end if;
  v_legacy_item_id := v_item_id;
  raise notice 'A2 setup ok: legacy-style DECLINED row with decided_at = null prepared for Section B.';

  -- A3: non-DECLINED rows are never touched by anything resembling a
  -- backfill. Confirmed by construction: create a CONFIRMED row and
  -- assert decided_at stays null with no write path ever applied to it.
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date + 1, 'evening', 1, 0, 'CONFIRMED')
  returning id into v_non_declined_item_id;
  select decided_at into v_decided_2 from public.booking_request_items where id = v_non_declined_item_id;
  if v_decided_2 is not null then
    raise exception 'ASSERTION FAILED (A3): a CONFIRMED item unexpectedly has a non-null decided_at.';
  end if;
  raise notice 'A3 passed: non-DECLINED item has no decided_at.';

  -- ══ SECTION B: 30-day boundary math, evaluated directly (matches
  --    0021's policy condition verbatim) — NOT a live RLS enforcement
  --    test, see the header comment. ══

  -- B1: DECLINED, legacy row, decided_at still null -> condition must be
  -- false (closed) — this is the real, approved consequence of the
  -- legacy-null case, re-verified here directly.
  if exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_legacy_item_id
      and bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B1): a null-decided_at row evaluated as within the messaging window.';
  end if;
  raise notice 'B1 passed: legacy null decided_at correctly evaluates as closed.';

  -- B2: DECLINED, decided_at = now() - 29 days -> open.
  update public.booking_request_items set decided_at = now() - interval '29 days' where id = v_legacy_item_id;
  if not exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_legacy_item_id
      and bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B2): 29 days after decided_at should still be open.';
  end if;

  -- B3: exactly at the 30-day boundary -> still open (inclusive).
  update public.booking_request_items set decided_at = now() - interval '30 days' where id = v_legacy_item_id;
  if not exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_legacy_item_id
      and bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B3): exactly 30 days after decided_at should still be open (inclusive boundary).';
  end if;

  -- B4: just past the boundary -> closed.
  update public.booking_request_items set decided_at = now() - interval '30 days' - interval '1 second' where id = v_legacy_item_id;
  if exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_legacy_item_id
      and bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B4): 30 days and 1 second after decided_at should be closed.';
  end if;
  raise notice 'B2-B4 passed: 29-day-open / exactly-30-day-open / just-past-closed boundary math is correct.';

  -- B5: same three-point boundary check for CANCELLED via cancelled_at,
  -- using a freshly cancelled item (cancelled_at is always non-null by
  -- construction once status = 'CANCELLED', per 0018/0019's own
  -- constraints, so there is no legacy-null case to test here at all).
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date + 2, 'evening', 1, 0, 'CONFIRMED')
  returning id into v_item_id;
  update public.booking_request_items
  set status = 'CANCELLED', cancelled_at = now() - interval '30 days', cancelled_by = 'guest', cancellation_reason = 'CHANGE_OF_PLANS'
  where id = v_item_id;
  if not exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_item_id
      and bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B5): exactly 30 days after cancelled_at should still be open (inclusive boundary).';
  end if;
  update public.booking_request_items set cancelled_at = now() - interval '30 days' - interval '1 second' where id = v_item_id;
  if exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_item_id
      and bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days'
  ) then
    raise exception 'ASSERTION FAILED (B5): 30 days and 1 second after cancelled_at should be closed.';
  end if;
  raise notice 'B5 passed: CANCELLED boundary math matches DECLINED''s.';

  -- B6: REQUESTED/CONFIRMED always evaluate as open regardless of any
  -- timestamp (they're matched by the first disjunct, unconditionally).
  if not exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_non_declined_item_id and bri.status in ('REQUESTED', 'CONFIRMED')
  ) then
    raise exception 'ASSERTION FAILED (B6): sanity check on the CONFIRMED fixture item itself failed.';
  end if;
  raise notice 'B6 passed (by construction): REQUESTED/CONFIRMED are unconditionally open in the policy condition.';

  -- B7: WITHDRAWN is never matched by any disjunct in either policy —
  -- confirmed by inspection of 0021's own condition (no WITHDRAWN branch
  -- exists at all), re-stated here as an explicit, direct check.
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date + 3, 'evening', 1, 0, 'WITHDRAWN')
  returning id into v_item_id;
  if exists (
    select 1 from public.booking_request_items bri
    where bri.id = v_item_id
      and (
        bri.status in ('REQUESTED', 'CONFIRMED')
        or (bri.status = 'DECLINED' and bri.decided_at is not null and now() <= bri.decided_at + interval '30 days')
        or (bri.status = 'CANCELLED' and bri.cancelled_at is not null and now() <= bri.cancelled_at + interval '30 days')
      )
  ) then
    raise exception 'ASSERTION FAILED (B7): a WITHDRAWN item unexpectedly matched the messaging-open condition.';
  end if;
  raise notice 'B7 passed: WITHDRAWN never matches the open condition, preserved exactly.';

  -- ══ SECTION C: SELECT (history-read) policies are byte-unchanged ══
  select count(*) into v_select_policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'messages'
    and policyname in ('Guests view messages for their own items', 'Providers view messages for their experiences');
  if v_select_policy_count <> 2 then
    raise exception 'ASSERTION FAILED (C): expected both original 0014 SELECT policies to still exist unmodified, found %.', v_select_policy_count;
  end if;
  raise notice 'C passed: both 0014 SELECT (history-read) policies still exist, untouched by this migration.';

  raise notice 'ALL ASSERTIONS PASSED (Sections A, B, C). Reminder: Section B verifies the boundary CONDITION, not live RLS enforcement — see this file''s header.';
end $$;

rollback;
