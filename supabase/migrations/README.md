# Migration history — known gap

This directory is **not currently a fully reproducible clean-install history**.
A fresh Supabase project cannot be created from these files alone. Read this
before assuming `0001` → latest can be replayed end-to-end.

## Migration 0018: cancellation columns — RECOVERED, ALREADY APPLIED, DO NOT RE-RUN

- `0018_experience_cancellation_columns.sql` **was applied to production on
  2026-09-27** (Supabase SQL Editor). **Do not run it against production
  again.** A re-run would abort by itself anyway: its safety check expects
  the pre-0018 four-value status constraint, and production now has five
  values.
- **Recovered from the session transcript (2026-09-29).** The file was
  never saved to disk or committed; the SQL was reviewed in a Claude Code
  session and pasted into the SQL Editor from there. It has been restored
  byte-for-byte from that session's final reviewed version — the one shown
  immediately before it was applied (SHA-256 `7c5c20ad79e73a53…`). Its SQL
  body has not been edited or reconstructed.
- What it does, all on `public.booking_request_items`, inside
  `begin; … commit;`, with no row updated:
  - adds nullable `timestamptz` columns `decided_at` and `cancelled_at`, and
    nullable `text` column `cancelled_by`;
  - adds `booking_request_items_cancelled_by_check` — `cancelled_by` is NULL,
    `'guest'`, or `'provider'`;
  - adds `booking_request_items_cancelled_pair_check` — `cancelled_at` and
    `cancelled_by` are both NULL or both non-NULL;
  - verifies the existing `booking_request_items_status_check` references
    exactly `REQUESTED`, `CONFIRMED`, `DECLINED`, `WITHDRAWN` (aborting
    otherwise), then recreates it allowing those four plus `CANCELLED`.
- **Verified against production (read-only, 2026-09-29):** the three
  columns (nullable, with the types above), both cancellation constraints,
  and the five-value status constraint all exist as described.
- History of the gap: until 2026-09-29 this file was missing and believed
  unrecoverable. The earlier description here was reconstructed from 0019's
  preflight checks and omitted `booking_request_items_cancelled_by_check`
  (which no later migration references) and listed `decided_at` as
  unconfirmed. Both are corrected above.

## How later migrations relate to 0018

- **`0019` onward** contain explicit preflight checks (`do $$ ... raise
  exception ...`) that verify the schema 0018 left behind actually exists
  before making any change — e.g. 0019 aborts if `cancelled_at` or the
  `booking_request_items_cancelled_pair_check` constraint isn't present.
  (Before 0018 was recovered, these checks were the only evidence of what it
  contained.)
- **`0021`** additionally notes that `decided_at` was understood to have been
  added by 0018 as well. This is now confirmed by both the recovered 0018
  file and the production check of 2026-09-29.

## What has been verified against the live database

- The `cancelled_at` and `decided_at` columns exist on `booking_request_items`.
- Both messaging `INSERT` policies from `0021`
  (`"Guests send messages on their own active items"` and
  `"Providers send messages on their own active items"`) exist, confirmed
  through Supabase's policy metadata (i.e. policies with those exact names
  are present on `public.messages`). This confirms **existence only** — it
  does not independently verify that their full `USING`/`WITH CHECK`
  definitions match 0021's text (e.g. the 30-day window logic) exactly.

This confirms the *current* database has the expected columns and policy
names in place — it does not restore the missing file or its exact original
text, and does not by itself prove every policy's internal logic matches
what's written in these migration files.

## Bottom line

- Treat this directory as an **incremental record of changes applied to an
  already-existing database**, not a from-scratch schema definition.
- **Do not** attempt to provision a new Supabase project by running these
  migrations in order. The 0018 file has been recovered (see above), but
  replaying `0001` → latest on a fresh project has never been tested and is
  not known to reproduce the current live database.
- Anyone provisioning a new environment from this repo needs a proper
  baseline/reconciliation migration (or a full schema dump) first. None
  exists yet as of this writing.

