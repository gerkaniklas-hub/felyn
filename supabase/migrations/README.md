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

## Migration 0027: user contact details — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0027_user_contact_details.sql` **has been applied to production** (confirmed
  by the project owner; exact date not recorded here). **Do not run it
  against production again**, and do not edit or remove the file. Its own
  starting checks would abort a re-run (it refuses if
  `public.user_contact_details` or `public.user_contact_details_before_write()`
  already exists), but it must not be executed as part of any deployment.
- It creates `public.user_contact_details`: one row per account (`user_id`
  primary key, references `auth.users`, on delete cascade) holding the
  account's canonical phone number in E.164 (`phone_number`, unique, format
  checked) and the ISO country the user picked (`phone_country`, two
  capital letters). `phone_verified_at` is reserved for future SMS
  verification: nothing sets it yet, clients can never write it, and a
  trigger clears it whenever `phone_number` changes (the same trigger keeps
  `updated_at` current). RLS: a signed-in user can read, add and update only
  their own row; no delete; anon has no access. `authenticated` may insert
  only `user_id`, `phone_number`, `phone_country` and update only
  `phone_number`, `phone_country`. No existing row, table, policy or grant is
  changed, no existing phone number is copied, and `auth.users.phone` is not
  used. One record per account, shared by the guest and host journeys.
- SHA-256 of the file as committed in this repository:
  `66a55e5f2fec5052…`. This is a fingerprint of the repository file only;
  it has not been verified byte-for-byte against the SQL that was pasted
  into Supabase. It is a single `DO` statement (no BEGIN/COMMIT) that either
  applies fully and commits, or rolls back fully.
- Companion file (not a migration; never run during deployment):
  - `user_contact_details_isolated_test.sql` — the fail-closed rehearsal that
    passed before 0027 was applied. It re-creates 0027's objects inside one
    statement that always ends in an error, so it rolls back by design. It
    would fail now that 0027 exists, and should not be re-run.

## Migration 0028: email outbox — NOT YET APPLIED ANYWHERE

- `0028_email_outbox.sql` is **written but not applied** (neither to
  production nor anywhere else). Do not apply it until the project owner
  approves. Same form as 0023-0027: a single `DO` statement that applies
  fully or rolls back fully, with preconditions and postconditions.
- It creates `public.email_outbox` (one row per transactional email event
  and recipient; unique `event_key`; `pending` / `sending` / `sent` /
  `failed` / `skipped`; attempts, retry time, claim lease, errors), two
  `SECURITY DEFINER` trigger functions on `public.booking_request_items`
  that record events in the same transaction as the booking change (one
  per-statement trigger for new requests, grouped per guest and per host;
  one per-row trigger for confirm / decline / cancel — a cancellation
  emails the other party and sends the canceller a receipt; withdrawals
  create no email), two internal
  helpers, and `public.claim_email_outbox(integer)` (FOR UPDATE SKIP
  LOCKED; executable by `service_role` only). RLS is enabled with no
  policies; `anon` and `authenticated` have no privileges; `service_role`
  has SELECT and UPDATE only. The 0009/0014/0020 notification triggers are
  not changed. Email addresses are never stored; the app's server-only
  sender (`src/lib/email/dispatcher.ts`) resolves them at send time.
- Companion file (not a migration; never run during deployment):
  `email_outbox_isolated_test.sql` — the fail-closed rehearsal, to be run
  **before** 0028. It embeds 0028's section 2 verbatim, checks grouping,
  event keys and duplicates, transitions, payload privacy, the missing
  provider account case, claim semantics, role privileges and that a
  failing email trigger never blocks a booking, and always ends in an
  error so everything is rolled back.
- SHA-256 (repository files, as written; updated 2026-10-05 when the
  host cancellation receipt was added): 0028 `f8176a131f20d9d9…`,
  isolated test `f841799f9ca32680…`.

### Retry sweep scheduler — SCRIPT WRITTEN, NOT ENABLED

**The scheduler is not running until someone configures it by hand** (steps
below). Until then, emails are still delivered right after each booking
action, but a failed attempt is only retried when a later booking action
happens.

How delivery works:

```
booking change ──(same transaction, 0028 trigger)──> email_outbox row
   ├─ immediately: the Server Action's after() ──┐
   └─ every 5 min: pg_cron -> pg_net ────────────┴─> POST https://app.felyn.eu/api/email/sweep
                                                       -> claim_email_outbox (SKIP LOCKED)
                                                       -> re-check booking state -> Resend
```

