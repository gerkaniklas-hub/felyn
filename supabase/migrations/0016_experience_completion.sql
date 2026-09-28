-- Milestone 1: automatic experience completion (schema + function only —
-- scheduling is a separate file, 0017, since it depends on pg_cron being
-- enabled on your project, which this file does not assume).
-- Run this once in the Supabase SQL Editor, after 0001-0015 have been applied.
--
-- Adds ONE nullable column: completed_at. No existing booking status value
-- changes, no new status is introduced — orthogonal to `status`, the same
-- pattern 0012 used for preferred_time/host_note.
--
-- No RLS change: the existing guest owner policy (0005, "for all") and the
-- provider SELECT policy (0007) already cover reading this column, exactly
-- as 0012 reasoned for preferred_time/host_note.

alter table public.booking_request_items
  add column if not exists completed_at timestamptz;

create index if not exists booking_request_items_pending_completion_idx
  on public.booking_request_items (planned_date)
  where status = 'CONFIRMED' and completed_at is null;

-- ── the completion function ──────────────────────────────────────────────
-- SECURITY DEFINER: executes with the OWNER's privileges regardless of
-- caller — the function's owner is whichever role runs this CREATE
-- statement (standard Supabase SQL Editor sessions connect as `postgres`;
-- verify with `select current_user;` before running this if you want
-- certainty). `search_path = ''` plus fully schema-qualified references
-- (`public.booking_request_items`) is stricter than this codebase's
-- earlier `search_path = public` convention (used in 0009's trigger): it
-- removes any possibility of search-path hijacking via a same-named
-- object planted in another schema. `now()` is a built-in resolved via
-- pg_catalog, which Postgres always searches first regardless of this
-- setting, so it's unaffected.
--
-- Completion rule: an item completes once the ENTIRE planned day has
-- passed in Tenerife-local time. planned_date is a plain date (no
-- timezone attached); comparing it against "today's date, right now, in
-- the Canary Islands" — never the database session's own timezone
-- (Supabase defaults to UTC) and never the app server's timezone — is
-- what "at (now() at time zone 'Atlantic/Canary')::date" does. Note the
-- Canary Islands use Atlantic/Canary (WET/WEST), which is ONE HOUR BEHIND
-- mainland Spain's Europe/Madrid (CET/CEST) — do not substitute the
-- latter.
create or replace function public.complete_past_experiences()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.booking_request_items
  set completed_at = now()
  where status = 'CONFIRMED'
    and completed_at is null
    and planned_date < (now() at time zone 'Atlantic/Canary')::date;
end;
$$;

-- EXECUTE lockdown — idempotent, safe to re-run. Supabase's PostgREST
-- layer auto-exposes every public-schema function as an RPC endpoint
-- unless revoked, reachable by anon/authenticated/service_role by
-- default. This function's effect is narrow, but there is no reason any
-- client role — including service_role — should invoke it directly today,
-- so access is revoked from all four PostgREST-facing roles. The only
-- documented scenario that would justify re-granting service_role in a
-- future migration is if pg_cron turns out to be unavailable and a Vercel
-- Cron Job + Route Handler calls this via RPC with the service-role key
-- instead — not done now, only noted as the one legitimate reason it
-- could ever change.
revoke all on function public.complete_past_experiences() from public;
revoke all on function public.complete_past_experiences() from anon;
revoke all on function public.complete_past_experiences() from authenticated;
revoke all on function public.complete_past_experiences() from service_role;

-- ── read-only verification (run after the above, not part of the DDL) ───
-- Confirms the function's actual owner. Expected: postgres (or whichever
-- role you were connected as when you ran this file).
--
--   select p.proname, r.rolname as owner
--   from pg_proc p join pg_roles r on r.oid = p.proowner
--   where p.pronamespace = 'public'::regnamespace and p.proname = 'complete_past_experiences';
--
-- Confirms no client role can call it directly (every row should show no
-- privileges for anon/authenticated/service_role/PUBLIC):
--
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public' and routine_name = 'complete_past_experiences';
