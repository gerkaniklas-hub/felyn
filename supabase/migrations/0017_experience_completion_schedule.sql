-- Milestone 1: schedules 0016's function via pg_cron.
-- Run this ONLY after:
--   1. Confirming pg_cron is available for your project (Supabase
--      Dashboard -> Database -> Extensions). If it is not available on
--      your plan/region, do NOT run this file — tell me and I'll give you
--      the Vercel Cron Job + Route Handler fallback instead, which calls
--      the exact same 0016 function via RPC and needs no pg_cron at all.
--   2. 0016 has been applied.

create extension if not exists pg_cron with schema extensions;

-- ── idempotent, version-safe removal of any existing job with this name ─
-- Deliberately does NOT call cron.unschedule(text) — that overload was
-- only added in a later pg_cron release, and this project's bundled
-- version isn't something that can be verified from these files.
-- cron.unschedule(bigint) is pg_cron's original signature and is present
-- in every version, so looking the jobid(s) up first and unscheduling by
-- id works regardless of version. The loop (not a single lookup) also
-- cleans up a hypothetical duplicate rather than assuming at most one row
-- can ever exist.
do $$
declare
  v_jobid bigint;
begin
  for v_jobid in select jobid from cron.job where jobname = 'complete-past-experiences' loop
    perform cron.unschedule(v_jobid);
  end loop;
end $$;

-- Hourly is deliberately conservative: the completion rule only cares
-- about a calendar-day boundary in Atlantic/Canary time, so sub-hour
-- precision buys nothing. cron.schedule() runs the job as whichever role
-- executes this statement.
select cron.schedule(
  'complete-past-experiences',
  '0 * * * *',
  $$select public.complete_past_experiences();$$
);

-- ── verify role match instead of granting your way out of a mismatch ────
-- If this raises, the fix is to re-run this file connected AS the
-- function's owner (normally postgres) — never to grant EXECUTE to
-- whatever role the job ended up running as. Broadening access is not an
-- acceptable substitute for scheduling under the correct role.
do $$
declare
  v_owner text;
  v_job_user text;
begin
  select r.rolname into v_owner
  from pg_proc p join pg_roles r on r.oid = p.proowner
  where p.pronamespace = 'public'::regnamespace and p.proname = 'complete_past_experiences';

  select username into v_job_user from cron.job where jobname = 'complete-past-experiences';

  if v_owner is distinct from v_job_user then
    raise exception
      'Cron job role (%) does not match function owner (%). Re-run this script connected as % — do not grant EXECUTE to % instead.',
      v_job_user, v_owner, v_owner, v_job_user;
  end if;

  raise notice 'OK: job runs as % which matches the function owner.', v_job_user;
end $$;

-- ── final read-only check (not part of the DDL) — should return exactly
--    one row ────────────────────────────────────────────────────────────
--
--   select jobid, jobname, schedule, command, nodename, username, active
--   from cron.job where jobname = 'complete-past-experiences';
--
-- To confirm it's actually running on schedule, after waiting past the
-- next hour boundary:
--
--   select jobid, status, start_time, end_time, return_message
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'complete-past-experiences')
--   order by start_time desc limit 5;
