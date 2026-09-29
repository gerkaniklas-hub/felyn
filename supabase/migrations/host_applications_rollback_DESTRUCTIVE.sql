-- UNDO for 0023 — restores the exact pre-0023 baseline recorded in production:
--   providers policy "Providers manage their own profile": ALL, roles {public},
--     USING (auth.uid() = user_id), WITH CHECK (auth.uid() = user_id)
--   providers grants for anon, authenticated, service_role:
--     DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   no host_applications table, no felyn_admin schema.
--
-- ONE SQL statement (single DO block): completes fully or rolls back fully.
-- Run as role `postgres`, whole file, one run.
--
-- ⚠ DESTRUCTIVE: drops public.host_applications and every application in it.
--   Export the table first if any real applications exist.
-- Deliberately NOT undone: providers rows created by approvals (approved hosts keep
--   their host access) and 'host_application_approved' notifications (harmless).

do $undo$
begin
  perform set_config('lock_timeout', '5s', true);

  -- 1. remove the review functions and their private schema
  drop function if exists felyn_admin.approve_host_application(uuid, text, text);
  drop function if exists felyn_admin.reject_host_application(uuid, text);
  drop schema if exists felyn_admin;               -- RESTRICT: fails if anything unexpected is inside

  -- 2. remove the applications table (its policies, trigger and grants go with it), then its trigger function
  drop table if exists public.host_applications;   -- RESTRICT: fails if anything else depends on it
  drop function if exists public.host_applications_default_display_name();

  -- 3. restore the original providers policy exactly as in 0002 (no TO clause => roles {public})
  drop policy if exists "Providers read their own profile" on public.providers;
  drop policy if exists "Providers manage their own profile" on public.providers;
  create policy "Providers manage their own profile" on public.providers
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

  -- 4. restore the revoked grants (REFERENCES, SELECT, TRIGGER, TRUNCATE were never revoked)
  grant insert, update, delete on public.providers to anon, authenticated;

  -- 5. verify the baseline; any mismatch rolls the undo back
  if to_regclass('public.host_applications') is not null or to_regnamespace('felyn_admin') is not null then
    raise exception 'UNDO VERIFY FAILED: 0023 objects still present';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'providers') <> 1
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'providers'
                      and policyname = 'Providers manage their own profile'
                      and cmd = 'ALL' and roles = '{public}'
                      and qual = '(auth.uid() = user_id)' and with_check = '(auth.uid() = user_id)') then
    raise exception 'UNDO VERIFY FAILED: providers policy differs from the baseline';
  end if;
  if exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) r(role)
    cross join (values ('DELETE'), ('INSERT'), ('REFERENCES'), ('SELECT'), ('TRIGGER'), ('TRUNCATE'), ('UPDATE')) p(priv)
    where not has_table_privilege(r.role, 'public.providers', p.priv)
  ) then
    raise exception 'UNDO VERIFY FAILED: providers grants differ from the baseline';
  end if;
end
$undo$;
