-- NOT A MIGRATION. Fail-closed isolated test for 0030_host_profile_editing.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (0030's constraints, trigger, grant and policy, and
-- every test row and profile edit), releases every lock, and leaves the session
-- idle. There is no code path that finishes normally.
--
-- Run it BEFORE 0030 (it applies 0030's body itself, then throws it away; once
-- 0030 is applied it fails at the first statement and should not be re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs three existing accounts in auth.users, at least one of which is not a
-- host (no providers row). Where the test needs a host profile for an account that
-- has none, it creates one — rolled back like everything else. The real checks run
-- as the `anon` / `authenticated` roles with a signed-in user's claims, so the
-- row-level security rules and column privileges are genuinely enforced.
--
-- Accounts:  A = host (edits their own profile)   B = another host   G = guest (no host profile)
--
-- What it checks:
--   1  anon cannot update providers at all
--   2  host A updates their own display_name, bio, base_location (and updated_at moves)
--   3  host A cannot update id, user_id, verification_status, created_at or updated_at
--   4  host A cannot update host B's row (0 rows; B unchanged)
--   5  guest G cannot update any provider row
--   6  a host whose verification_status is not 'verified' cannot update their row
--   7  length limits: name 1-80 (trimmed), bio <= 1000, base_location <= 120
--   8  profile_photo_url: own profile-folder URL or NULL only (not B's folder, not elsewhere)
--   9  languages: A adds/removes their own; cannot add to or remove from B's; G cannot add
--  10  provider_public_profiles shows A's new name/bio/location/photo (when A has a
--      published experience) — visibility rules unchanged

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid; v_g uuid;
  v_a_provider uuid; v_b_provider uuid;
  v_exp uuid;
  v_before timestamptz; v_after timestamptz;
  v_name text; v_photo text;
  n int;
  r record;
begin
  -- Never queue behind live traffic while holding locks (applies to every lock taken below).
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 1. 0030 BODY (verbatim from 0030_host_profile_editing.sql, section 2) ═════════
    v_stage := 'migration';
    alter table public.providers
      add constraint providers_display_name_length_check check (char_length(btrim(display_name)) between 1 and 80),
      add constraint providers_bio_length_check check (bio is null or char_length(bio) <= 1000),
      add constraint providers_base_location_length_check check (base_location is null or char_length(base_location) <= 120);

    create function public.providers_before_update()
    returns trigger language plpgsql set search_path = '' as $fn$
    begin
      -- A signed-in client (auth.uid() set) may only point the photo at its own
      -- profile folder in the public experience-images bucket, or clear it.
      if auth.uid() is not null
         and new.profile_photo_url is distinct from old.profile_photo_url
         and new.profile_photo_url is not null
         and new.profile_photo_url !~ ('^https://[^/]+/storage/v1/object/public/experience-images/'
                                       || new.id::text || '/profile/[A-Za-z0-9._-]+$') then
        raise exception 'profile_photo_url must be this host''s own uploaded profile photo'
          using errcode = '22023';
      end if;
      new.updated_at := now();
      return new;
    end $fn$;
    revoke execute on function public.providers_before_update() from public, anon, authenticated;
    create trigger providers_before_update
      before update on public.providers
      for each row execute function public.providers_before_update();

    grant update (display_name, bio, base_location, profile_photo_url) on public.providers to authenticated;

    create policy "Approved hosts update their own public profile" on public.providers
      for update to authenticated
      using (auth.uid() = user_id and verification_status = 'verified')
      with check (auth.uid() = user_id and verification_status = 'verified');

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    select u.id into v_g from auth.users u
     where not exists (select 1 from public.providers p where p.user_id = u.id)
     order by u.created_at limit 1;
    select u.id into v_a from auth.users u where u.id <> v_g order by u.created_at limit 1;
    select u.id into v_b from auth.users u where u.id not in (v_g, v_a) order by u.created_at limit 1;
    if v_a is null or v_b is null or v_g is null then
      raise exception 'SETUP: need three accounts in auth.users, one of them without a host profile';
    end if;

    select p.id into v_a_provider from public.providers p where p.user_id = v_a;
    if v_a_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_a, 'PROFILE TEST HOST A (rolled back)', 'verified') returning id into v_a_provider;
    end if;
    select p.id into v_b_provider from public.providers p where p.user_id = v_b;
    if v_b_provider is null then
      insert into public.providers (user_id, display_name, verification_status)
      values (v_b, 'PROFILE TEST HOST B (rolled back)', 'verified') returning id into v_b_provider;
    end if;
    -- Both test hosts are approved (as every host linked to an account is since 0023).
    update public.providers set verification_status = 'verified' where id in (v_a_provider, v_b_provider);
    -- A published experience, so A appears in provider_public_profiles (check 10).
    insert into public.experiences (provider_id, title, category, price_per_person, min_guests, max_guests, duration_minutes, published)
    values (v_a_provider, 'PROFILE TEST EXPERIENCE (rolled back)', 'food', 50, 1, 6, 120, true) returning id into v_exp;
    select p.display_name into v_name from public.providers p where p.id = v_b_provider;
    -- Backdate A's updated_at so check 2 can see the trigger move it (now() is fixed
    -- for the whole transaction, so the trigger is paused for this one setup write).
    alter table public.providers disable trigger providers_before_update;
    update public.providers set updated_at = now() - interval '1 day' where id = v_a_provider;
    alter table public.providers enable trigger providers_before_update;
    select p.updated_at into v_before from public.providers p where p.id = v_a_provider;

    -- ═════════ 3. ANON (check 1) ═════════
    v_stage := '1 anon';
    set local role anon;
    begin
      update public.providers set display_name = 'anon was here' where id = v_a_provider;
      raise exception '1 FAILED: anon can update providers';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 4. HOST A ON THEIR OWN ROW (checks 2, 3, 7, 8) ═════════
    v_stage := '2 own profile';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_a then raise exception 'IMPERSONATION FAILED (A): auth.uid() = %', auth.uid(); end if;

    update public.providers
       set display_name = 'Profile Test Name', bio = 'A short test story.', base_location = 'Test Town'
     where id = v_a_provider;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '2 FAILED: host A updated % rows of their own profile', n; end if;

    v_stage := '3 protected columns';
    for r in select unnest(array[
               'update public.providers set verification_status = ''pending'' where id = $1',
               'update public.providers set user_id = gen_random_uuid() where id = $1',
               'update public.providers set id = gen_random_uuid() where id = $1',
               'update public.providers set created_at = now() where id = $1',
               'update public.providers set updated_at = now() where id = $1']) as stmt loop
      begin
        execute r.stmt using v_a_provider;
        raise exception '3 FAILED: host A could run: %', r.stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;

    v_stage := '7 length limits';
    begin
      update public.providers set display_name = repeat('x', 81) where id = v_a_provider;
      raise exception '7 FAILED: an 81-character name was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.providers set display_name = '   ' where id = v_a_provider;
      raise exception '7 FAILED: a blank name was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.providers set bio = repeat('x', 1001) where id = v_a_provider;
      raise exception '7 FAILED: a 1001-character bio was accepted';
    exception when check_violation then null;
    end;
    begin
      update public.providers set base_location = repeat('x', 121) where id = v_a_provider;
      raise exception '7 FAILED: a 121-character location was accepted';
    exception when check_violation then null;
    end;
    update public.providers
       set display_name = repeat('n', 80), bio = repeat('b', 1000), base_location = repeat('l', 120)
     where id = v_a_provider;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '7 FAILED: values exactly at the limits were refused'; end if;
    update public.providers set bio = null, base_location = null where id = v_a_provider;

    v_stage := '8 photo url';
    v_photo := 'https://example.supabase.co/storage/v1/object/public/experience-images/'
               || v_a_provider::text || '/profile/' || gen_random_uuid()::text || '.jpg';
    update public.providers set profile_photo_url = v_photo where id = v_a_provider;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '8 FAILED: host A cannot set their own profile photo'; end if;
    for r in select unnest(array[
               'https://example.supabase.co/storage/v1/object/public/experience-images/' || v_b_provider::text || '/profile/x.jpg',
               'https://example.supabase.co/storage/v1/object/public/experience-images/' || v_a_provider::text || '/some-experience/x.jpg',
               'https://example.supabase.co/storage/v1/object/public/avatars/' || v_a_provider::text || '/profile/x.jpg',
               'https://tracker.example.com/pixel.gif',
               'http://example.supabase.co/storage/v1/object/public/experience-images/' || v_a_provider::text || '/profile/x.jpg']) as url loop
      begin
        update public.providers set profile_photo_url = r.url where id = v_a_provider;
        raise exception '8 FAILED: host A could point their photo at %', r.url;
      exception when invalid_parameter_value then null;
      end;
    end loop;
    update public.providers set profile_photo_url = null where id = v_a_provider;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '8 FAILED: host A cannot remove their photo'; end if;
    update public.providers set profile_photo_url = v_photo where id = v_a_provider;

    -- ═════════ 5. HOST A ON HOST B (check 4) ═════════
    v_stage := '4 other host';
    update public.providers set display_name = 'Hijacked', bio = 'Hijacked' where id = v_b_provider;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '4 FAILED: host A updated host B''s profile'; end if;
    update public.providers set display_name = 'Hijacked';  -- no WHERE: still only A's own row
    get diagnostics n = row_count;
    if n <> 1 then raise exception '4 FAILED: an unfiltered update reached % rows', n; end if;
    update public.providers set display_name = 'Profile Test Name' where id = v_a_provider;

    v_stage := '9 languages (host A)';
    insert into public.provider_languages (provider_id, language) values (v_a_provider, 'Profile Test Language');
    select count(*) into n from public.provider_languages where provider_id = v_a_provider and language = 'Profile Test Language';
    if n <> 1 then raise exception '9 FAILED: host A cannot add their own language'; end if;
    delete from public.provider_languages where provider_id = v_a_provider and language = 'Profile Test Language';
    get diagnostics n = row_count;
    if n <> 1 then raise exception '9 FAILED: host A cannot remove their own language'; end if;
    begin
      insert into public.provider_languages (provider_id, language) values (v_b_provider, 'Profile Test Language');
      raise exception '9 FAILED: host A added a language to host B';
    exception when insufficient_privilege then null;
    end;
    reset role;
    -- B's own language, added as postgres, which A must not be able to remove.
    insert into public.provider_languages (provider_id, language) values (v_b_provider, 'Profile Test Language B');
    set local role authenticated;
    delete from public.provider_languages where provider_id = v_b_provider;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '9 FAILED: host A removed % of host B''s languages', n; end if;
    reset role;

    select count(*) into n from public.provider_languages where provider_id = v_b_provider and language = 'Profile Test Language B';
    if n <> 1 then raise exception '9 FAILED: host B''s language is gone'; end if;
    select p.updated_at into v_after from public.providers p where p.id = v_a_provider;
    if v_after is null or v_after <= v_before then raise exception '2 FAILED: updated_at did not move'; end if;
    select count(*) into n from public.providers p where p.id = v_b_provider and p.display_name = v_name;
    if n <> 1 then raise exception '4 FAILED: host B''s profile changed'; end if;

    -- ═════════ 6. GUEST G (checks 5, 9) ═════════
    v_stage := '5 guest';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if auth.uid() is distinct from v_g then raise exception 'IMPERSONATION FAILED (G): auth.uid() = %', auth.uid(); end if;
    update public.providers set display_name = 'Guest was here';
    get diagnostics n = row_count;
    if n <> 0 then raise exception '5 FAILED: a guest updated % provider rows', n; end if;
    begin
      insert into public.provider_languages (provider_id, language) values (v_a_provider, 'Guest Language');
      raise exception '5 FAILED: a guest added a language to a host';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 7. UNAPPROVED HOST (check 6) ═════════
    v_stage := '6 unapproved host';
    update public.providers set verification_status = 'pending' where id = v_b_provider;
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.providers set display_name = 'Pending host edit' where id = v_b_provider;
    get diagnostics n = row_count;
    if n <> 0 then raise exception '6 FAILED: a host that is not verified updated their profile'; end if;
    reset role;
    update public.providers set verification_status = 'verified' where id = v_b_provider;

    -- ═════════ 8. PUBLIC PROFILE (check 10) ═════════
    v_stage := '10 public profile';
    perform set_config('request.jwt.claim.sub', v_g::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.provider_public_profiles pp
     where pp.id = v_a_provider and pp.display_name = 'Profile Test Name' and pp.profile_photo_url = v_photo;
    if n <> 1 then raise exception '10 FAILED: the public profile does not show host A''s saved changes'; end if;
    reset role;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
