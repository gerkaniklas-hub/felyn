-- P1.2: Provider decline reasons + safer stay deletion
-- Run this once in the Supabase SQL Editor, after 0001-0009 have been applied.

-- ── structured decline reason ────────────────────────────────────────────
-- Captured for future product/operations analysis. Guarded the same way
-- status already is (a fixed check list). Providers can only ever write
-- these via the existing "Providers update items for their experiences"
-- UPDATE policy (0009) — scoped to their own experiences already, so no
-- RLS change is needed here. The app deliberately never selects these two
-- columns in guest-facing queries (see getActiveBookingRequest) — they're
-- provider/internal-facing, not something a guest needs to see.
alter table public.booking_request_items
  add column if not exists decline_reason text
    check (decline_reason is null or decline_reason in (
      'double_booking', 'no_longer_available', 'cannot_accommodate', 'unavailable_for_date', 'other'
    )),
  add column if not exists decline_note text;

-- ── safer stay deletion ──────────────────────────────────────────────────
-- 0005 originally made booking_requests.stay_id `on delete cascade`, which
-- would let deleting a stay blindly wipe out any booking_requests (and, by
-- a further cascade, their items) tied to it — including a provider's
-- CONFIRMED/DECLINED decisions, real marketplace history that shouldn't
-- vanish just because a guest removes the stay later. Tightening this to
-- `on delete restrict` makes the database refuse that outright; the app's
-- deleteStay (see src/app/home/actions.ts) is the only path that removes a
-- stay, and it explicitly deletes any benign WITHDRAWN requests (ones
-- where no item was ever actually decided) itself first, then the stay —
-- never a blind cascade.
alter table public.booking_requests drop constraint if exists booking_requests_stay_id_fkey;
alter table public.booking_requests
  add constraint booking_requests_stay_id_fkey
  foreign key (stay_id) references public.stays(id) on delete restrict;
