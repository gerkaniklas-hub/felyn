-- P1: Provider Dashboard Foundation
-- Run this once in the Supabase SQL Editor, after 0001-0006 have been applied.
--
-- Providers need to see booking requests/items for their OWN experiences,
-- and the stay name for those requests. None of the existing owner-only
-- policies on these tables are touched — these are purely additive SELECT
-- policies (Postgres OR's multiple permissive policies together for the
-- same command), so a guest's insert/update/delete access to their own
-- rows is unchanged, and a provider still can never write to any of these
-- tables through them.

drop policy if exists "Providers view requests for their experiences" on public.booking_requests;
create policy "Providers view requests for their experiences" on public.booking_requests
  for select to authenticated using (
    exists (
      select 1
      from public.booking_request_items bri
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
      where bri.booking_request_id = booking_requests.id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "Providers view items for their experiences" on public.booking_request_items;
create policy "Providers view items for their experiences" on public.booking_request_items
  for select to authenticated using (
    exists (
      select 1
      from public.experiences e
      join public.providers p on p.id = e.provider_id
      where e.id = booking_request_items.experience_id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "Providers view stays with their requests" on public.stays;
create policy "Providers view stays with their requests" on public.stays
  for select to authenticated using (
    exists (
      select 1
      from public.booking_requests br
      join public.booking_request_items bri on bri.booking_request_id = br.id
      join public.experiences e on e.id = bri.experience_id
      join public.providers p on p.id = e.provider_id
      where br.stay_id = stays.id
        and p.user_id = auth.uid()
    )
  );
