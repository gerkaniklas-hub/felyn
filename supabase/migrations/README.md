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