## Migration 0023: host applications — ALREADY APPLIED, DO NOT RE-RUN

- `0023_host_applications.sql` **was applied to production on 2026-09-29**
  (Supabase SQL Editor, role `postgres`). **Do not run it against production
  again.** Its own starting checks would abort a re-run (it refuses if
  `host_applications` or `felyn_admin` already exists), but it must not be
  executed as part of any deployment.
- It creates `public.host_applications` (RLS; applicants may insert their own
  application and edit only `display_name` while `submitted`), replaces the
  `providers` "manage own profile" policy with read-only access and revokes
  client INSERT/UPDATE/DELETE on `providers`, and adds
  `felyn_admin.approve_host_application` / `felyn_admin.reject_host_application`
  (SECURITY DEFINER, `search_path = ''`, not executable by anon,
  authenticated or service_role; the `felyn_admin` schema is not exposed to
  the API). Host approval/rejection is a manual SQL Editor operation.
- The file is committed byte-for-byte as reviewed and applied. It is a single
  `DO` statement (no BEGIN/COMMIT) that either applies fully and commits, or
  rolls back fully.
- Companion files (neither is a migration; never run during deployment):
  - `host_applications_isolated_test.sql` — the fail-closed rehearsal that
    passed in production before 0023 was applied. It re-creates 0023's
    objects inside one statement that always ends in an error, so it rolls
    back by design. It would fail now that 0023 exists, and should not be
    re-run.
  - `host_applications_rollback_DESTRUCTIVE.sql` — **destructive** undo that
    restores the pre-0023 `providers` policy/grants and **drops
    `host_applications` with every application in it**. Only for a
    deliberate, reviewed rollback, after exporting the table.

## Migration 0025: stay location — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0025_stay_location_id.sql` **has been applied to production** (confirmed
  by the project owner; exact date not recorded here). **Do not run it
  against production again.** Its own starting checks would abort a re-run
  (it refuses if `stays.location_id` already exists), but it must not be
  executed as part of any deployment.
- It adds `public.stays.location_id`, a nullable `uuid` foreign key to
  `public.locations` (0024) with `on delete restrict`, and the index
  `stays_location_id_idx`. No existing row is changed (every pre-0025 stay
  keeps `location_id` NULL) and no policy or grant is touched. The Add a stay
  form writes `location_id` together with `location_text`.
- The file is committed as applied (SHA-256 `0a4be608682f9da4…`). It is a
  single `DO` statement (no BEGIN/COMMIT) that either applies fully and
  commits, or rolls back fully.

## Migration 0026: optional stay on booking requests — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0026_optional_stay_on_booking_requests.sql` **has been applied to
  production**. **Do not run it against production again.** Its own starting
  checks would abort a re-run (it refuses unless `booking_requests.stay_id`
  is still NOT NULL, and if
  `get_guest_first_names_for_provider_requests` already exists), but it must
  not be executed as part of any deployment.
- **Verified against production (read-only, 2026-10-04):**
  `booking_requests.stay_id` is nullable and
  `public.get_guest_first_names_for_provider_requests(uuid[])` exists.
- What it does: drops NOT NULL on `public.booking_requests.stay_id` (existing
  rows keep their stay); recreates the guest policy "Users manage their own
  booking requests" with the same `USING` clause and a `WITH CHECK` that
  allows a request with no stay or with the guest's own stay; adds
  `public.get_guest_first_names_for_provider_requests(request_ids uuid[])`
  (SECURITY DEFINER, `search_path = public`, returns only the guest's first
  name for requests the caller hosts, executable by `authenticated` only).
  No existing row, other policy, trigger or function is changed.
- The file is committed as applied (SHA-256 `c8d88f3a7fc0579a…`). It is a
  single `DO` statement (no BEGIN/COMMIT) that either applies fully and
  commits, or rolls back fully.