- Script: `email_outbox_sweep_schedule.sql` (companion file — **not** a
  numbered migration, never run during deployment, **production only**). It
  schedules the pg_cron job `email-outbox-sweep` at `*/5 * * * *`, which
  calls the sweep route with `net.http_post(..., timeout_milliseconds :=
  60000)` (pg_net's own default is only 2 s). It is re-runnable: it first
  removes any job with the same name, then schedules it again. It checks
  that 0028, pg_cron, pg_net and the Vault secret exist (and changes nothing
  if one is missing), and afterwards that exactly one active job exists, that
  its role can read the Vault secret, and that the secret is not in the stored
  command.
- **It contains no secret.** The job's command reads the bearer secret from
  Supabase Vault (`vault.decrypted_secrets`) every time it runs.
- Required Vault secret (one): `email_sweep_secret` — exactly the same value
  as the Vercel Production variable `EMAIL_SWEEP_SECRET`. 32-256 characters
  of `A-Z a-z 0-9 _ -`, e.g. 64 random hex characters, no spaces or line
  breaks. The URL is not secret and is written in the script.
- Overlapping or repeated sweeps are harmless: rows are claimed with
  `FOR UPDATE SKIP LOCKED`, a crashed run's rows are reclaimed after a
  10-minute lease, and every attempt for a row reuses the same Resend
  idempotency key. While `EMAIL_DELIVERY_MODE` is off the route just answers
  `{"mode":"off"}`.

**Expiry and the idempotency window.** Resend keeps an idempotency key for
24 hours, so every attempt for one email must happen inside that window. The
app therefore never delivers an outbox row older than **23 hours** (it is
marked `skipped` / `expired`; `MAX_EVENT_AGE_MS` in
`src/lib/email/events.ts`). The full retry schedule (1 min, 5 min, 15 min,
1 h, 3 h; 6 attempts) finishes in under 5 hours, well inside it.

Setting it up (once 0028 is applied and the app is deployed and working):

1. Generate the secret **on your own computer** (e.g. `openssl rand -hex 32`).
   Do not paste it into chats, tickets or files.
2. Vercel -> Project -> Settings -> Environment Variables (Production):
   set `EMAIL_SWEEP_SECRET` to it, then redeploy.
3. Supabase Dashboard -> Database -> Extensions: enable `pg_net`.
4. Supabase Dashboard -> **Vault** (Project Settings / Integrations -> Vault):
   add a secret named `email_sweep_secret` with the same value. **Use the
   Vault UI — never `select vault.create_secret('…')` in the SQL editor**,
   which would keep the secret in the editor's query history.
5. SQL editor, as `postgres`: run `email_outbox_sweep_schedule.sql`.
   Expected: "Success. No rows returned".
6. After the next 5-minute boundary, run the read-only checks at the end of
   the script: `cron.job_run_details` should show `succeeded` and
   `net._http_response` status 200. A 401 means the two secret values
   differ; a 404 means `EMAIL_SWEEP_SECRET` is missing in Vercel.

Rotating the secret: generate a new value, update Vercel and redeploy,
then edit `email_sweep_secret` in the Vault UI to the same value. The job
reads Vault on every run, so it does not need to be rescheduled. Sweeps in
between the two updates get 401 and are simply retried 5 minutes later.

Stopping it: `select jobid from cron.job where jobname = 'email-outbox-sweep';`
then `select cron.unschedule(<jobid>);`.

Vercel Hobby cron jobs run at most once a day, so they are not used for retries.

## Migration 0029: support — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0029_support.sql` **has been applied to production** (2026-10-05, by the
  project owner, who confirmed afterwards that the support tables and
  functions exist and that `messages`, `support_messages` and
  `support_threads` are in `supabase_realtime`). **Do not run it against
  production again.** Its own starting checks would abort a re-run (it
  refuses if any support table or function already exists), but it must not
  be executed as part of any deployment. Same form as 0023-0028: a single
  `DO` statement that applies fully or rolls back fully, with preconditions
  and postconditions. It does not depend on 0028.
