-- Provider booking-context visibility: occasion, dietary requirements, and
-- the guest's first name on a booking.
-- Run this once in the Supabase SQL Editor, after 0001-0012 have been applied.
--
-- Purely additive. Both pieces reuse the SAME authorization boundary
-- already established in 0008: public.is_provider_for_stay(stay_id, uid)
-- — a provider only ever sees this data for a stay they have an actual
-- booking_request_item against (via their own experiences).

-- ── stay_occasions / stay_dietary_requirements: additive provider SELECT ──
-- Both tables currently only have the guest's own "for all" owner policy
-- (0001). These add a provider-facing SELECT, exactly mirroring 0007's
-- "Providers view stays with their requests" — no guest policy is touched.
drop policy if exists "Providers view occasions for their stays" on public.stay_occasions;
create policy "Providers view occasions for their stays" on public.stay_occasions
  for select to authenticated using (
    public.is_provider_for_stay(stay_occasions.stay_id, auth.uid())
  );

drop policy if exists "Providers view dietary requirements for their stays" on public.stay_dietary_requirements;
create policy "Providers view dietary requirements for their stays" on public.stay_dietary_requirements
  for select to authenticated using (
    public.is_provider_for_stay(stay_dietary_requirements.stay_id, auth.uid())
  );

-- ── guest first name, narrowly scoped ────────────────────────────────────
-- auth.users is never exposed to PostgREST directly, and this function does
-- not change that — it hands back exactly one derived value (the guest's
-- own first_name, as entered at signup; see signup-form.tsx) and only for
-- stays where public.is_provider_for_stay(stay_id, auth.uid()) is true.
-- auth.uid() is read from the caller's own authenticated session inside the
-- function body — never a parameter — so no caller can pass another
-- provider's identity to fish for guest names. No email, phone, last name,
-- or verification data is ever selected. Table-returning so the app can
-- batch-resolve every stay's guest name in one round trip.
create or replace function public.get_guest_first_names_for_provider(stay_ids uuid[])
returns table(stay_id uuid, first_name text)
language sql
security definer
set search_path = public
stable
as $$
  select s.id, nullif(trim(u.raw_user_meta_data->>'first_name'), '')
  from public.stays s
  join auth.users u on u.id = s.user_id
  where s.id = any(stay_ids)
    and public.is_provider_for_stay(s.id, auth.uid())
$$;

revoke all on function public.get_guest_first_names_for_provider(uuid[]) from public, anon;
grant execute on function public.get_guest_first_names_for_provider(uuid[]) to authenticated;
