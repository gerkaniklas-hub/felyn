-- 0025: nullable stays.location_id -> public.locations
--
-- ONE SQL statement (a single DO block), same form as 0023/0024: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- What it does:
--   * adds stays.location_id, a NULLABLE foreign key to public.locations (0024), so a
--     guest's stay can reference Felyn's canonical location. The simplified Add a
--     stay form writes it; stays.location_text keeps being written alongside it as
--     the readable copy the planner and existing screens still use.
--   * adds an index on it.
--
-- What it does NOT do: change any existing row (every existing stay keeps NULL), touch
-- any policy or grant (the existing owner policy "Users manage their own stays" and the
-- providers' read policy already cover every column), or change experiences.
--
-- Run as role `postgres`, the whole file, in one run, after 0024.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  v_policies_before text;
  v_policies_after text;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.stays') is null then
    raise exception '0025 ABORTED: public.stays does not exist';
  end if;
  if to_regclass('public.locations') is null then
    raise exception '0025 ABORTED: public.locations does not exist (apply 0024 first)';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'stays' and column_name = 'location_id') then
    raise exception '0025 ABORTED: public.stays.location_id already exists';
  end if;
  -- Snapshot of the stays policies, compared again in section 3 to prove they are untouched.
  select string_agg(policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ';' order by policyname)
    into v_policies_before
    from pg_policies where schemaname = 'public' and tablename = 'stays';

  -- ═════════ 2. MIGRATION ═════════
  -- Nullable, no default: a metadata-only change, no table rewrite, every existing row is NULL.
  -- on delete restrict: a canonical location that a stay still references can't be deleted.
  alter table public.stays
    add column location_id uuid references public.locations(id) on delete restrict;
  create index stays_location_id_idx on public.stays(location_id);

  -- ═════════ 3. POSTCONDITIONS (any failure rolls back everything above) ═════════
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'stays'
                   and column_name = 'location_id' and is_nullable = 'YES' and data_type = 'uuid') then
    raise exception '0025 ROLLED BACK: stays.location_id is missing or not a nullable uuid';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.stays'::regclass and contype = 'f'
                   and confrelid = 'public.locations'::regclass
                   and conkey = array[(select attnum from pg_attribute
                                       where attrelid = 'public.stays'::regclass and attname = 'location_id')]::smallint[]
                   and confdeltype = 'r') then
    raise exception '0025 ROLLED BACK: stays.location_id foreign key to public.locations (on delete restrict) is missing';
  end if;
  if to_regclass('public.stays_location_id_idx') is null then
    raise exception '0025 ROLLED BACK: index stays_location_id_idx is missing';
  end if;
  if exists (select 1 from public.stays where location_id is not null) then
    raise exception '0025 ROLLED BACK: an existing stay has a location_id';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.stays'::regclass) then
    raise exception '0025 ROLLED BACK: RLS is not enabled on public.stays';
  end if;
  select string_agg(policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ';' order by policyname)
    into v_policies_after
    from pg_policies where schemaname = 'public' and tablename = 'stays';
  if v_policies_after is distinct from v_policies_before then
    raise exception '0025 ROLLED BACK: stays policies changed';
  end if;
end
$migration$;
