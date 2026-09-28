-- NOT A MIGRATION — do not apply this as part of the numbered sequence.
-- A standalone test for 0020's cancellation notification trigger. Run in
-- the Supabase SQL Editor AFTER 0020 has been applied.
--
-- Not read-only: performs real INSERT/UPDATE statements, made safe by
-- running entirely inside one transaction ending in ROLLBACK — nothing
-- here is ever committed or visible to any other session. Every check
-- below raises an exception on failure, so this script cannot appear to
-- "pass" while actually failing.

begin;

do $$
declare
  v_guest_user_id uuid;
  v_claimed_provider_user_id uuid;
  v_experience_id uuid;
  v_unclaimed_experience_id uuid;
  v_stay_id uuid;
  v_request_id uuid;
  v_item_id uuid;
  v_count int;
begin
  -- Provider first, then a guest explicitly distinct from that provider's
  -- own account — this dev environment has previously reused a single
  -- account to test both guest and provider flows, and a coincidental
  -- collision here would make every isolation assertion below meaningless
  -- (checking "was the provider notified" and "was the guest notified"
  -- against the very same user_id).
  select p.user_id, e.id into v_claimed_provider_user_id, v_experience_id
  from public.providers p
  join public.experiences e on e.provider_id = p.id
  where p.user_id is not null and e.published = true
  limit 1;
  if v_experience_id is null then
    raise exception 'TEST SETUP FAILED: no claimed provider with a published experience found.';
  end if;

  select id into v_guest_user_id
  from auth.users
  where id <> v_claimed_provider_user_id
  limit 1;
  if v_guest_user_id is null then
    raise exception 'TEST SETUP FAILED: no auth.users row distinct from the claimed provider (%) exists. This test requires two distinct real accounts to verify notification isolation.', v_claimed_provider_user_id;
  end if;

  insert into public.stays (user_id, property_name, location_text, check_in, check_out, guest_count)
  values (v_guest_user_id, 'CANCEL NOTIFY TEST (rolled back)', 'Test', current_date, current_date + 1, 1)
  returning id into v_stay_id;

  insert into public.booking_requests (user_id, stay_id, estimated_total)
  values (v_guest_user_id, v_stay_id, 0)
  returning id into v_request_id;

  -- ── Case 1: guest cancels -> exactly one notification, to the provider,
  --    of the correct type, for this exact item; the guest gets none. ──
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date, 'evening', 1, 0, 'CONFIRMED')
  returning id into v_item_id;

  update public.booking_request_items
  set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'guest', cancellation_reason = 'CHANGE_OF_PLANS'
  where id = v_item_id;

  select count(*) into v_count
  from public.notifications
  where booking_request_item_id = v_item_id
    and user_id = v_claimed_provider_user_id
    and type = 'booking_item_cancelled';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (case 1): expected exactly 1 booking_item_cancelled notification for the provider on item %, found %', v_item_id, v_count;
  end if;

  select count(*) into v_count
  from public.notifications
  where booking_request_item_id = v_item_id and user_id = v_guest_user_id;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (case 1): the guest (the initiator) was incorrectly notified for item %', v_item_id;
  end if;

  -- An unrelated update to the now-CANCELLED row must not create a duplicate.
  update public.booking_request_items set host_note = 'irrelevant update, not a re-cancellation' where id = v_item_id;
  select count(*) into v_count
  from public.notifications
  where booking_request_item_id = v_item_id
    and user_id = v_claimed_provider_user_id
    and type = 'booking_item_cancelled';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (case 1): an unrelated update to an already-cancelled item changed its notification count to % (expected still 1)', v_count;
  end if;

  raise notice 'Case 1 (guest cancels) passed: exactly one notification to the provider, none to the guest, no duplicate on a later unrelated update.';

  -- ── Case 2: provider cancels a different item -> exactly one
  --    notification, to the guest, of the correct type, for this exact
  --    item; the provider gets none. ──
  insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
  values (v_request_id, v_experience_id, current_date + 1, 'evening', 1, 0, 'CONFIRMED')
  returning id into v_item_id;

  update public.booking_request_items
  set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'provider', cancellation_reason = 'UNABLE_TO_PROVIDE_EXPERIENCE'
  where id = v_item_id;

  select count(*) into v_count
  from public.notifications
  where booking_request_item_id = v_item_id
    and user_id = v_guest_user_id
    and type = 'booking_item_cancelled';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (case 2): expected exactly 1 booking_item_cancelled notification for the guest on item %, found %', v_item_id, v_count;
  end if;

  select count(*) into v_count
  from public.notifications
  where booking_request_item_id = v_item_id and user_id = v_claimed_provider_user_id;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (case 2): the provider (the initiator) was incorrectly notified for item %', v_item_id;
  end if;

  raise notice 'Case 2 (provider cancels) passed: exactly one notification to the guest, none to the provider.';

  -- ── Case 3 (only if fixture data has one): an unclaimed demo provider
  --    (providers.user_id is null) must fail safe — no error, no
  --    notification — never a crash of the cancellation itself. ──
  select e.id into v_unclaimed_experience_id
  from public.experiences e
  join public.providers p on p.id = e.provider_id
  where p.user_id is null and e.published = true
  limit 1;

  if v_unclaimed_experience_id is not null then
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
    values (v_request_id, v_unclaimed_experience_id, current_date + 2, 'evening', 1, 0, 'CONFIRMED')
    returning id into v_item_id;

    update public.booking_request_items
    set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'guest', cancellation_reason = 'CHANGE_OF_PLANS'
    where id = v_item_id;

    select count(*) into v_count from public.notifications where booking_request_item_id = v_item_id;
    if v_count <> 0 then
      raise exception 'ASSERTION FAILED (case 3): a notification was created for an unclaimed provider''s cancelled item %', v_item_id;
    end if;

    raise notice 'Case 3 (unclaimed provider) passed: cancellation succeeded, no error, no notification.';
  else
    raise notice 'Case 3 skipped: no unclaimed-provider published experience exists in this fixture data.';
  end if;

  raise notice 'ALL ASSERTIONS PASSED.';
end $$;

rollback;
