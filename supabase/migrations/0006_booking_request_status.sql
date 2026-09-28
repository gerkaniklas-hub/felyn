-- M7.2: Request State & Locked Plan
-- Run this once in the Supabase SQL Editor, after 0001-0005 have been applied.

-- Add WITHDRAWN to the status enum. Postgres requires dropping and
-- recreating a check constraint to add a value; the name below is
-- Postgres's own default name for the unnamed column check created in
-- 0005 (`<table>_<column>_check`).
alter table public.booking_requests drop constraint if exists booking_requests_status_check;
alter table public.booking_requests add constraint booking_requests_status_check check (status in (
  'REQUESTED', 'PENDING_PROVIDER_CONFIRMATION', 'CONFIRMED',
  'DECLINED', 'CANCELLED', 'COMPLETED', 'WITHDRAWN'
));

-- At most one ACTIVE (REQUESTED or CONFIRMED) request per stay. WITHDRAWN
-- (or any other terminal status) doesn't count, so a guest can always
-- submit a new request after withdrawing. Enforced here at the database
-- level as the source of truth; submitBookingRequest also checks this
-- server-side so the guest gets a friendly error instead of a raw
-- constraint violation in the common case.
create unique index if not exists booking_requests_one_active_per_stay_idx
  on public.booking_requests (stay_id)
  where status in ('REQUESTED', 'CONFIRMED');
