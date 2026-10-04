-- NOT A MIGRATION. Fail-closed isolated test for 0027_user_contact_details.sql.
--
-- This file is ONE SQL statement (a single DO block). It contains no BEGIN,
-- COMMIT or ROLLBACK. Postgres runs a single statement in its own implicit
-- transaction, and this block is written so that it ALWAYS ends by raising an
-- error — on success as well as on failure. Postgres therefore always rolls
-- back every change it made (the table, policies, grants, test rows), releases
-- every lock, and leaves the session idle. There is no code path that finishes
-- normally.
--
-- Run it BEFORE 0027 (it creates 0027's objects itself, then throws them away;
-- once 0027 is applied it fails at the first statement and should not be re-run).
--
-- HOW TO READ THE RESULT (the editor will ALWAYS show an error):
--   ERROR: P0001: FELYN TEST PASSED — ...   -> every check passed; nothing was kept
--   ERROR: P0001: FELYN TEST FAILED at ...  -> a check or statement failed; nothing was kept
--   any other error (e.g. lock timeout)     -> the test did not complete; nothing was kept
--
-- It needs two existing accounts in auth.users (any two; no data of theirs is read
-- or changed, and the test rows are rolled back).
--
-- Run it as role `postgres`, as the whole file, in one run.

do $test$
declare
  v_stage text := 'start';
  v_a uuid; v_b uuid;
  v_verified timestamptz; n int;
begin
  perform set_config('lock_timeout', '3s', true);

  begin  -- ── all work happens inside this block; any error is converted to FELYN TEST FAILED ──

    -- ═════════ 1. 0027 BODY (section 2 of 0027_user_contact_details.sql, verbatim) ═════════
    v_stage := 'migration';
    create table public.user_contact_details (
      user_id uuid primary key references auth.users(id) on delete cascade,
      phone_number text not null,
      phone_country text not null,
      phone_verified_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint user_contact_details_phone_number_e164_check check (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
      constraint user_contact_details_phone_country_check check (phone_country ~ '^[A-Z]{2}$'),
      constraint user_contact_details_phone_number_key unique (phone_number)
    );
    create function public.user_contact_details_before_write()
    returns trigger language plpgsql set search_path = '' as $fn$
    begin
      if tg_op = 'UPDATE' and new.phone_number is distinct from old.phone_number then
        new.phone_verified_at := null;
      end if;
      new.updated_at := now();
      return new;
    end $fn$;
    revoke execute on function public.user_contact_details_before_write() from public, anon, authenticated;
    create trigger user_contact_details_before_write
      before insert or update on public.user_contact_details
      for each row execute function public.user_contact_details_before_write();
    alter table public.user_contact_details enable row level security;
    create policy "Users read their own contact details" on public.user_contact_details
      for select to authenticated using (auth.uid() = user_id);
    create policy "Users add their own contact details" on public.user_contact_details
      for insert to authenticated with check (auth.uid() = user_id);
    create policy "Users update their own contact details" on public.user_contact_details
      for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
    revoke all on public.user_contact_details from public, anon, authenticated;
    grant select on public.user_contact_details to authenticated;
    grant insert (user_id, phone_number, phone_country) on public.user_contact_details to authenticated;
    grant update (phone_number, phone_country) on public.user_contact_details to authenticated;

    -- ═════════ 2. SETUP ═════════
    v_stage := 'setup';
    select u.id into v_a from auth.users u order by u.created_at limit 1;
    select u.id into v_b from auth.users u where u.id <> v_a order by u.created_at limit 1;
    if v_a is null or v_b is null then raise exception 'SETUP: need two accounts in auth.users'; end if;

    -- ═════════ 3. ANON (N1-N2) ═════════
    v_stage := 'anon (N1-N2)';
    set local role anon;
    begin
      select count(*) into n from public.user_contact_details;
      raise exception 'N1 FAILED: anon can read user_contact_details';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_a, '+34612345678', 'ES');
      raise exception 'N2 FAILED: anon can insert user_contact_details';
    exception when insufficient_privilege then null;
    end;
    reset role;

    -- ═════════ 4. USER A (A1-A6) ═════════
    v_stage := 'user A (A1-A6)';
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_a, '0034612345678', 'ES');
      raise exception 'A1 FAILED: a non-E.164 number was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_a, '+34612345678', 'es');
      raise exception 'A2 FAILED: a lowercase country code was accepted';
    exception when check_violation then null;
    end;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country, phone_verified_at)
      values (v_a, '+34612345678', 'ES', now());
      raise exception 'A3 FAILED: a user could set phone_verified_at';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_b, '+34612345678', 'ES');
      raise exception 'A4 FAILED: user A created a contact record for user B';
    exception when insufficient_privilege then null;
    end;
    insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_a, '+34612345678', 'ES');
    select count(*) into n from public.user_contact_details;
    if n <> 1 then raise exception 'A5 FAILED: user A sees % rows after adding their own', n; end if;
    update public.user_contact_details set phone_number = '+34612345679' where user_id = v_a;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'A6 FAILED: user A could not update their own number'; end if;
    reset role;

    -- ═════════ 5. USER B (B1-B7) ═════════
    v_stage := 'user B (B1-B7)';
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.user_contact_details;
    if n <> 0 then raise exception 'B1 FAILED: user B can read user A''s contact record'; end if;
    update public.user_contact_details set phone_number = '+34600000000' where user_id = v_a;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'B2 FAILED: user B changed user A''s number'; end if;
    begin
      insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_b, '+34612345679', 'ES');
      raise exception 'B3 FAILED: the same number was accepted for a second account';
    exception when unique_violation then null;
    end;
    insert into public.user_contact_details (user_id, phone_number, phone_country) values (v_b, '+4915123456789', 'DE');
    begin
      delete from public.user_contact_details where user_id = v_b;
      raise exception 'B4 FAILED: a user could delete their contact record';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.user_contact_details set user_id = v_a where user_id = v_b;
      raise exception 'B5 FAILED: a user could move their record to another account';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.user_contact_details set phone_verified_at = now() where user_id = v_b;
      raise exception 'B6 FAILED: a user could mark their number verified';
    exception when insufficient_privilege then null;
    end;
    select count(*) into n from public.user_contact_details;
    if n <> 1 then raise exception 'B7 FAILED: user B sees % rows (expected only their own)', n; end if;
    reset role;

    -- ═════════ 6. VERIFIED RESET (V1-V2) ═════════
    v_stage := 'verified reset (V1-V2)';
    update public.user_contact_details set phone_verified_at = now() where user_id = v_a;  -- as postgres
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.user_contact_details set phone_country = 'ES' where user_id = v_a;   -- same number
    reset role;
    select phone_verified_at into v_verified from public.user_contact_details where user_id = v_a;
    if v_verified is null then raise exception 'V1 FAILED: verification cleared without a number change'; end if;
    set local role authenticated;
    update public.user_contact_details set phone_number = '+34612345670' where user_id = v_a;
    reset role;
    select phone_verified_at into v_verified from public.user_contact_details where user_id = v_a;
    if v_verified is not null then raise exception 'V2 FAILED: verification kept after the number changed'; end if;

    v_stage := 'complete';

  exception when others then
    raise exception 'FELYN TEST FAILED at stage "%": % (SQLSTATE %)', v_stage, sqlerrm, sqlstate;
  end;

  -- Reached only when every check passed. Raising here is deliberate: it forces
  -- Postgres to roll back the entire statement, so nothing from the test is kept.
  raise exception 'FELYN TEST PASSED — all checks passed. This error is intentional: every change has been rolled back.';
end
$test$;
