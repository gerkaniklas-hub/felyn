-- 0020_experience_cancellation_notifications.sql
-- Stage 2c-A: cancellation notifications only. Run this once in the
-- Supabase SQL Editor, after 0001-0019 have been applied.
--
-- NOTE ON SCHEMA STATE: this migration's own preflight checks below assume
-- booking_request_items already has cancelled_at/cancelled_by/status
-- widened to include CANCELLED (migration "0018") and
-- cancellation_reason/cancellation_note (0019, present in this repo). At
-- the time of writing, 0018's own file is missing from
-- supabase/migrations/ even though its schema is confirmed live and
-- verified (0019's own preflight already depends on it, and this
-- project's whole cancellation feature is built and working against it) —
-- flagging this filesystem gap explicitly rather than silently ignoring
-- it or guessing at 0018's exact original contents to recreate here.
--
-- Adds ONE new, dedicated trigger + function for cancellation
-- notifications only. Does NOT touch notify_guest_on_item_status_change
-- (0009) or notify_on_new_message (0014) in any way — both keep firing
-- exactly as before, for exactly the same confirm/decline/message events.
-- No RLS policy is touched. No schema change (no new column, no new
-- table) — this only adds a function + trigger, both purely additive.

begin;

-- ── safety checks: confirm the schema this trigger depends on is
--    actually present, before creating anything ─────────────────────────
do $$
declare
  v_missing text[] := array[]::text[];
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_request_items' and column_name = 'cancelled_at'
  ) then
    v_missing := array_append(v_missing, 'cancelled_at');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_request_items' and column_name = 'cancelled_by'
  ) then
    v_missing := array_append(v_missing, 'cancelled_by');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_request_items'::regclass and contype = 'c'
      and conname = 'booking_request_items_cancelled_status_pair_check'
  ) then
    v_missing := array_append(v_missing, 'booking_request_items_cancelled_status_pair_check');
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'Aborting: this migration depends on cancellation schema (columns/constraints from "0018") that is not present: %. Apply that schema before this migration.',
      v_missing;
  end if;

  raise notice 'Preflight passed: cancellation schema (cancelled_at/cancelled_by/status pair check) confirmed present.';
end $$;

-- ── dedicated cancellation notification function ─────────────────────────
-- SECURITY DEFINER for the same structural reason 0009's own function is:
-- whichever party did NOT cancel needs a notification row inserted for
-- THEIR user_id, while the trigger runs inside the CANCELLING party's own
-- session — that session has no RLS grant to insert a notifications row
-- for someone else. This mirrors 0009/0014's already-shipped pattern
-- exactly, not a new privilege model.
--
-- Deliberately a SEPARATE function from notify_guest_on_item_status_change
-- (0009), not an edit to it — confirm/decline notification behavior is
-- untouched, and this function only ever fires for the CONFIRMED ->
-- CANCELLED transition specifically.
--
-- No EXECUTE revoke is added here (unlike 0016's complete_past_experiences,
-- which needed one): a function declared `returns trigger` can only ever
-- be invoked by the trigger mechanism itself — Postgres rejects any direct
-- `select notify_on_item_cancellation()` call outside trigger context
-- regardless of grants, so there is no RPC-exposure surface to lock down.
-- This matches why 0009/0014's own trigger functions never needed one
-- either.
create or replace function public.notify_on_item_cancellation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  guest_user_id uuid;
  host_user_id uuid;
  recipient_id uuid;
  experience_title text;
  provider_display_name text;
  moment_word text;
begin
  -- Requirement: fire only for a genuine CONFIRMED -> CANCELLED
  -- transition, never for any other update to an already-cancelled row
  -- (or any other status change — those remain 0009's exclusive concern).
  -- The trigger below is already scoped to `after update of status`; this
  -- is the value-level guard on top, matching 0009's own belt-and-braces
  -- style rather than trusting the application layer alone. Structurally,
  -- this also means the function can fire AT MOST ONCE per row, ever: the
  -- application layer's own guarded update (`.eq("status","CONFIRMED")`
  -- in both cancelBookingRequestItemAsGuest/AsProvider) means a row can
  -- only ever pass through CONFIRMED -> CANCELLED a single time in its
  -- lifetime, and this function only inserts a notification on exactly
  -- that transition — no separate uniqueness constraint is needed to
  -- prevent duplicates, the same reasoning 0009's own trigger already
  -- relies on for confirm/decline.
  if old.status is distinct from 'CONFIRMED' or new.status is distinct from 'CANCELLED' then
    return new;
  end if;

  -- Guest identity: same join 0009 already uses for the guest side.
  select br.user_id into guest_user_id
  from public.booking_requests br
  where br.id = new.booking_request_id;

  -- Provider identity: same join 0009 already uses to resolve the
  -- experience's title/provider display name, extended to also select the
  -- provider's own user_id.
  select p.user_id, e.title, p.display_name
    into host_user_id, experience_title, provider_display_name
  from public.experiences e
  join public.providers p on p.id = e.provider_id
  where e.id = new.experience_id;

  -- Recipient is whichever party did NOT initiate the cancellation.
  recipient_id := case when new.cancelled_by = 'guest' then host_user_id else guest_user_id end;

  -- Fail safe rather than notify the wrong participant (or abort the
  -- cancellation itself with a not-null violation) if any identity is
  -- unresolved. A provider's user_id can genuinely be null for an
  -- unclaimed demo profile (see 0002; 0014's notify_on_new_message
  -- already makes this exact same decision for the identical reason) —
  -- nothing to notify in that case, not an error.
  if guest_user_id is null or host_user_id is null or recipient_id is null then
    return new;
  end if;

  moment_word := lower(new.planned_moment);

  insert into public.notifications (user_id, type, title, body, booking_request_item_id)
  values (
    recipient_id,
    'booking_item_cancelled',
    case when new.cancelled_by = 'guest' then 'A booking was cancelled' else 'Your experience was cancelled' end,
    case
      when new.cancelled_by = 'guest' then
        'A guest cancelled ' || coalesce(experience_title, 'an experience')
          || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '.'
      else
        coalesce(provider_display_name, 'Your host') || ' cancelled your ' || coalesce(experience_title, 'experience')
          || ' for ' || to_char(new.planned_date, 'FMDay') || ' ' || moment_word || '.'
    end,
    new.id
  );

  return new;
end;
$$;

drop trigger if exists booking_request_item_cancellation_notify on public.booking_request_items;
create trigger booking_request_item_cancellation_notify
  after update of status on public.booking_request_items
  for each row
  execute function public.notify_on_item_cancellation();

commit;
