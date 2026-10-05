-- NOT A MIGRATION. Production-only, re-runnable setup of the email outbox retry
-- scheduler:   pg_cron  ->  pg_net  ->  POST https://app.felyn.eu/api/email/sweep
--
-- Why: the app delivers each outbox email (0028) right after the booking action
-- (next/server after()). This job is the safety net: every 5 minutes it asks the
-- app to deliver whatever is due — retries after a failed attempt, and rows whose
-- immediate delivery never ran. Claiming (FOR UPDATE SKIP LOCKED), retry timing,
-- the 23-hour expiry and Resend idempotency all live in 0028 and the app; this
-- job only triggers them, so overlapping or repeated runs are harmless.
--
-- CONTAINS NO SECRET. The job's stored command reads the bearer secret from
-- Supabase Vault (vault.decrypted_secrets) each time it runs; the secret is never
-- written into this file, into cron.job, or into any migration.
--
-- Run ONLY after all of these (this script checks each and changes nothing if one
-- is missing):
--   1. 0028_email_outbox.sql is applied.
--   2. pg_net is enabled (Dashboard -> Database -> Extensions -> pg_net).
--   3. The Vault secret `email_sweep_secret` exists, created in the Dashboard's
--      Vault UI — NOT with vault.create_secret() in the SQL editor, which would
--      keep the secret in the editor's query history. Its value must be exactly
--      the Vercel Production variable EMAIL_SWEEP_SECRET: 32-256 characters of
--      A-Z a-z 0-9 _ - (e.g. 64 hex characters), no spaces or line breaks.
--   4. The app is deployed with EMAIL_SWEEP_SECRET set (otherwise the route
--      answers 404 and the job just does nothing useful).
--
-- What it does, as ONE statement (a single DO block — it applies fully or rolls
-- back fully):
--   * removes every existing cron job named 'email-outbox-sweep' (by jobid, as
--     0017 does, so it works on every pg_cron version) and schedules it afresh:
--     '*/5 * * * *', net.http_post(..., timeout_milliseconds := 60000).
--     Re-running it therefore replaces the job; it never creates a second one.
--   * verifies the result: exactly one active job, the expected schedule and
--     command, the job's role can read the Vault secret, and the secret's value
--     does not appear in the stored command.
--
-- What it does NOT do: enable pg_net, create or change any Vault secret, change
-- any table, function, trigger or migration object, or send anything itself.
--
-- Run as role `postgres` (the job runs as the role that schedules it), the whole
-- file, in one run. Expected result: "Success. No rows returned".
--
-- To stop the scheduler later (read-only lookup, then unschedule by id):
--   select jobid from cron.job where jobname = 'email-outbox-sweep';
--   select cron.unschedule(<jobid>);

do $setup$
declare
  v_secret_count int;
  v_secret_ok boolean;
  v_jobid bigint;
  v_job_user text;
  v_command constant text := $job$select net.http_post(
    url := 'https://app.felyn.eu/api/email/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'email_sweep_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;$job$;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.email_outbox') is null or to_regprocedure('public.claim_email_outbox(integer)') is null then
    raise exception 'SWEEP SETUP ABORTED: 0028 (public.email_outbox) is not applied';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'SWEEP SETUP ABORTED: pg_cron is not enabled';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'SWEEP SETUP ABORTED: pg_net is not enabled (Dashboard -> Database -> Extensions)';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'SWEEP SETUP ABORTED: Supabase Vault (vault.decrypted_secrets) is not available';
  end if;
  -- The value is only checked here, never printed.
  select count(*), coalesce(bool_and(decrypted_secret ~ '^[A-Za-z0-9_-]{32,256}$'), false)
    into v_secret_count, v_secret_ok
  from vault.decrypted_secrets where name = 'email_sweep_secret';
  if v_secret_count <> 1 then
    raise exception 'SWEEP SETUP ABORTED: expected exactly one Vault secret named email_sweep_secret (found %); create it in the Vault UI', v_secret_count;
  end if;
  if not v_secret_ok then
    raise exception 'SWEEP SETUP ABORTED: Vault secret email_sweep_secret must be 32-256 characters of A-Z a-z 0-9 _ - with no spaces or line breaks';
  end if;

  -- ═════════ 2. (RE)SCHEDULE ═════════
  for v_jobid in select jobid from cron.job where jobname = 'email-outbox-sweep' loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule('email-outbox-sweep', '*/5 * * * *', v_command);

  -- ═════════ 3. POSTCONDITIONS ═════════
  if (select count(*) from cron.job where jobname = 'email-outbox-sweep') <> 1 then
    raise exception 'SWEEP SETUP ROLLED BACK: expected exactly one email-outbox-sweep job';
  end if;
  select username into v_job_user from cron.job
  where jobname = 'email-outbox-sweep' and schedule = '*/5 * * * *' and command = v_command and active;
  if v_job_user is null then
    raise exception 'SWEEP SETUP ROLLED BACK: the job is not active with the expected schedule and command';
  end if;
  if not has_table_privilege(v_job_user, 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'SWEEP SETUP ROLLED BACK: the job runs as %, which cannot read vault.decrypted_secrets; run this file as postgres', v_job_user;
  end if;
  if exists (select 1 from cron.job j, vault.decrypted_secrets s
             where j.jobname = 'email-outbox-sweep' and s.name = 'email_sweep_secret'
               and position(s.decrypted_secret in j.command) > 0) then
    raise exception 'SWEEP SETUP ROLLED BACK: the stored job command contains the secret value';
  end if;
end
$setup$;

-- ── Read-only checks (run separately, after the first 5-minute boundary) ──
--
--   select jobid, jobname, schedule, username, active from cron.job where jobname = 'email-outbox-sweep';
--
--   select status, start_time, return_message from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'email-outbox-sweep')
--   order by start_time desc limit 5;                    -- expect 'succeeded'
--
--   select id, status_code, timed_out, error_msg, created from net._http_response
--   order by created desc limit 5;                       -- expect status_code 200 (kept ~6 h)
--
-- An HTTP 401 means the Vault value and Vercel's EMAIL_SWEEP_SECRET differ; 404
-- means EMAIL_SWEEP_SECRET is not set (or shorter than 32 characters) in Vercel.
