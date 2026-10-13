-- 0038: Stripe Accounts v2 — sync a host's payout account from its current state
--
-- ONE SQL statement (a single DO block), same form as 0023-0037: it either completes
-- fully and commits, or raises an error and rolls back fully. Section 1 refuses to
-- run on an unexpected starting state; section 3 verifies the end state.
--
-- RELEASE NOTE: apply after 0037, together with the app version that calls it. TEST
-- MODE ONLY, like 0037 (nothing here changes felyn_private.stripe_settings).
--
-- Why: hosts' connected accounts are created with Stripe's Accounts v2 API. For those
-- accounts Stripe sends Accounts v2 "thin" events (v2.core.account[...]), not the
-- legacy account.updated that 0037's stripe_apply_event handles, so a host who finished
-- Stripe's onboarding stayed "In progress": host_payout_accounts was never synced.
--
-- What it adds (nothing existing is redefined; 0036's table, readiness formula and
-- update guard, and 0037's functions, are used as they are):
--
--   * public.stripe_sync_host_account(account_id, fetched_at, details_submitted,
--     payouts_enabled, transfers_capability, currently_due, past_due, disabled_reason)
--     — service_role only. Records the account state the server has just READ FROM
--     STRIPE'S API (GET /v2/core/accounts/{id}), mapped onto 0036's existing columns by
--     the app (src/lib/payments/account-sync.ts). The server calls it after a verified
--     Accounts v2 event (/api/stripe/account-events) or when the host comes back to
--     /provider/payouts. 0036's generated payouts_ready decides readiness, unchanged.
--     Answers 'synced', 'stale' (an older reading than the one already recorded: never
--     applied, 0036's guard forbids a sync moving backwards) or 'unknown_account'.
--
-- TRUST CHANGE (reviewed): until now only a Stripe-signed account.updated could change
-- a host's payout state (0037). Accounts v2 thin events carry no account state at all —
-- Stripe's documented way is to fetch the account — so this function takes the state
-- from the server, which holds the Stripe key. Consequence: whoever holds the
-- service_role key can now mark a known host's account ready. Limits: only an account
-- already registered (stripe_register_host_account), only well-formed values, never
-- backwards in time; and readiness lets guests pay into Felyn's own Stripe balance —
-- no transfer or payout exists anywhere in this build.
--
-- Run as role `postgres` (the owner of public.host_payout_accounts), the whole file, in
-- one run, after 0037.
-- Expected result: "Success. No rows returned". Any ERROR means nothing was applied.

do $migration$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ═════════ 1. PRECONDITIONS ═════════
  if to_regclass('public.host_payout_accounts') is null
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.host_payout_accounts'::regclass)
        is distinct from (select ro.oid from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '0038 ABORTED: run this as the owner of public.host_payout_accounts (postgres), after 0036';
  end if;
  if to_regprocedure('public.stripe_apply_event(text, text, text)') is null
     or to_regprocedure('public.stripe_register_host_account(uuid, text)') is null
     or to_regprocedure('public.host_payout_account_status()') is null
     or to_regclass('felyn_private.stripe_settings') is null then
    raise exception '0038 ABORTED: 0037 (Stripe test mode) is not applied';
  end if;
  if (select s.livemode from felyn_private.stripe_settings s where s.id) is distinct from false then
    raise exception '0038 ABORTED: the database is not pinned to Stripe test mode';
  end if;
  if to_regprocedure('public.stripe_sync_host_account(text, timestamp with time zone, boolean, boolean, text, text[], text[], text)') is not null then
    raise exception '0038 ABORTED: public.stripe_sync_host_account already exists';
  end if;

  -- ═════════ 2. MIGRATION ═════════
  create function public.stripe_sync_host_account(
    p_account_id text,
    p_fetched_at timestamptz,
    p_details_submitted boolean,
    p_payouts_enabled boolean,
    p_transfers_capability text,
    p_requirements_currently_due text[],
    p_requirements_past_due text[],
    p_disabled_reason text
  )
  returns text language plpgsql security definer set search_path = '' as $fn$
  declare
    v_acct record;
  begin
    if p_account_id is null or p_account_id !~ '^acct_[A-Za-z0-9]{1,250}$' then
      raise exception 'Not a Stripe account id' using errcode = '22023';
    end if;
    -- The server's read time; a clock far off from the database's is refused.
    if p_fetched_at is null or p_fetched_at > now() + interval '5 minutes' or p_fetched_at < now() - interval '1 hour' then
      raise exception 'Invalid fetch time' using errcode = '22023';
    end if;
    if p_details_submitted is null or p_payouts_enabled is null
       or p_transfers_capability is null or p_transfers_capability not in ('active', 'inactive', 'pending', 'unrequested') then
      raise exception 'Invalid account state' using errcode = '22023';
    end if;
    if p_requirements_currently_due is null or p_requirements_past_due is null
       or cardinality(p_requirements_currently_due) > 200 or cardinality(p_requirements_past_due) > 200
       or exists (select 1 from unnest(p_requirements_currently_due || p_requirements_past_due) x(v)
                   where x.v is null or char_length(x.v) not between 1 and 200) then
      raise exception 'Invalid requirements' using errcode = '22023';
    end if;
    if p_disabled_reason is not null and char_length(p_disabled_reason) not between 1 and 200 then
      raise exception 'Invalid disabled reason' using errcode = '22023';
    end if;

    select * into v_acct from public.host_payout_accounts h where h.stripe_account_id = p_account_id for update;
    if v_acct.provider_id is null then
      return 'unknown_account';
    end if;
    -- A slower, older reading never overwrites a newer one (0036's guard would refuse it).
    if v_acct.stripe_synced_at is not null and v_acct.stripe_synced_at > p_fetched_at then
      return 'stale';
    end if;

    update public.host_payout_accounts h
       set details_submitted = p_details_submitted,
           payouts_enabled = p_payouts_enabled,
           transfers_capability = p_transfers_capability,
           requirements_currently_due = p_requirements_currently_due,
           requirements_past_due = p_requirements_past_due,
           disabled_reason = p_disabled_reason,
           stripe_synced_at = p_fetched_at
     where h.provider_id = v_acct.provider_id;
    return 'synced';
  end $fn$;

  -- ── privileges ──
  revoke execute on function public.stripe_sync_host_account(text, timestamptz, boolean, boolean, text, text[], text[], text)
    from public, anon, authenticated, service_role;
  grant execute on function public.stripe_sync_host_account(text, timestamptz, boolean, boolean, text, text[], text[], text)
    to service_role;

  -- ═════════ 3. POSTCONDITIONS ═════════
  for r in select unnest(array['anon', 'authenticated', 'service_role']) as rl loop
    if has_function_privilege(r.rl, 'public.stripe_sync_host_account(text, timestamptz, boolean, boolean, text, text[], text[], text)', 'EXECUTE')
       <> (r.rl = 'service_role') then
      raise exception '0038 VERIFY FAILED: EXECUTE on stripe_sync_host_account for % is not as intended', r.rl;
    end if;
  end loop;
  if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
            from pg_proc p
           where p.oid = 'public.stripe_sync_host_account(text, timestamptz, boolean, boolean, text, text[], text[], text)'::regprocedure) then
    raise exception '0038 VERIFY FAILED: stripe_sync_host_account is not SECURITY DEFINER with an empty search_path';
  end if;
  -- 0036's table still has no client or service_role access: the function is the only way in.
  for r in select unnest(array['anon', 'authenticated', 'service_role']) as rl loop
    if has_table_privilege(r.rl, 'public.host_payout_accounts', 'SELECT') or has_table_privilege(r.rl, 'public.host_payout_accounts', 'UPDATE')
       or has_table_privilege(r.rl, 'public.host_payout_accounts', 'INSERT') or has_table_privilege(r.rl, 'public.host_payout_accounts', 'DELETE') then
      raise exception '0038 VERIFY FAILED: % has a privilege on public.host_payout_accounts', r.rl;
    end if;
  end loop;
  if (select s.livemode from felyn_private.stripe_settings s where s.id) is distinct from false then
    raise exception '0038 VERIFY FAILED: the database is not pinned to Stripe test mode';
  end if;
end
$migration$;
