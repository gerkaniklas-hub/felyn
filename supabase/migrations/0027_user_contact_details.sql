-- 0027: public.user_contact_details — one canonical contact record (mobile number) per account
--
-- ONE SQL statement (a single DO block), same form as 0023-0026: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: every guest and host must give Felyn a phone number. Until now it lived in
-- auth.users.user_metadata (optional, free text, editable by the user, invisible to
-- the database's rules) and, for host applicants, as free text in
-- host_applications.phone. This table is the single source of truth from now on, for
-- guests and hosts alike.
--
-- What it does:
--   * creates public.user_contact_details, one row per account (user_id is the primary
--     key, references auth.users, deleted with the account):
--       - phone_number: canonical E.164 ("+4915123456789"), checked for E.164 shape
--         here; the app validates it against the country's numbering plan before saving.
--         UNIQUE: one number belongs to one Felyn account.
--       - phone_country: the ISO 3166-1 alpha-2 code the user picked ("DE"). Kept
--         separately because some calling codes are shared (+1 US/Canada/Caribbean,
--         +44 UK/Jersey/Guernsey/Isle of Man, +7 Russia/Kazakhstan).
--       - phone_verified_at: NULL. Reserved for future SMS verification; nothing sets it
--         yet, users can never write it, and changing phone_number clears it.
--       - created_at / updated_at.
--   * RLS: a signed-in user can read, add and update ONLY their own row. No delete.
--     Nobody else (other guests, hosts, anon) can read any row.
--   * privileges: anon gets nothing; authenticated may SELECT, INSERT only
--     (user_id, phone_number, phone_country) and UPDATE only (phone_number,
--     phone_country). phone_verified_at, created_at and updated_at are never
--     client-writable.
--   * a BEFORE INSERT/UPDATE trigger keeps updated_at current and clears
--     phone_verified_at whenever phone_number changes.
--
-- What it does NOT do: change any existing table, row, policy or grant; copy any
-- existing phone number (user_metadata.phone and host_applications.phone are left as
-- they are); touch auth.users.phone (Supabase's own phone-login column).
--
-- Run as role `postgres`, the whole file, in one run, after 0026.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.user_contact_details') is not null then
    raise exception '0027 ABORTED: public.user_contact_details already exists';
  end if;
  if to_regprocedure('public.user_contact_details_before_write()') is not null then
    raise exception '0027 ABORTED: public.user_contact_details_before_write() already exists';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  create table public.user_contact_details (
    user_id uuid primary key references auth.users(id) on delete cascade,
    phone_number text not null,
    phone_country text not null,
    phone_verified_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- E.164: "+", no leading zero, 7-15 digits in total.
    constraint user_contact_details_phone_number_e164_check check (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
    constraint user_contact_details_phone_country_check check (phone_country ~ '^[A-Z]{2}$'),
    constraint user_contact_details_phone_number_key unique (phone_number)
  );

  create function public.user_contact_details_before_write()
  returns trigger language plpgsql set search_path = '' as $fn$
  begin
    if tg_op = 'UPDATE' and new.phone_number is distinct from old.phone_number then
      new.phone_verified_at := null;  -- a verification only ever applies to the number it was made for
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

  -- Supabase's default privileges grant everything on new tables; replace them with exactly this.
  revoke all on public.user_contact_details from public, anon, authenticated;
  grant select on public.user_contact_details to authenticated;
  grant insert (user_id, phone_number, phone_country) on public.user_contact_details to authenticated;
  grant update (phone_number, phone_country) on public.user_contact_details to authenticated;

  -- ═════════ 3. POSTCONDITIONS (any failure rolls back everything above) ═════════
  if to_regclass('public.user_contact_details') is null then
    raise exception '0027 ROLLED BACK: public.user_contact_details is missing';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'user_contact_details'
        and ((column_name = 'user_id' and data_type = 'uuid' and is_nullable = 'NO')
          or (column_name = 'phone_number' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'phone_country' and data_type = 'text' and is_nullable = 'NO')
          or (column_name = 'phone_verified_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES')
          or (column_name = 'created_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
          or (column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO'))) <> 6
     or (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'user_contact_details') <> 6 then
    raise exception '0027 ROLLED BACK: user_contact_details columns are not as intended';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.user_contact_details'::regclass and contype = 'p'
                   and conkey = array[(select attnum from pg_attribute
                                       where attrelid = 'public.user_contact_details'::regclass and attname = 'user_id')]::smallint[]) then
    raise exception '0027 ROLLED BACK: primary key on user_id is missing';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.user_contact_details'::regclass and contype = 'f'
                   and confrelid = 'auth.users'::regclass and confdeltype = 'c') then
    raise exception '0027 ROLLED BACK: foreign key to auth.users (on delete cascade) is missing';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.user_contact_details'::regclass and contype = 'u'
                   and conname = 'user_contact_details_phone_number_key') then
    raise exception '0027 ROLLED BACK: unique constraint on phone_number is missing';
  end if;
  if (select count(*) from pg_constraint
      where conrelid = 'public.user_contact_details'::regclass and contype = 'c'
        and conname in ('user_contact_details_phone_number_e164_check', 'user_contact_details_phone_country_check')) <> 2 then
    raise exception '0027 ROLLED BACK: phone_number / phone_country checks are missing';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.user_contact_details'::regclass
                   and tgname = 'user_contact_details_before_write' and not tgisinternal) then
    raise exception '0027 ROLLED BACK: trigger user_contact_details_before_write is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.user_contact_details'::regclass) then
    raise exception '0027 ROLLED BACK: RLS is not enabled on public.user_contact_details';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_contact_details') <> 3
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_contact_details'
                      and policyname = 'Users read their own contact details' and cmd = 'SELECT'
                      and roles = '{authenticated}' and qual = '(auth.uid() = user_id)')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_contact_details'
                      and policyname = 'Users add their own contact details' and cmd = 'INSERT'
                      and roles = '{authenticated}' and with_check = '(auth.uid() = user_id)')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_contact_details'
                      and policyname = 'Users update their own contact details' and cmd = 'UPDATE'
                      and roles = '{authenticated}' and qual = '(auth.uid() = user_id)'
                      and with_check = '(auth.uid() = user_id)') then
    raise exception '0027 ROLLED BACK: user_contact_details policies are not as intended';
  end if;
  if has_table_privilege('anon', 'public.user_contact_details', 'SELECT')
     or has_table_privilege('anon', 'public.user_contact_details', 'INSERT')
     or has_table_privilege('anon', 'public.user_contact_details', 'UPDATE')
     or has_table_privilege('anon', 'public.user_contact_details', 'DELETE')
     or has_column_privilege('anon', 'public.user_contact_details', 'phone_number', 'SELECT') then
    raise exception '0027 ROLLED BACK: anon has privileges on user_contact_details';
  end if;
  if not has_table_privilege('authenticated', 'public.user_contact_details', 'SELECT')
     or has_table_privilege('authenticated', 'public.user_contact_details', 'DELETE')
     or has_table_privilege('authenticated', 'public.user_contact_details', 'TRUNCATE')
     or not has_column_privilege('authenticated', 'public.user_contact_details', 'user_id', 'INSERT')
     or not has_column_privilege('authenticated', 'public.user_contact_details', 'phone_number', 'INSERT')
     or not has_column_privilege('authenticated', 'public.user_contact_details', 'phone_country', 'INSERT')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'phone_verified_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'created_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'updated_at', 'INSERT')
     or not has_column_privilege('authenticated', 'public.user_contact_details', 'phone_number', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.user_contact_details', 'phone_country', 'UPDATE')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'user_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'phone_verified_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'created_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.user_contact_details', 'updated_at', 'UPDATE') then
    raise exception '0027 ROLLED BACK: authenticated privileges on user_contact_details are not as intended';
  end if;
  if has_function_privilege('authenticated', 'public.user_contact_details_before_write()', 'EXECUTE')
     or has_function_privilege('anon', 'public.user_contact_details_before_write()', 'EXECUTE') then
    raise exception '0027 ROLLED BACK: the trigger function is executable by clients';
  end if;
  if exists (select 1 from public.user_contact_details) then
    raise exception '0027 ROLLED BACK: user_contact_details is not empty';
  end if;
end
$migration$;