- It creates the Felyn support foundation, fully separate from the
  guest<->host `public.messages` table (whose table, policies, grants,
  notification trigger and realtime setup are not touched — a booking-linked
  support conversation must never be visible to the host):
  - `public.staff_members` (`user_id`, `role` `support`|`admin`) — RLS on, no
    policies, no client privileges. Staff are added by hand (below).
  - `public.is_felyn_staff()` — the database-side staff check.
  - `public.support_threads` — one ticket; optional reference to the
    existing `booking_request_items.id` (booking data is never copied);
    `requester_role` `guest`|`host`; `OPEN` / `RESOLVED` / `CLOSED` with
    `resolved_at` / `closed_at` kept consistent by check constraints. Partial
    unique indexes allow at most one non-CLOSED general thread per
    (user, role) and one non-CLOSED thread per (user, role, booking).
  - `public.support_messages` — `sender_type` `user`|`staff`,
    `sender_user_id` for audit, body 1-2000 characters.
  - `public.notifications.support_thread_id` (nullable, on delete set null)
    and a trigger adding a `support_reply` notification when staff reply.
    No email.
  - `support_messages` (new messages) and `support_threads` (live status
    changes) added to the `supabase_realtime` publication.
  - Clients may only SELECT (own threads/messages; staff: all). Every write
    goes through `SECURITY DEFINER` functions that check `auth.uid()`
    themselves: `support_open_thread`, `support_send_message`,
    `support_mark_read`, `support_staff_reply`, `support_staff_set_status`,
    `support_staff_thread_context`, and `support_staff_list_threads` (the
    admin ticket list: one status, newest activity first, keyset-paged, with
    customer name/email, experience, latest message and unread count).
- Companion file (not a migration; never run during deployment):
  `support_isolated_test.sql` — the fail-closed rehearsal for running
  **before** 0029. It embeds 0029's section 2 verbatim
  (`tests/support-migration.test.ts` fails if the two drift), runs its
  checks as the `authenticated` role with real user claims so row-level
  security is genuinely enforced, and always ends in an error so everything
  is rolled back. It would fail now that 0029 exists, and should not be
  re-run against production.
- SHA-256 of the files as committed in this repository: 0029
  `16eaf8345b72df50…`, isolated test `f841799f9ca32680…`. These fingerprint
  the repository files only; they have not been verified byte-for-byte
  against the SQL that was pasted into Supabase.

### Staff accounts

One dedicated staff account is registered in production with role
`support` (added 2026-10-05). Staff sign in through the normal login and
land on `/admin/support`. To add another (the Auth user must already exist,
created in Dashboard → Authentication → Users with Auto Confirm), run as
`postgres` in the SQL Editor, replacing the placeholder with that account's
sign-in email:

```sql
insert into public.staff_members (user_id, role)
select id, 'support' from auth.users where email = '<staff account email>'
on conflict (user_id) do update set role = 'support'
returning user_id, role;
```

Exactly one row should be returned. Removing staff access:
`delete from public.staff_members where user_id = '<user id>';` — it takes
effect on the next request, no sign-out needed.

