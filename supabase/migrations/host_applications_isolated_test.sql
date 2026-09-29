-- NOT A MIGRATION. Fail-closed isolated test for the REVISED 0023.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (DDL, policies, grants, test rows), releases every
-- lock, and leaves the session idle, regardless of how the SQL Editor sends,
-- splits, or stops scripts. There is no code path that finishes normally.
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- Run it as role `postgres`, as the whole file, in one run.

do $test$
declare
  v_stage text := 'start';
  v_host uuid; v_provider uuid; v_exp uuid; v_guest uuid; v_guest2 uuid;
  v_stay uuid; v_req uuid; v_i1 uuid; v_i2 uuid; v_i3 uuid;
  v_pid uuid; v_new_exp uuid; v_row uuid; v_app uuid; v_app2 uuid;
  v_name text; v_status text; n int;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 1. REVISED 0023 BODY (verbatim from 0023_host_applications.revised.sql) ═════════
    v_stage := 'migration';

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

    -- ═════════ 2. SETUP (as postgres). Only NEW rows are created. ═════════
    v_stage := 'setup';

    select p.user_id, p.id, e.id into v_host, v_provider, v_exp
    from public.providers p join public.experiences e on e.provider_id = p.id
    where p.user_id is not null and e.published = true
    order by p.created_at limit 1;
    if v_exp is null then raise exception 'SETUP: no claimed provider with a published experience'; end if;

    select u.id into v_guest from auth.users u
    where u.email_confirmed_at is not null
      and not exists (select 1 from public.providers p where p.user_id = u.id)
    order by u.created_at limit 1;
    if v_guest is null then raise exception 'SETUP: need a confirmed auth user who is not a provider'; end if;

    select u.id into v_guest2 from auth.users u
    where u.id <> v_guest and not exists (select 1 from public.providers p where p.user_id = u.id)
    order by u.created_at limit 1;   -- optional; rejection checks are skipped if null

    insert into public.stays (user_id, property_name, location_text, check_in, check_out, guest_count)
    values (v_guest, 'HOST RLS TEST (rolled back)', 'Test', current_date + 7, current_date + 10, 2)
    returning id into v_stay;
    insert into public.booking_requests (user_id, stay_id, estimated_total)
    values (v_guest, v_stay, 0) returning id into v_req;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
    values (v_req, v_exp, current_date + 7, 'morning', 2, 0, 'REQUESTED') returning id into v_i1;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
    values (v_req, v_exp, current_date + 8, 'afternoon', 2, 0, 'REQUESTED') returning id into v_i2;
    insert into public.booking_request_items (booking_request_id, experience_id, planned_date, planned_moment, guest_count, price_per_person, status)
    values (v_req, v_exp, current_date + 9, 'evening', 2, 0, 'CONFIRMED') returning id into v_i3;

    -- ═════════ 3. ANON ═════════
    v_stage := 'anon (N1-N3)';
    set local role anon;
    begin
      select count(*) into n from public.host_applications;
      raise exception 'N1 FAILED: anon can read host_applications';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.providers (display_name) values ('anon host');
      raise exception 'N2 FAILED: anon can insert providers';
    exception when insufficient_privilege then null;
    end;
    begin
      perform felyn_admin.approve_host_application(gen_random_uuid());
      raise exception 'N3 FAILED: anon can reach felyn_admin';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 4. EXISTING HOST ═════════
    v_stage := 'existing host (H1-H10)';
    perform set_config('request.jwt.claim.sub', v_host::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_host, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_host then raise exception 'IMPERSONATION FAILED (host): auth.uid() = %', auth.uid(); end if;

    select id into v_pid from public.providers where user_id = v_host;
    if v_pid is null then raise exception 'H1 FAILED: host cannot read own provider row'; end if;

    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
    values (v_pid, 'HOST RLS TEST (rolled back)', 'food', 10, 1, 2, 60) returning id into v_new_exp;
    update public.experiences set title = 'HOST RLS TEST edited' where id = v_new_exp; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H3 FAILED: edit own experience'; end if;
    update public.experiences set published = true where id = v_new_exp; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H3 FAILED: publish own experience'; end if;
    update public.experiences set published = false where id = v_new_exp; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H3 FAILED: unpublish own experience'; end if;

    insert into public.experience_attributes (experience_id, attribute_type, attribute_value) values (v_new_exp, 'style', 'rls-test');
    delete from public.experience_attributes where experience_id = v_new_exp; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H4 FAILED: attributes'; end if;
    insert into public.experience_gallery (experience_id, image_url) values (v_new_exp, 'https://example.test/rls.jpg') returning id into v_row;
    update public.experience_gallery set sort_order = 1 where id = v_row; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H4 FAILED: gallery'; end if;
    insert into public.experience_availability (experience_id, available_from, available_until) values (v_new_exp, current_date, current_date + 30) returning id into v_row;
    delete from public.experience_availability where id = v_row; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H4 FAILED: availability'; end if;

    insert into public.service_locations (provider_id, location_text) values (v_pid, 'RLS test') returning id into v_row;
    update public.service_locations set is_current = false where id = v_row; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H5 FAILED: service locations'; end if;

    delete from public.experiences where id = v_new_exp; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H2 FAILED: delete own draft experience'; end if;

    select count(*) into n from public.booking_request_items where id in (v_i1, v_i2, v_i3);
    if n <> 3 then raise exception 'H6 FAILED: host sees % of 3 request items', n; end if;
    select count(*) into n from public.stays where id = v_stay;
    if n <> 1 then raise exception 'H6 FAILED: host cannot see the guest stay for its request'; end if;
    update public.booking_request_items set status = 'CONFIRMED'
     where id = v_i1 and status = 'REQUESTED'; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H6 FAILED: confirm'; end if;
    update public.booking_request_items set status = 'DECLINED', decline_reason = 'other', decided_at = now()
     where id = v_i2 and status = 'REQUESTED'; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H6 FAILED: decline'; end if;
    update public.booking_request_items
       set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'provider', cancellation_reason = 'OTHER'
     where id = v_i3 and status = 'CONFIRMED'; get diagnostics n = row_count;
    if n <> 1 then raise exception 'H6 FAILED: cancel'; end if;

    insert into public.messages (booking_request_item_id, sender_id, body)
    values (v_i1, v_host, 'HOST RLS TEST message');

    select count(*) into n from public.providers p
     where p.user_id = auth.uid() and p.id::text = (storage.foldername(v_pid::text || '/host-rls-test.jpg'))[1];
    if n <> 1 then raise exception 'H8 FAILED: storage upload policy predicate no longer matches own folder'; end if;

    begin
      update public.providers set display_name = display_name where id = v_pid;
      raise exception 'H9 FAILED: host could update its own provider row';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.providers (user_id, display_name) values (v_host, 'second profile');
      raise exception 'H10 FAILED: host could insert a provider row';
    exception when insufficient_privilege then null;
              when unique_violation then raise exception 'H10 FAILED: insert reached the unique constraint (privilege not revoked)';
    end;
    reset role;

    -- ═════════ 5. GUEST / APPLICANT ═════════
    v_stage := 'guest/applicant (G0-G8)';
    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_guest then raise exception 'IMPERSONATION FAILED (guest)'; end if;

    select count(*) into n from public.experiences where published = true;
    if n = 0 then raise exception 'G0 FAILED: guest sees no published experiences'; end if;
    insert into public.stays (user_id, property_name, location_text, check_in, check_out, guest_count)
    values (v_guest, 'GUEST RLS TEST (rolled back)', 'Test', current_date + 1, current_date + 2, 1);

    begin
      insert into public.providers (user_id, display_name, verification_status) values (v_guest, 'Self-made host', 'verified');
      raise exception 'G1 FAILED: guest created a provider row';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
      values (v_provider, 'hijack', 'food', 1, 1, 1, 60);
      raise exception 'G2 FAILED: guest created an experience under another provider';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.host_applications (user_id, first_name, last_name, location, experience_category, experience_description)
      values (v_guest, 'Test', 'Applicant', 'Tenerife', 'food', 'A long enough description of a test experience.');
      raise exception 'G3 FAILED: application accepted without a phone number';
    exception when not_null_violation then null;
    end;

    insert into public.host_applications (user_id, first_name, last_name, phone, location, experience_category, experience_description)
    values (v_guest, 'Testfirst', 'Applicant', '+34 600 000 000', 'Tenerife', 'food', 'A long enough description of a test experience.')
    returning id, display_name into v_app, v_name;
    if v_name <> 'Testfirst' then raise exception 'G4 FAILED: display_name defaulted to "%" instead of first name', v_name; end if;

    update public.host_applications set display_name = 'Chef Test' where id = v_app; get diagnostics n = row_count;
    if n <> 1 then raise exception 'G5 FAILED: applicant cannot edit display name while pending'; end if;

    begin
      update public.host_applications set status = 'approved' where id = v_app;
      raise exception 'G6 FAILED: applicant changed status';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.host_applications set location = 'Elsewhere' where id = v_app;
      raise exception 'G6 FAILED: applicant changed a non-display field';
    exception when insufficient_privilege then null;
    end;
    begin
      perform felyn_admin.approve_host_application(v_app);
      raise exception 'G7 FAILED: applicant reached felyn_admin.approve_host_application';
    exception when insufficient_privilege then null;
    end;

    select count(*) into n from public.providers where user_id = v_guest;
    if n <> 0 then raise exception 'G8 FAILED: pending applicant has a provider row'; end if;
    reset role;

    -- H11: existing host cannot read the new application
    v_stage := 'existing host (H11)';
    perform set_config('request.jwt.claim.sub', v_host::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_host, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.host_applications;
    if n <> 0 then raise exception 'H11 FAILED: host can read another user''s application'; end if;
    reset role;

    -- ═════════ 6. MANUAL APPROVAL (as postgres) → access granted ═════════
    v_stage := 'approval (A1-A5)';
    perform felyn_admin.approve_host_application(v_app);

    perform set_config('request.jwt.claim.sub', v_guest::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_guest, 'role', 'authenticated')::text, true);
    set local role authenticated;

    select id, display_name into v_pid, v_name from public.providers where user_id = v_guest;
    if v_pid is null then raise exception 'A1 FAILED: approved applicant has no provider row'; end if;
    if v_name <> 'Chef Test' then raise exception 'A1 FAILED: provider display_name is "%" (expected the chosen display name)', v_name; end if;

    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes)
    values (v_pid, 'APPROVED HOST TEST (rolled back)', 'drink', 5, 1, 2, 60) returning id into v_new_exp;

    select count(*) into n from public.host_applications where user_id = v_guest and status = 'approved' and provider_id = v_pid;
    if n <> 1 then raise exception 'A2 FAILED: application not marked approved'; end if;

    select count(*) into n from public.notifications
     where user_id = v_guest and type = 'host_application_approved' and booking_request_item_id is null and read_at is null;
    if n <> 1 then raise exception 'A3 FAILED: approval notification not readable by the new host'; end if;

    update public.notifications set read_at = now()
     where user_id = v_guest and type = 'host_application_approved'; get diagnostics n = row_count;
    if n <> 1 then raise exception 'A4 FAILED: new host cannot mark the approval notification read'; end if;

    update public.host_applications set display_name = 'Changed after approval' where user_id = v_guest;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'A5 FAILED: display name editable after approval'; end if;
    reset role;

    -- ═════════ 7. REJECTION (only if a second non-provider account exists; no RETURN statements) ═════════
    v_stage := 'rejection (R1-R3)';
    if v_guest2 is not null then
      insert into public.host_applications (user_id, first_name, last_name, phone, location, experience_category, experience_description)
      values (v_guest2, 'Reject', 'Test', '+34 600 000 001', 'Tenerife', 'drink', 'A long enough description for rejection test.')
      returning id into v_app2;
      perform felyn_admin.reject_host_application(v_app2, 'Test rejection');
      select status into v_status from public.host_applications where id = v_app2;
      if v_status <> 'rejected' then raise exception 'R1 FAILED: status is %', v_status; end if;
      begin
        perform felyn_admin.approve_host_application(v_app2);
        raise exception 'R2 FAILED: a rejected application could be approved';
      exception when raise_exception then
        if sqlerrm not like 'Application is already rejected%' then raise; end if;
      end;
      if exists (select 1 from public.providers where user_id = v_guest2) then
        raise exception 'R3 FAILED: rejected applicant has a provider row';
      end if;
    end if;

    v_stage := 'complete';

  exception when others then
    -- Any failure anywhere above: the inner block's changes are already undone;
    -- re-raise so the whole statement (including the migration DDL) is rolled back.
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed (rejection checks %). This error is intentional: every change has been rolled back.',
    case when v_guest2 is null then 'skipped: no second non-host account' else 'included' end;
end
$test$;
