-- READ-ONLY production preflight for migrations 0035, 0036 and 0037.
--
-- Replaces the 0035/0036 isolated tests for PRODUCTION. Those disable booking
-- triggers, which locks public.booking_request_items exclusively while they run (see
-- docs/payments/stripe-test-mode-runbook.md, section 2).
--
-- What it reads and writes:
--   * one SELECT over the system catalogs, plus aggregate counts (no names, emails,
--     ids, secrets or other personal data);
--   * it writes nothing, runs no dynamic SQL, requests no locks itself, and calls no
--     function that changes state. Every object is looked up with to_regclass /
--     to_regprocedure / to_regnamespace, so a missing object gives a FAIL row, never
--     an error.
--
-- How to run it: in the Supabase SQL Editor as `postgres`, unchanged, BEFORE 0035, on
-- the database the migrations will be applied to.
--
-- Result columns: status | check_id | migration | prerequisite | detail
--   PASS  the prerequisite holds
--   FAIL  it doesn't: apply NOTHING until it is understood and resolved
--   INFO  a fact to read and decide on (not pass/fail)
-- Every PASS/FAIL row restates one precondition from section 1 of 0035, 0036 or 0037.
-- The migrations check them again themselves and roll back completely on any mismatch.

with required (check_id, migration, prerequisite, passed, detail) as (
  -- ── who runs it: the owner of every table the migrations change ──
  select 'E' || lpad(v.n::text, 2, '0'), 'all', 'current_user owns ' || v.t,
         coalesce(c.relowner = (select r.oid from pg_roles r where r.rolname = current_user), false),
         coalesce('owner: ' || pg_get_userbyid(c.relowner), 'table missing')
    from (values (1, 'public.booking_request_items'), (2, 'public.booking_requests'), (3, 'public.experiences'),
                 (4, 'public.messages'), (5, 'public.support_threads')) v(n, t)
    left join pg_class c on c.oid = to_regclass(v.t)

  -- ── 0035 ──
  union all
  select 'A01', '0035', 'booking_request_items_status_check allows exactly the five pre-payment states',
         coalesce((select array_agg(s.lit order by s.lit)
                     from (select distinct (regexp_matches(pg_get_constraintdef(k.oid), '''([^'']*)''', 'g'))[1] as lit
                             from pg_constraint k
                            where k.conrelid = to_regclass('public.booking_request_items')
                              and k.conname = 'booking_request_items_status_check') s)
                  = array['CANCELLED', 'CONFIRMED', 'DECLINED', 'REQUESTED', 'WITHDRAWN'], false),
         null
  union all
  select 'A02', '0035', 'column booking_request_items.payment_due_at does not exist yet',
         not exists (select 1 from information_schema.columns where table_schema = 'public'
                       and table_name = 'booking_request_items' and column_name = 'payment_due_at'),
         null
  union all
  select 'A03', '0035', 'booking_item_confirm is 0034''s version (takes the host lock, no AWAITING_PAYMENT)',
         coalesce(position('public.booking_host_lock(v_provider)' in f.src) > 0 and position('AWAITING_PAYMENT' in f.src) = 0, false),
         coalesce('fingerprint ' || left(encode(sha256(convert_to(f.src, 'UTF8')), 'hex'), 16), 'function missing')
    from (select (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.booking_item_confirm(uuid)')) as src) f
  union all
  select 'A04', '0035', 'booking_request_items_before_update is 0034''s version (overlap check, no AWAITING_PAYMENT)',
         coalesce(position('public.booking_host_overlap_exists(' in f.src) > 0 and position('AWAITING_PAYMENT' in f.src) = 0, false),
         coalesce('fingerprint ' || left(encode(sha256(convert_to(f.src, 'UTF8')), 'hex'), 16), 'function missing')
    from (select (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.booking_request_items_before_update()')) as src) f
  union all
  select 'A05.' || v.n, '0035', v.fn || ' does not exist yet', to_regprocedure(v.fn) is null, null
    from (values (1, 'public.booking_host_try_lock(uuid)'), (2, 'public.booking_expire_host_payments(uuid)'),
                 (3, 'public.expire_due_booking_payments()'), (4, 'public.booking_item_mark_paid(uuid)')) v(n, fn)
  union all
  select 'A06.' || v.n, '0035', v.fn || ' exists and current_user owns it',
         coalesce(p.proowner = (select r.oid from pg_roles r where r.rolname = current_user), false),
         coalesce('owner: ' || pg_get_userbyid(p.proowner), 'function missing')
    from (values (1, 'public.booking_request_items_sync_total()'), (2, 'public.booking_request_is_deletable(uuid)'),
                 (3, 'public.notify_guest_on_item_status_change()'), (4, 'public.email_outbox_on_item_status_change()'),
                 (5, 'public.booking_host_overlap_exists(uuid, uuid, timestamptz, timestamptz)'),
                 (6, 'public.booking_host_lock(uuid)'), (7, 'public.booking_item_confirm(uuid)'),
                 (8, 'public.booking_request_items_before_update()')) v(n, fn)
    left join pg_proc p on p.oid = to_regprocedure(v.fn)
  union all
  select 'A07.' || v.n, '0035', 'message INSERT policy "' || v.policy || '" (0021) exists',
         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages'
                   and cmd = 'INSERT' and policyname = v.policy),
         null
    from (values (1, 'Guests send messages on their own active items'), (2, 'Providers send messages on their own active items')) v(n, policy)
  union all
  select 'A08.' || v.n, '0035', 'email outbox trigger ' || v.tg || ' (0028) exists on booking_request_items',
         exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.booking_request_items')
                   and not t.tgisinternal and t.tgname = v.tg),
         null
    from (values (1, 'email_outbox_items_inserted'), (2, 'email_outbox_item_status_changed')) v(n, tg)

  -- ── 0036 ──
  union all
  select 'B01.' || v.n, '0036', v.obj || ' does not exist yet',
         case when v.kind = 'table' then to_regclass(v.obj) is null else to_regprocedure(v.obj) is null end, null
    from (values (1, 'table', 'public.host_payout_accounts'), (2, 'table', 'public.booking_payments'),
                 (3, 'table', 'public.stripe_events'), (4, 'table', 'public.booking_payment_transfer_releases'),
                 (5, 'function', 'public.booking_payment_transfer_blocker(uuid)'),
                 (6, 'function', 'public.support_staff_release_host_transfer(uuid, text)')) v(n, kind, obj)
  union all
  select 'B02.1', '0036', 'table public.staff_members (0029) exists', to_regclass('public.staff_members') is not null, null
  union all
  select 'B02.2', '0036', 'function public.is_felyn_staff() (0029) exists', to_regprocedure('public.is_felyn_staff()') is not null, null
  union all
  select 'B02.3', '0036', 'support_threads has user_id, booking_request_item_id, category, status, last_message_at',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'support_threads'
            and column_name in ('user_id', 'booking_request_item_id', 'category', 'status', 'last_message_at')) = 5,
         null
  union all
  select 'B02.4', '0036', 'column support_threads.case_activity_at does not exist yet',
         not exists (select 1 from information_schema.columns where table_schema = 'public'
                       and table_name = 'support_threads' and column_name = 'case_activity_at'),
         null
  union all
  select 'B02.5', '0036', 'function public.support_messages_touch_thread() (0029) exists',
         to_regprocedure('public.support_messages_touch_thread()') is not null, null
  union all
  select 'B03', '0036', 'function public.booking_request_items_before_insert() (0031/0032) exists',
         to_regprocedure('public.booking_request_items_before_insert()') is not null, null

  -- ── 0037 ──
  union all
  select 'C01', '0037', 'pgcrypto function extensions.hmac(bytea, bytea, text) exists',
         to_regprocedure('extensions.hmac(bytea, bytea, text)') is not null,
         (select 'pgcrypto ' || e.extversion || ' in schema ' || e.extnamespace::regnamespace::text from pg_extension e where e.extname = 'pgcrypto')
  union all
  select 'C02', '0037', 'schema felyn_private does not exist yet', to_regnamespace('felyn_private') is null, null
  union all
  select 'C03.' || v.n, '0037', v.fn || ' does not exist yet', to_regprocedure(v.fn) is null, null
    from (values (1, 'public.stripe_apply_event(text, text, text)'), (2, 'public.booking_payment_start(uuid)'),
                 (3, 'public.booking_payment_guest_status(uuid)'), (4, 'public.host_payout_account_status()'),
                 (5, 'public.stripe_record_checkout_session(uuid, text, timestamp with time zone)'),
                 (6, 'public.stripe_record_checkout_failure(uuid, text)'),
                 (7, 'public.stripe_register_host_account(uuid, text)')) v(n, fn)
  union all
  select 'C04', '0035-0037', 'time zone Atlantic/Canary is known (payment deadlines)',
         exists (select 1 from pg_timezone_names where name = 'Atlantic/Canary'), null
),
info (check_id, migration, prerequisite, detail) as (
  select 'I01', 'all', 'PostgreSQL server version', current_setting('server_version')
  union all
  -- I02-I07 count booking data. A direct reference to a missing table aborts a whole SQL
  -- statement, and avoiding that would need dynamic SQL, so those counts are a separate
  -- optional query (Q3 below). This row only says whether Q3 can run.
  select 'I02', '0035-0036', 'booking data counts I02-I07: run optional query Q3 at the end of this file',
         case when to_regclass('public.experiences') is not null and to_regclass('public.booking_request_items') is not null
              then 'Q3 can run (both tables exist)'
              else 'Q3 cannot run: ' || concat_ws(' and ',
                     case when to_regclass('public.experiences') is null then 'public.experiences is missing' end,
                     case when to_regclass('public.booking_request_items') is null then 'public.booking_request_items is missing' end)
                   || ' (see E01 / E03)'
         end
  union all
  select 'I08', 'expiry', 'pg_cron extension (needed only if the expiry schedule is approved)',
         coalesce((select 'pg_cron ' || e.extversion || ' in schema ' || e.extnamespace::regnamespace::text
                     from pg_extension e where e.extname = 'pg_cron'), 'not installed')
  union all
  select 'I09', 'expiry', 'scheduled jobs in cron.job (planner estimate only; list them exactly with optional query Q2)',
         coalesce((select case when c.reltuples < 0 then 'unknown (table never analyzed)'
                               else 'about ' || c.reltuples::bigint::text end
                     from pg_class c where c.oid = to_regclass('cron.job')),
                  'no cron.job table')
  union all
  select 'I10', 'all', 'other non-idle database sessions right now (apply the migrations when this is low)',
         (select count(*)::text from pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid())
)
select status, check_id, migration, prerequisite, detail
  from (select case when r.passed then 'PASS' else 'FAIL' end as status, r.check_id, r.migration, r.prerequisite, r.detail
          from required r
        union all
        select 'INFO', i.check_id, i.migration, i.prerequisite, i.detail
          from info i) result
 order by case status when 'FAIL' then 0 when 'PASS' then 1 else 2 end, check_id;

-- ── Optional follow-ups (separate queries; each names a table directly, so run it
--    only once the main result says that table exists) ──
-- Q1 (needs A08.1 and A08.2 = PASS): number of email outbox rows whose status is
--     'pending' or 'sending', per event type. A count only, not a prediction of what the
--     next dispatch will deliver: that also depends on each row's next_attempt_at, its
--     age, the booking's current state and EMAIL_DELIVERY_MODE.
--   select status, event_type, count(*) from public.email_outbox
--    where status in ('pending', 'sending') group by 1, 2 order by 1, 2;
-- Q2 (needs I08 = installed): the scheduled jobs that exist today (names and schedules only).
--   select jobname, schedule, active, username from cron.job order by jobname;
-- Q3 (needs I02 = "Q3 can run"): booking data counts (aggregates only).
--   select 'I02' as check_id, 'published experiences priced under €5 (can''t be republished or newly requested after 0036)' as fact,
--          count(*) filter (where price_per_person < 5 and published) as n from public.experiences
--   union all
--   select 'I03', 'unpublished experiences priced under €5',
--          count(*) filter (where price_per_person < 5 and not published) from public.experiences
--   union all
--   select 'I04', 'REQUESTED booking items (each becomes AWAITING_PAYMENT when accepted after 0035)',
--          count(*) filter (where status = 'REQUESTED') from public.booking_request_items
--   union all
--   select 'I05', 'REQUESTED booking items without a requested start (can''t be accepted since 0033)',
--          count(*) filter (where status = 'REQUESTED' and preferred_time is null) from public.booking_request_items
--   union all
--   select 'I06', 'REQUESTED booking items priced under €5 per person (acceptance refused after 0036, FB004)',
--          count(*) filter (where status = 'REQUESTED' and price_per_person < 5) from public.booking_request_items
--   union all
--   select 'I07', 'CONFIRMED booking items (stay confirmed; never asked to pay)',
--          count(*) filter (where status = 'CONFIRMED') from public.booking_request_items
--   order by 1;
