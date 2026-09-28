-- NOT A MIGRATION — reference instructions only, kept alongside 0016/0017
-- for when (if ever) you need to undo them. Not intended to be run as
-- part of the numbered sequence.
--
-- WARNING: dropping completed_at destroys any completion history already
-- recorded. Once dropped, there is no way to recover which items had been
-- auto-completed, or when. The guest profile's completed-experiences
-- statistic would revert to reading 0 until the column and cron job are
-- reintroduced. Re-running complete_past_experiences() from scratch at
-- that point would retroactively complete every still-CONFIRMED,
-- past-dated item all at once — not gradually, the way it would have
-- happened originally — which may look surprising if you weren't
-- expecting it.
--
-- Correct order: unschedule the cron job FIRST, then drop the schema
-- objects it calls. Dropping the function while the job is still
-- scheduled would leave a job that errors on its next run (logged in
-- cron.job_run_details) rather than failing cleanly now.

-- 1. Unschedule first (undo 0017). Uses cron.unschedule(bigint) for the
--    same version-safety reason 0017 does — never assumes
--    cron.unschedule(text) exists.
do $$
declare
  v_jobid bigint;
begin
  for v_jobid in select jobid from cron.job where jobname = 'complete-past-experiences' loop
    perform cron.unschedule(v_jobid);
  end loop;
end $$;

-- Verify no job remains (should return zero rows):
--   select * from cron.job where jobname = 'complete-past-experiences';

-- 2. Then drop the schema objects (undo 0016).
drop function if exists public.complete_past_experiences();
drop index if exists public.booking_request_items_pending_completion_idx;
alter table public.booking_request_items drop column if exists completed_at;