## Migration 0031: booking write hardening — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0031_booking_write_hardening.sql` **was applied to production on
  2026-10-08** (by the project owner). **Do not run it against production
  again.** Its own starting checks would abort a re-run (it refuses unless the
  booking policies are exactly the pre-0031 ones), but it must not be executed
  as part of any deployment. Same form as 0023-0030: a single
  `DO` statement that applies fully or rolls back fully, with preconditions
  (it aborts unless the booking policies are exactly 0005/0007/0009/0026's)
  and postconditions.
- It makes the database the only authority over booking rows before payments:
  - `booking_requests` / `booking_request_items`: no client UPDATE at all; no
    client DELETE of items; INSERT limited to the request columns
    (`user_id, stay_id` and `booking_request_id, experience_id, planned_date,
    planned_moment, guest_count, preferred_time, host_note`); anon has nothing.
    The guest FOR ALL policies become SELECT + INSERT (same ownership rules);
    guests may DELETE only their own requests with no REQUESTED, CONFIRMED or
    DECLINED item. The host UPDATE policy is dropped.
  - Every status change runs in a `SECURITY DEFINER` function that checks
    `auth.uid()` and the current state: `booking_item_confirm`,
    `booking_item_decline`, `booking_item_cancel_as_host` (host),
    `booking_item_withdraw`, `booking_item_cancel_as_guest`,
    `booking_request_withdraw` (guest; withdraws the request's REQUESTED items
    in the same transaction).
  - Guard triggers (apply to every role, postgres included): new rows start
    REQUESTED with no decision/cancellation/completion; `price_per_person` is
    always copied from the experience; the experience must be published and
    `guest_count` within its group size; booking details never change; only
    the existing transitions are allowed; `estimated_total` is maintained from
    the items.
  - Data, once: REQUESTED items under an already withdrawn request become
    WITHDRAWN, and every `estimated_total` is recomputed (the run prints both
    counts as NOTICEs). No notification or email results.
- **The app change that calls these functions must be deployed with it.** An
  app version from before 0031 writes these tables directly, so its booking
  actions fail against the hardened database.
- Companion file (not a migration; never run during deployment):
  `booking_write_hardening_isolated_test.sql` — the fail-closed rehearsal, to
  be run **before** 0031. It embeds 0031's section 2 verbatim
  (`tests/booking-write-hardening.test.ts` fails if the two drift), runs its
  checks as `anon` / `authenticated` with real user claims, needs four
  accounts in `auth.users`, and always ends in an error so everything is
  rolled back. It would fail now that 0031 exists, and should not be re-run.
- SHA-256 of the files as written: 0031 `af2ceb95003683b1…`, isolated test
  `3a844f53ab7b8839…`.

## Migration 0032: requested start rules — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0032_requested_start_rules.sql` **was applied to production on
  2026-10-08** (by the project owner, after its isolated test passed there;
  verified afterwards: the rule function exists, the insert trigger calls it,
  no client role can call it, Canary/DST conversion is correct, and a missing
  `preferred_time` is refused). **Do not run it against production again.**
  Its own starting checks would abort a re-run (it refuses unless the insert
  guard is still 0031's version), but it must not be executed as part of any
  deployment. Same form as 0023-0031: a single `DO`
  statement that applies fully or rolls back fully, with preconditions (it
  aborts unless 0031's insert guard is in place and the database knows the
  `Atlantic/Canary` time zone) and postconditions (including a DST sanity
  check of two known Canary instants).
- It makes a NEW booking item's requested start (`preferred_time`) reliable:
  - `public.booking_request_start_error(experience, date, moment, time, now)`
    returns NULL or the reason a start is refused: the time is required; it
    must be inside the moment (morning 07-12, afternoon 12-17, evening
    17-22 — the app's `MOMENT_RANGES`); the whole experience
    (`experiences.duration_minutes`) must end by the end of the moment; an
    availability window must cover the date (and its hours, if set, touch the
    moment); and the start, read as Tenerife local time
    (`(planned_date + preferred_time) at time zone 'Atlantic/Canary'`,
    DST-correct), must be at least 4 hours after `now`. Not callable by any
    client role.
  - 0031's `booking_request_items_before_insert()` is replaced by the same
    function plus that check (with `now()`), raising SQLSTATE 22023. Every
    0031 check is kept verbatim.
  - Inserts only: existing rows (including historical ones with no
    `preferred_time`) are not touched or re-validated, and the 0031 status
    transitions keep working on them.
- Deploy with the app change that requires a start time in both request
  paths (an older app still lets guests send "no preference", which 0032
  refuses with a generic error).
- Companion file (not a migration; never run during deployment):
  `requested_start_rules_isolated_test.sql` — the fail-closed rehearsal, to
  be run **after 0031 and before 0032**. It embeds 0032's section 2 verbatim
  (`tests/requested-start-rules.test.ts` fails if the two drift), checks the
  rule with fixed "now" instants (exact 4-hour boundaries in summer and
  winter, both DST switch days, the past, moments, durations, availability),
  then the real trigger as a signed-in guest and a legacy row without a time,
  needs two accounts in `auth.users`, and always ends in an error so
  everything is rolled back. It would fail now that 0032 exists, and should
  not be re-run.
- SHA-256 of the files as written: 0032 `ee96be5499cb03fb…`, isolated test
  `7f7937ff7fbda998…`.

## Migration 0033: accepted start snapshot — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0033_accepted_start_snapshot.sql` **was applied to production on
  2026-10-08** (by the project owner, in the SQL Editor): its isolated test
  passed there first ("FELYN TEST PASSED"), then the migration itself
  succeeded. Production data is test data, so no legacy-data remediation was
  needed. **Do not run it against production again.** Its own starting checks
  would abort a re-run (it refuses if a snapshot column already exists), but it
  must not be executed as part of any deployment. Same form as 0023-0032: a
  single `DO` statement that applies fully
  or rolls back fully, with preconditions (it aborts unless 0031's
  `booking_item_confirm` and update guard and 0032's start rule are in place,
  and the database knows `Atlantic/Canary`) and postconditions (columns,
  constraints, no client privileges on the new columns, both functions
  replaced, no existing row touched, a DST sanity check).
- It records what a host accepts, for later phases (payment deadline,
  overlap protection), on `public.booking_request_items`:
  - three nullable columns, written only on REQUESTED -> CONFIRMED:
    `accepted_at` (database clock), `confirmed_start_at`
    (`(planned_date + preferred_time) at time zone 'Atlantic/Canary'`, a real
    instant, DST-correct) and `duration_minutes` (the experience's duration at
    acceptance; later edits to the experience don't change it);
  - check constraints: all three set or all NULL; duration > 0; only on a
    CONFIRMED or CANCELLED item (a new REQUESTED item can never carry them);
  - 0031's update guard is replaced by the same function plus one rule: on
    acceptance the three fields must be set (start = the requested Tenerife
    start, positive duration); otherwise they can never change — for every
    role, postgres included;
  - 0031's `booking_item_confirm(item)` keeps its signature, grants and
    authorization, locks the item, refuses with SQLSTATE 22023 (nothing
    changed) an item without `preferred_time` or an experience without a
    valid duration, and sets the status and the snapshot in one update.
  - No grant, policy or other function changes; clients still cannot write
    the columns (no column privilege).
- Legacy: existing rows keep NULL (no backfill, no status change). Legacy
  REQUESTED items without `preferred_time` can no longer be accepted (the host
  is told to ask for a new request). Legacy CONFIRMED rows keep working and
  display from `planned_date`/`preferred_time`.
- Acceptance has no time limit: a request can still be accepted less than 2
  hours before its start (or after it). The real `accepted_at` and
  `confirmed_start_at` are recorded; the payment-window rule is decided later.
- Deploy with the app change that reads `confirmed_start_at` (an older app
  keeps working against 0033; it just doesn't show the snapshot).
- Companion file (not a migration; never run during deployment):
  `accepted_start_snapshot_isolated_test.sql` — the fail-closed rehearsal, to
  be run **after 0032 and before 0033**. It embeds 0033's section 2 verbatim
  (`tests/accepted-start-snapshot.test.ts` fails if the two drift), needs
  three accounts in `auth.users`, and always ends in an error so everything is
  rolled back. It would fail now that 0033 exists, and should not be re-run.
- SHA-256 of the files as written: 0033 `e02efc676c06906f…`, isolated test
  `82889fc148ec1065…`.

## Migration 0034: host booking overlap — ALREADY APPLIED TO PRODUCTION — DO NOT RE-RUN

- `0034_host_booking_overlap.sql` **was applied to production on
  2026-10-08** (by the project owner, in the SQL Editor): its isolated test
  passed there first ("FELYN TEST PASSED"), then the migration itself
  succeeded. The concurrent-acceptance behaviour was verified separately with
  real concurrent PostgreSQL connections (see "Concurrency" below). **Do not
  run it against production again.** Its own starting checks would abort a
  re-run (it refuses unless `booking_item_confirm` is still 0033's version),
  but it must not be executed as part of any deployment. Same form as
  0023-0033: a single `DO` statement that applies fully
  or rolls back fully, with preconditions (0033's snapshot columns, function
  and guard in place; `hashtextextended` available) and postconditions.
- It stops a host from accepting two bookings that overlap in time:
  - interval of an accepted booking: `[confirmed_start_at, confirmed_start_at +
    duration_minutes minutes)` — the 0033 snapshot, never the experience's
    current duration or the requested time; half-open, so back-to-back
    bookings (one ending 20:00, the next starting 20:00) are allowed;
  - conflict: same host (item -> experience -> `providers.id`) and
    `existing_start < new_end AND existing_end > new_start`; only CONFIRMED
    reserves a host's time (one status list in
    `booking_host_overlap_exists`, so a future pre-payment hold is a one-word
    change); REQUESTED, DECLINED, WITHDRAWN and CANCELLED never block;
  - rows accepted before 0033 (no snapshot) never block: their real interval
    is unknown and production holds only test data;
  - concurrency: a transaction-level advisory lock per host
    (`pg_advisory_xact_lock(hashtextextended('felyn.booking_host_acceptance:'
    || provider_id, 0))`, released at commit/rollback), taken by
    `booking_item_confirm` before it re-reads the item and checks for
    overlaps, and again by the update guard on every REQUESTED -> CONFIRMED
    (so no route to CONFIRMED skips it). A key collision between two hosts
    could only make them wait for each other briefly, never let an overlap
    through. No exclusion constraint: it would need a host id and a
    trigger-maintained range column on every item plus `btree_gist`;
  - a refused acceptance raises SQLSTATE 23P01 and changes nothing (the item
    stays REQUESTED without a snapshot); the app tells the host "This
    experience overlaps another confirmed booking."
  - index `booking_request_items_accepted_interval_idx` on
    `(experience_id, confirmed_start_at) WHERE confirmed_start_at IS NOT NULL`
    for the overlap check (with the existing `experiences_provider_id_idx`).
  - The two helpers are callable only by their owner (no client role); no
    grant, policy, table or row is changed. Existing overlaps among already
    accepted bookings, if any, are only reported as a NOTICE.
- Note: two items of the SAME guest request also wait on their shared request
  row when accepted at the same moment (0031's `estimated_total` trigger) —
  unchanged, harmless.
- Companion file (not a migration; never run during deployment):
  `host_booking_overlap_isolated_test.sql` — the fail-closed rehearsal, to be
  run **after 0033 and before 0034**. It embeds 0034's section 2 verbatim
  (`tests/host-booking-overlap.test.ts` fails if the two drift) and checks
  every overlap rule, the non-blocking statuses, a legacy row, another host,
  the guard's backstop, that the lock is taken and that clients can't call the
  helpers. Needs three accounts in `auth.users`; always ends in an error so
  everything is rolled back. It would fail now that 0034 exists, and should
  not be re-run.
- Concurrency (not runnable in one SQL session, so tested separately on a real
  PostgreSQL 17 server with parallel connections and committed data, outside
  the repository): with 0034, a second overlapping acceptance waits on the
  host lock and is then refused; 25/25 simultaneous overlapping races had
  exactly one winner; non-overlapping acceptances of one host and same-time
  acceptances of two hosts all succeeded (different hosts did not wait).
  Without 0034 the same races double-booked 25/25 times.
- SHA-256 of the files as written: 0034 `fbbe913b724363fe…`, isolated test
  `140e0438fd6183a4…`.

## Migration 0035: payment reservation states — NOT YET APPLIED TO PRODUCTION

- `0035_payment_reservation_states.sql` is **written but not applied**
  (neither to production nor anywhere else). **Release decision (2026-10-08):
  apply and deploy it only together with the Stripe payment phase** — until
  guests can pay, every accepted booking would expire at its deadline. Same
  form as 0023-0034: a single `DO` statement that applies fully or rolls back
  fully, with preconditions (the five pre-payment states; 0034's acceptance,
  guard and overlap check; the 0021 message policies; the 0009/0028 triggers)
  and postconditions.
- State machine (on `booking_request_items`, enforced by the update guard for
  every role):
  - REQUESTED -> AWAITING_PAYMENT (host accepts, `booking_item_confirm`) |
    DECLINED | WITHDRAWN;
  - AWAITING_PAYMENT -> CONFIRMED (payment, see below) | PAYMENT_EXPIRED
    (only once `payment_due_at` has passed);
  - CONFIRMED -> CANCELLED (unchanged). REQUESTED -> CONFIRMED is gone;
    AWAITING_PAYMENT can't be cancelled or withdrawn (it is paid or expires).
- `payment_due_at timestamptz` = `least(accepted_at + 24 hours,
  confirmed_start_at - 2 hours)`, set only on acceptance (checked by the
  guard), never written again, never by a client. Plain timestamp arithmetic
  on the 0033 snapshot. Existing rows: NULL, untouched.
- Payment: AWAITING_PAYMENT -> CONFIRMED is allowed only to the owner of
  `booking_request_items` (`postgres`) — never to a client or a
  `service_role` session, not even by a direct UPDATE — only while
  `payment_due_at > now()` (so never at or after the deadline, even before
  the expiry job has run), and under the host's lock. The path is
  `public.booking_item_mark_paid(item)` (owner-only, no client grants): the
  state transition only, no payment record — the Stripe phase records the
  payment and decides how this gets called. It takes the host lock, re-reads
  and locks the item, refuses at or after the deadline (SQLSTATE `FB002`,
  nothing changed, also once expired) and otherwise confirms; anything not
  awaiting payment returns false. The guest gets the existing in-app
  "Your experience is confirmed" notice; no email. 0035 refuses to run unless
  the role running it owns the table.
- Expiry: AWAITING_PAYMENT -> PAYMENT_EXPIRED is likewise allowed only to the
  table's owner — in practice `expire_due_booking_payments()` and the release
  of a host's lapsed reservations inside `booking_item_confirm`, both of which
  run as the owner — and only once `payment_due_at <= now()`. A direct UPDATE
  from a client or `service_role` is refused even for a due booking.
- Late acceptance: `booking_item_confirm` refuses (SQLSTATE `FB001`, nothing
  changed) when the guest would have less than 30 minutes to pay — a request
  starting in under about 2.5 hours (or already started). Exactly 30 minutes
  is accepted. (Decided 2026-10-08.)
- Overlap (0034): AWAITING_PAYMENT now reserves the host's time with
  CONFIRMED; PAYMENT_EXPIRED, REQUESTED, DECLINED, WITHDRAWN and CANCELLED do
  not. Under the host lock, acceptance first expires the host's lapsed
  reservations, so they never block it.
- Expiry: `public.expire_due_booking_payments()` (owner-only) expires every
  due AWAITING_PAYMENT item, host by host under `booking_host_try_lock` — a
  host that is accepting at that moment is skipped (its acceptance releases its
  own lapsed reservations; the next run catches the rest). Idempotent.
  Scheduled by `booking_payment_expiry_schedule.sql` (not a migration):
  pg_cron, every minute, straight to the database function (no app route, no
  email system). Release delay for display: about a minute; for new
  acceptances: none.
- Also: request totals and stay deletion count AWAITING_PAYMENT as active
  (deletion also keeps PAYMENT_EXPIRED as history); messaging is open during
  AWAITING_PAYMENT and has a 30-day reply window after PAYMENT_EXPIRED
  (anchored to `payment_due_at`); on acceptance the guest gets the in-app
  notice `booking_item_accepted` ("Your request was accepted … isn't
  confirmed until you pay … due by …") and the existing
  `request_confirmed_guest` email, now worded "Request accepted — payment
  needed". No email is sent on payment or expiry.
- Release steps (with the Stripe phase): run
  `payment_reservation_states_isolated_test.sql` (after 0034, before 0035;
  expects 0028; needs three accounts), then 0035, then
  `booking_payment_expiry_schedule.sql`, then deploy the app.
- Concurrency (tested outside the repository on a real PostgreSQL 17 server
  with parallel connections and committed data): overlapping acceptances are
  serialized with exactly one AWAITING_PAYMENT winner (25/25 races);
  acceptances against an AWAITING_PAYMENT reservation are refused; acceptance
  vs expiry in either order ends in one consistent state (expiry never waits
  for a busy host; an acceptance waits for a running expiry and then takes
  the released slot); different hosts never wait for each other. Payment vs
  expiry: a running payment makes expiry skip that host without waiting; a
  running expiry makes payment wait, after which an in-time payment confirms
  and a lapsed one is refused (FB002); 25/25 simultaneous races each way end
  in one valid state, and a lapsed booking is never confirmed (12/12 checks).
  The isolated test was also run against 12 deliberately broken versions of
  0035; each one failed at the check meant to catch it.
- SHA-256 of the files as written: 0035 `db097e97aba42990…`, isolated test
  `a8ff7357f0b1e859…`, schedule script `e71e9787e7728687…`.

## Migration 0036: Stripe payment foundation — NOT YET APPLIED ANYWHERE

- `0036_stripe_payments.sql` is **written but not applied** (not to
  production, not to staging). Apply it right after 0035, in the same
  maintenance window, only with the Stripe phase. Database only: nothing here
  talks to Stripe and no application code uses these tables yet. Same form as
  0023-0035 (one `DO` statement, preconditions, postconditions; run as
  `postgres`, the owner of `booking_request_items`).
- New tables, none readable or writable by `anon`, `authenticated` or
  `service_role` (RLS on, no policies; later stages add narrow functions):
  - `host_payout_accounts`: one Stripe connected account per host. Readiness
    (`payouts_ready`) is a generated column from the synced Stripe fields
    (details submitted, payouts enabled, `transfers` capability active, no
    disabled reason, nothing past due) — it can't be written. Account id and
    test/live mode never change; a sync can't move back in time.
  - `booking_payments`: one row per payment attempt (separate charges and
    transfers). Integer euro cents, EUR only, price per person >= €5,
    gross = price x guests, fee = `(gross + 5) / 10` (10%, round half up, as
    `src/lib/payments/money.ts`), host share = gross - fee. A new attempt must
    match the booking's own price snapshot and guest count, the booking must be
    AWAITING_PAYMENT with >= 41 minutes until `payment_due_at` (FB005), and the
    host's payout account must be ready and in the same mode (FB006). At most
    one live attempt per booking (`booking_payments_one_live_attempt`); retries
    after expired / failed / released attempts get the next attempt number.
    Status: creating -> open -> authorized -> captured -> confirmed (only once
    the booking is CONFIRMED) or unconfirmable (captured, but the booking could
    not be confirmed: refund needed). Host transfer: none -> pending -> released
    -> transferred (-> reversed), or blocked. Release needs the booking
    CONFIRMED and completed, but completion never releases anything by itself;
    a refund or dispute forces the transfer to blocked (support reconciles).
  - `stripe_events`: one row per Stripe event id (type, mode, Stripe's
    creation time, SHA-256 of the payload — no payload or personal data),
    delivery count, processing status; identity fixed; processed is final.
- Changed: `booking_item_confirm` (0035's otherwise) needs 60 minutes to pay
  (FB001, was 30) and refuses bookings under €5 (FB004);
  `booking_request_is_deletable` refuses requests with any payment record;
  new prices under €5 are refused (existing ones and booking snapshots are
  untouched; a sub-€5 experience can't be republished and gets no new
  requests, FB004); `service_role` keeps SELECT on `booking_requests` and
  `booking_request_items` (the email sender) but loses INSERT / UPDATE /
  DELETE / TRUNCATE there. 0035's update guard, payment step and expiry are
  not redefined.
- Host-transfer release gate (approved 2026-10-09; details in
  `docs/payments/host-transfer-release-gate.md`), enforced by the
  `booking_payments` update guard for every caller:
  - **Release (`pending -> released`)** needs the booking CONFIRMED and
    completed, the database clock at least 168 hours after the snapshot's
    scheduled end, and no refund or dispute (FB007). Then either:
    - **automatic:** no OPEN support case, meaning a thread linked to the
      booking, or a booking / cancellation / payment / experience thread of the
      guest or host active since acceptance (FB008); or
    - **staff:** only via `support_staff_release_host_transfer(payment, note)`,
      by a signed-in `admin` in `staff_members` acting as themselves
      (`released_by = auth.uid()`, session role `authenticated`), with a note
      (42501).
  - **Transfer (`released -> transferred`)** re-checks everything. A staff
    release is refused if a case was opened, reopened or answered after it.
  - **Recording:** the database stamps the release time. Every release is kept
    in `booking_payment_transfer_releases` (append-only). `blocked -> pending`
    clears the release so it can be released again.
  - **Concurrency:** support-thread writes take a shared per-user advisory lock
    (`support_threads.case_activity_at`, new column); release and transfer
    take the guest's and host's locks exclusively.
  - **Grant:** the only grant in 0036 is EXECUTE on the staff release function
    to `authenticated`.
- Before applying, check for experiences under €5 (read-only):
  `select id, title, price_per_person, published from public.experiences where price_per_person < 5;`
- Release steps (with the Stripe phase, after 0035): run
  `stripe_payments_isolated_test.sql` (after 0035, before 0036; expects 0028;
  needs three accounts), then 0036.
- Tested outside the repository on a real PostgreSQL 17 server:
  - **Isolated test:** passes, and fails at the intended check on each of 32
    deliberately broken versions of 0036, 13 of them aimed at the release gate.
  - **Concurrency** with parallel connections and committed data (11/11):
    - the 60-minute boundary against the real clock;
    - acceptance vs expiry (25/25);
    - the payment step vs expiry after the deadline (25/25 refused, never
      confirmed) and before it (25/25 confirmed);
    - two simultaneous attempts for one booking (25/25 exactly one);
    - one Stripe event delivered 10 times at once (10/10 stored once, counted
      10 times);
    - a support case opened while a release is in progress, in both orders
      (the release waits and refuses, or the case waits and then blocks the
      transfer);
    - 25 simultaneous case-vs-release races (0 unsafe);
    - 25 message-vs-staff-release races (all consistent);
    - 25 double admin releases (one release, one audit row each).

    With either advisory lock removed, the "case first" order lets the release
    through (and 0036's own postconditions refuse to apply such a version).
- SHA-256 of the files as written: 0036 `c875e6bdce74e4bc…`, isolated test
  `80f4950b01a3539f…`.
