-- 0023: host applications + manual approval + providers lockdown  (FINAL, single-statement form)
--
-- ONE SQL statement (a single DO block), no BEGIN/COMMIT/ROLLBACK. Postgres runs it
-- as one implicit transaction: it either completes fully and commits, or raises an
-- error and rolls back fully — no partial state and no open transaction, regardless
-- of how the SQL Editor handles errors.
--
-- The migration statements in section 2 are identical to the ones exercised by
-- 0023_host_applications_isolated_test.failclosed.sql (which passed in production).
-- Section 1 refuses to run on an unexpected starting state; section 3 verifies the
-- end state and rolls everything back if anything is not exactly as intended.
--
-- Run as role `postgres`, the whole file, in one run, at a quiet time.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  -- Never queue behind live traffic while holding locks; if a lock is not granted
  -- within 5s the statement fails and nothing is applied (safe to retry later).
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS (the tested baseline) ═════════
  if to_regclass('public.host_applications') is not null then
    raise exception '0023 ABORTED: public.host_applications already exists';
  end if;
  if to_regnamespace('felyn_admin') is not null then
    raise exception '0023 ABORTED: schema felyn_admin already exists';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'providers') <> 1
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'providers'
                      and policyname = 'Providers manage their own profile'
                      and cmd = 'ALL' and roles = '{public}'
                      and qual = '(auth.uid() = user_id)'
                      and with_check = '(auth.uid() = user_id)') then
    raise exception '0023 ABORTED: providers policies differ from the tested baseline';
  end if;
  -- Exact captured baseline (same source view as the Z3 capture): anon, authenticated and
  -- service_role each hold exactly DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE.
  if (select count(*) from (
        select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'providers'
          and grantee in ('anon', 'authenticated', 'service_role')
        group by grantee
      ) g
      where g.privs = 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE') <> 3
     or exists (
        select 1
        from (values ('anon'), ('authenticated'), ('service_role')) r(role)
        cross join (values ('DELETE'), ('INSERT'), ('REFERENCES'), ('SELECT'), ('TRIGGER'), ('TRUNCATE'), ('UPDATE')) p(priv)
        where not has_table_privilege(r.role, 'public.providers', p.priv)
      ) then
    raise exception '0023 ABORTED: providers grants differ from the captured baseline (anon/authenticated/service_role must each hold exactly DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE)';
  end if;
  if exists (select 1 from public.providers where user_id is not null and verification_status is distinct from 'verified') then
    raise exception '0023 ABORTED: a linked provider is not verified (preflight assumption changed)';
  end if;

  -- ═════════ 2. MIGRATION (identical to the tested statements) ═════════
  create table public.host_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    first_name text not null check (char_length(btrim(first_name)) between 1 and 100),
    last_name  text not null check (char_length(btrim(last_name)) between 1 and 100),
    phone      text not null check (char_length(btrim(phone)) between 6 and 40),
    display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
    location text not null check (char_length(btrim(location)) between 2 and 200),
    experience_category text not null check (experience_category in ('food','drink','food_drink','other')),
    experience_description text not null check (char_length(experience_description) between 20 and 2000),
    background text check (background is null or char_length(background) <= 2000),
    website_url text check (website_url is null or char_length(website_url) <= 300),
    status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
    decision_message text check (decision_message is null or char_length(decision_message) <= 1000),
    provider_id uuid references public.providers(id) on delete set null,
    submitted_at timestamptz not null default now(),
    reviewed_at timestamptz,
    updated_at timestamptz not null default now()
  );
  create or replace function public.host_applications_default_display_name()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    new.display_name := coalesce(nullif(btrim(new.display_name), ''), btrim(new.first_name));
    new.updated_at := now();
    return new;
  end $fn$;
  revoke execute on function public.host_applications_default_display_name() from public, anon, authenticated;
  create trigger host_applications_default_display_name
    before insert or update of display_name on public.host_applications
    for each row execute function public.host_applications_default_display_name();
  alter table public.host_applications enable row level security;
  create policy "Applicants read their own application" on public.host_applications
    for select to authenticated using (user_id = auth.uid());
  create policy "Applicants submit their own application" on public.host_applications
    for insert to authenticated with check (
      user_id = auth.uid() and status = 'submitted'
      and provider_id is null and reviewed_at is null and decision_message is null);
  create policy "Applicants edit display name while pending" on public.host_applications
    for update to authenticated
    using (user_id = auth.uid() and status = 'submitted')
    with check (user_id = auth.uid() and status = 'submitted');
  revoke all on public.host_applications from anon, authenticated;
  grant select on public.host_applications to authenticated;
  grant insert (user_id, first_name, last_name, phone, display_name, location, experience_category,
                experience_description, background, website_url) on public.host_applications to authenticated;
  grant update (display_name) on public.host_applications to authenticated;

  drop policy if exists "Providers manage their own profile" on public.providers;
  create policy "Providers read their own profile" on public.providers
    for select to authenticated using (auth.uid() = user_id);
  revoke insert, update, delete on public.providers from anon, authenticated;

  create schema if not exists felyn_admin;
  revoke all on schema felyn_admin from public, anon, authenticated;
  create or replace function felyn_admin.approve_host_application(
    p_application_id uuid, p_display_name text default null, p_message text default null
  ) returns uuid language plpgsql security definer set search_path = '' as $fn$
  declare app public.host_applications; new_provider_id uuid;
  begin
    select * into app from public.host_applications where id = p_application_id for update;
    if not found then raise exception 'Application % not found', p_application_id; end if;
    if app.status <> 'submitted' then raise exception 'Application is already %', app.status; end if;
    if not exists (select 1 from auth.users u where u.id = app.user_id and u.email_confirmed_at is not null) then
      raise exception 'Applicant account % has no confirmed email', app.user_id;
    end if;
    if exists (select 1 from public.providers p where p.user_id = app.user_id) then
      raise exception 'This user is already linked to a provider profile';
    end if;
    insert into public.providers (user_id, display_name, base_location, verification_status)
    values (app.user_id, coalesce(nullif(btrim(p_display_name), ''), app.display_name), app.location, 'verified')
    returning id into new_provider_id;
    update public.host_applications
       set status = 'approved', reviewed_at = now(), updated_at = now(),
           decision_message = p_message, provider_id = new_provider_id
     where id = app.id;
    insert into public.notifications (user_id, type, title, body)
    values (app.user_id, 'host_application_approved', 'You''re now a Felyn host',
            'Your host application has been approved. You can now set up your experiences.');
    return new_provider_id;
  end $fn$;
  create or replace function felyn_admin.reject_host_application(p_application_id uuid, p_message text default null)
  returns void language plpgsql security definer set search_path = '' as $fn$
  begin
    update public.host_applications
       set status = 'rejected', reviewed_at = now(), updated_at = now(), decision_message = p_message
     where id = p_application_id and status = 'submitted';
    if not found then raise exception 'No submitted application with id %', p_application_id; end if;
  end $fn$;
  revoke execute on function felyn_admin.approve_host_application(uuid, text, text) from public, anon, authenticated, service_role;
  revoke execute on function felyn_admin.reject_host_application(uuid, text) from public, anon, authenticated, service_role;

  -- ═════════ 3. END-STATE VERIFICATION (any mismatch rolls everything back) ═════════
  if not (select relrowsecurity from pg_class where oid = 'public.host_applications'::regclass) then
    raise exception '0023 VERIFY FAILED: RLS not enabled on host_applications';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'host_applications') <> 3 then
    raise exception '0023 VERIFY FAILED: host_applications does not have exactly 3 policies';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'providers') <> 1
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'providers'
                      and policyname = 'Providers read their own profile'
                      and cmd = 'SELECT' and roles = '{authenticated}') then
    raise exception '0023 VERIFY FAILED: providers policy is not exactly "Providers read their own profile" (SELECT, authenticated)';
  end if;
  if has_table_privilege('authenticated', 'public.providers', 'INSERT')
     or has_table_privilege('authenticated', 'public.providers', 'UPDATE')
     or has_table_privilege('authenticated', 'public.providers', 'DELETE')
     or has_table_privilege('anon', 'public.providers', 'INSERT')
     or has_table_privilege('anon', 'public.providers', 'UPDATE')
     or has_table_privilege('anon', 'public.providers', 'DELETE')
     or not has_table_privilege('authenticated', 'public.providers', 'SELECT') then
    raise exception '0023 VERIFY FAILED: providers grants are not as intended';
  end if;
  if has_table_privilege('anon', 'public.host_applications', 'SELECT')
     or has_table_privilege('authenticated', 'public.host_applications', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.host_applications', 'SELECT')
     or not has_column_privilege('authenticated', 'public.host_applications', 'display_name', 'UPDATE')
     or has_column_privilege('authenticated', 'public.host_applications', 'status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.host_applications', 'status', 'INSERT')
     or not has_column_privilege('authenticated', 'public.host_applications', 'phone', 'INSERT') then
    raise exception '0023 VERIFY FAILED: host_applications grants are not as intended';
  end if;
  if has_schema_privilege('anon', 'felyn_admin', 'USAGE')
     or has_schema_privilege('authenticated', 'felyn_admin', 'USAGE')
     or has_function_privilege('anon', 'felyn_admin.approve_host_application(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'felyn_admin.approve_host_application(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'felyn_admin.approve_host_application(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'felyn_admin.reject_host_application(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'felyn_admin.reject_host_application(uuid,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'felyn_admin.reject_host_application(uuid,text)', 'EXECUTE') then
    raise exception '0023 VERIFY FAILED: felyn_admin is reachable by an API role';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'felyn_admin'
               and (not p.prosecdef
                    or not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path=')))) then
    raise exception '0023 VERIFY FAILED: a felyn_admin function is not SECURITY DEFINER with an empty search_path';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'host_applications_default_display_name'
                 and tgrelid = 'public.host_applications'::regclass) then
    raise exception '0023 VERIFY FAILED: display-name trigger missing';
  end if;
end
$migration$;
