-- NOT A MIGRATION. Production setup of the booking payment-expiry job (re-runnable).
--
-- pg_cron  ->  public.expire_due_booking_payments()   every minute
--
-- Why: an accepted booking (AWAITING_PAYMENT, 0035) reserves the host's time until its
-- payment_due_at. This job turns every reservation whose deadline has passed into
-- PAYMENT_EXPIRED, releasing the host's time — a booking-state operation run entirely
-- in the database: no app route, no email system, no service-role key. Same mechanism
-- as the hourly experience-completion job (0017_experience_completion_schedule.sql).
--
-- Release delay: a new acceptance never waits for this job (booking_item_confirm
-- releases the host's own lapsed reservations itself, under the host lock). The job
-- only updates what everyone sees: a lapsed reservation shows as PAYMENT_EXPIRED within
-- about a minute of its deadline (a host that is accepting at that very moment is
-- skipped and picked up on the next run).
--
-- Run ONLY after 0035 is applied, in the release that ships payment (until guests can
-- pay, every accepted booking would expire). Requires pg_cron (Dashboard -> Database ->
-- Extensions -> pg_cron; already enabled where 0017 was run). Run as role `postgres`,
-- the owner of the function, the whole file, in one run.
-- Expected result: "Success. No rows returned" and a NOTICE "OK: …".
--
-- Stopping it: select jobid from cron.job where jobname = 'expire-due-booking-payments';
--              then select cron.unschedule(<jobid>);

do $$
declare
  v_jobid bigint;
  v_owner text;
  v_job_user text;
begin
  if to_regprocedure('public.expire_due_booking_payments()') is null then
    raise exception 'EXPIRY SCHEDULE ABORTED: public.expire_due_booking_payments() does not exist — apply 0035 first';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'EXPIRY SCHEDULE ABORTED: pg_cron is not enabled';
  end if;

  -- Replace any earlier copy of the job (by jobid, as 0017 does).
  for v_jobid in select jobid from cron.job where jobname = 'expire-due-booking-payments' loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule('expire-due-booking-payments', '* * * * *', 'select public.expire_due_booking_payments();');

  -- The job must run as the function's owner (no client role can execute it).
  select r.rolname into v_owner
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.expire_due_booking_payments()'::regprocedure;
  select username into v_job_user from cron.job where jobname = 'expire-due-booking-payments';
  if v_owner is distinct from v_job_user then
    raise exception 'EXPIRY SCHEDULE ABORTED: the job would run as % but the function belongs to % — run this file as %',
      v_job_user, v_owner, v_owner;
  end if;
  if (select count(*) from cron.job where jobname = 'expire-due-booking-payments' and active) <> 1 then
    raise exception 'EXPIRY SCHEDULE ABORTED: expected exactly one active expire-due-booking-payments job';
  end if;
  raise notice 'OK: expire-due-booking-payments runs every minute as %.', v_job_user;
end $$;

-- Read-only checks after a few minutes:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'expire-due-booking-payments')
--    order by start_time desc limit 5;
