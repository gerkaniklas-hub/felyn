-- P1.4: Guest-side individual item withdrawal
-- Run this once in the Supabase SQL Editor, after 0001-0010 have been applied.
--
-- Adds WITHDRAWN to booking_request_items.status: the guest can withdraw
-- ONE still-pending (REQUESTED) item without touching anything else in the
-- booking_request — same "per-item, never the whole request" model P1.1
-- established for provider confirm/decline (see lib/matching/booking-
-- requests.ts's withdrawBookingRequestItem). The item row is never
-- deleted, so it stays as history exactly like a DECLINED item does.
--
-- No RLS change: the existing "Users manage their own booking request
-- items" policy (0005) is `for all`, so the guest's own UPDATE to their own
-- item already works — this migration only widens the allowed status
-- values.

alter table public.booking_request_items drop constraint if exists booking_request_items_status_check;
alter table public.booking_request_items add constraint booking_request_items_status_check
  check (status in ('REQUESTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN'));
