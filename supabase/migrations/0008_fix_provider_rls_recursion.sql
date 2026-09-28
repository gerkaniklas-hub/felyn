-- Fix: infinite recursion in RLS introduced by 0007
-- Run this once in the Supabase SQL Editor, after 0001-0007 have been applied.
--
-- Root cause: 0007 added a SELECT policy on `booking_requests` whose USING
-- clause queries `booking_request_items` ("Providers view requests for
-- their experiences"), and a SELECT policy on `stays` whose USING clause
-- queries both `booking_requests` AND `booking_request_items` ("Providers
-- view stays with their requests"). But `booking_request_items` already had
-- an owner policy (0005) whose USING clause queries `booking_requests`
-- (`br.id = booking_request_id and br.user_id = auth.uid()`). That closes a
-- cycle: evaluating RLS on `booking_requests` requires evaluating RLS on
-- `booking_request_items`, which requires evaluating RLS on
-- `booking_requests` again — Postgres detects this and raises
-- "infinite recursion detected in policy for relation \"booking_requests\""
-- (error 42P17) on ANY select/insert-with-representation against these
-- tables, including a plain guest inserting a new stay (PostgREST returns
-- the inserted row via a SELECT under the hood).
--
-- Fix: move the cross-table checks into SECURITY DEFINER functions. Such a
-- function executes as its owner (the role that runs this migration, which
-- also owns these tables), and table owners bypass RLS on their own tables
-- by default (no FORCE ROW LEVEL SECURITY is set anywhere here) — so the
-- lookups inside these functions never re-trigger the policies that call
-- them, breaking the cycle. `search_path` is pinned for safety.

create or replace function public.is_provider_for_booking_request(target_request_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from booking_request_items bri
    join experiences e on e.id = bri.experience_id
    join providers p on p.id = e.provider_id
    where bri.booking_request_id = target_request_id
      and p.user_id = uid
  );
$$;

create or replace function public.is_provider_for_stay(target_stay_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from booking_requests br
    join booking_request_items bri on bri.booking_request_id = br.id
    join experiences e on e.id = bri.experience_id
    join providers p on p.id = e.provider_id
    where br.stay_id = target_stay_id
      and p.user_id = uid
  );
$$;

drop policy if exists "Providers view requests for their experiences" on public.booking_requests;
create policy "Providers view requests for their experiences" on public.booking_requests
  for select to authenticated using (
    public.is_provider_for_booking_request(booking_requests.id, auth.uid())
  );

drop policy if exists "Providers view stays with their requests" on public.stays;
create policy "Providers view stays with their requests" on public.stays
  for select to authenticated using (
    public.is_provider_for_stay(stays.id, auth.uid())
  );

-- "Providers view items for their experiences" (on booking_request_items,
-- from 0007) is untouched — it only queries experiences/providers, which
-- were never part of the cycle.
