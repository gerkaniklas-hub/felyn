-- 0026: a booking request's stay becomes optional (+ host-only guest first name by request)
--
-- ONE SQL statement (a single DO block), same form as 0023-0025: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state and rolls
-- everything back if anything is not exactly as intended.
--
-- Why: guests can now request an experience straight from Explore, with or without a
-- trip. A request still belongs to a guest and holds experience line items
-- (booking_request_items, unchanged); its stay is now optional.
--
-- What it does:
--   * booking_requests.stay_id: NOT NULL dropped. Existing rows keep their stay. The
--     foreign key (on delete restrict, 0010), its index and the partial unique index
--     "one active request per stay" (0006) are unchanged; NULLs never collide in a
--     unique index, so stayless requests don't count against it.
--   * "Users manage their own booking requests": same USING clause. WITH CHECK now
--     allows a request that is the guest's own AND (has no stay OR its stay is theirs).
--     Nothing else about who can read or write requests changes.
--   * public.get_guest_first_names_for_provider_requests(request_ids uuid[]): like
--     0013's stay-based function, but keyed by request, so a host also sees the guest's
--     first name on stayless requests. SECURITY DEFINER; returns only the first name,
--     only for requests public.is_provider_for_booking_request(id, auth.uid()) says the
--     CALLER hosts (auth.uid() comes from the session, never a parameter). Executable
--     by `authenticated` only.
--
-- What it does NOT do: change any existing row, any other policy, trigger or function.
--
-- Run as role `postgres`, the whole file, in one run.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'booking_requests'
                   and column_name = 'stay_id' and is_nullable = 'NO') then
    raise exception '0026 ABORTED: booking_requests.stay_id is not the expected NOT NULL column';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_requests'
        and policyname = 'Users manage their own booking requests'
        and cmd = 'ALL' and qual = '(auth.uid() = user_id)'
        and with_check like '%auth.uid() = user_id%' and with_check like '%stays s%') <> 1 then
    raise exception '0026 ABORTED: "Users manage their own booking requests" differs from the 0005 baseline';
  end if;
  if to_regprocedure('public.is_provider_for_booking_request(uuid, uuid)') is null then
    raise exception '0026 ABORTED: public.is_provider_for_booking_request(uuid, uuid) is missing';
  end if;
  if to_regprocedure('public.get_guest_first_names_for_provider_requests(uuid[])') is not null then
    raise exception '0026 ABORTED: get_guest_first_names_for_provider_requests already exists';
  end if;
  if to_regclass('public.booking_requests_one_active_per_stay_idx') is null then
    raise exception '0026 ABORTED: booking_requests_one_active_per_stay_idx is missing';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  alter table public.booking_requests alter column stay_id drop not null;

  drop policy "Users manage their own booking requests" on public.booking_requests;
  create policy "Users manage their own booking requests" on public.booking_requests
    for all using (auth.uid() = user_id)
    with check (
      auth.uid() = user_id
      and (
        stay_id is null
        or exists (select 1 from public.stays s where s.id = stay_id and s.user_id = auth.uid())
      )
    );

  create function public.get_guest_first_names_for_provider_requests(request_ids uuid[])
  returns table(booking_request_id uuid, first_name text)
  language sql
  security definer
  set search_path = public
  stable
  as $fn$
    select br.id, nullif(trim(u.raw_user_meta_data->>'first_name'), '')
    from public.booking_requests br
    join auth.users u on u.id = br.user_id
    where br.id = any(request_ids)
      and public.is_provider_for_booking_request(br.id, auth.uid())
  $fn$;
  revoke all on function public.get_guest_first_names_for_provider_requests(uuid[]) from public, anon;
  grant execute on function public.get_guest_first_names_for_provider_requests(uuid[]) to authenticated;

  -- ═════════ 3. POSTCONDITIONS (any failure rolls back everything above) ═════════
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'booking_requests'
                   and column_name = 'stay_id' and is_nullable = 'YES') then
    raise exception '0026 ROLLED BACK: booking_requests.stay_id is not nullable';
  end if;
  if exists (select 1 from public.booking_requests where stay_id is null) then
    raise exception '0026 ROLLED BACK: an existing booking request lost its stay';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'booking_requests'
        and policyname = 'Users manage their own booking requests'
        and cmd = 'ALL' and qual = '(auth.uid() = user_id)'
        and with_check like '%stay_id IS NULL%' and with_check like '%stays s%') <> 1 then
    raise exception '0026 ROLLED BACK: the guest booking request policy is not as intended';
  end if;
  if to_regclass('public.booking_requests_one_active_per_stay_idx') is null then
    raise exception '0026 ROLLED BACK: booking_requests_one_active_per_stay_idx is missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'get_guest_first_names_for_provider_requests'
                   and p.prosecdef) then
    raise exception '0026 ROLLED BACK: get_guest_first_names_for_provider_requests is missing or not SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.get_guest_first_names_for_provider_requests(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_guest_first_names_for_provider_requests(uuid[])', 'EXECUTE') then
    raise exception '0026 ROLLED BACK: get_guest_first_names_for_provider_requests privileges are not authenticated-only';
  end if;
end
$migration$;
