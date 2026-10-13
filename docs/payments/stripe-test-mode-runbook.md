# Stripe test mode on the existing production app — runbook

Status:
- **Prepared, nothing applied or deployed.** Every step below is a manual step
  run by the owner.
- **Migrations 0035, 0036 and 0037 are not applied** to any database.
- **The code is on branch `phase-5-payment-reservations`**, partly uncommitted
  and not pushed. Vercel deploys `master` automatically.

Scope:
- Stripe **test mode** only, on the existing production Supabase project and app.
  No real card is charged and no host is paid.
- Nothing in this build creates Stripe transfers, payouts or refunds.

Contents: 1 user-facing changes · 2 approval gate and pre-checks · 3 backups ·
4 email · 5 unpaid-booking expiry · 6 deployment sequence · 7 Stripe and secrets ·
8 smoke test · 9 switching off · 10 not in this build.

## 1. What changes for users once 0035–0037 are applied and the branch is deployed

- **Acceptance no longer confirms a booking.**
  - A host's "Accept" moves the request to **Awaiting payment** (0035).
  - It becomes **Confirmed** only when Stripe's verified webhook reports a captured
    payment.
  - Unpaid by the deadline means **Payment expired**. See section 5 for when that
    actually happens.
- **The payment deadline** is the earlier of 24 hours after acceptance and 2 hours
  before the start. Acceptance is refused if the guest would have less than 60
  minutes to pay (FB001): in practice, a request starting in under about 3 hours.
- **Hosts are NOT required to set up payouts before accepting.**
  - FB003 is reserved but not enforced.
  - If an un-onboarded host accepts, the guest's Pay button answers "your host
    hasn't finished setting up payouts" (FB006).
  - The booking still holds the host's time slot until it expires.
  - **During the test, only hosts who have finished Profile → Payouts should
    accept requests.**
- **Existing bookings:**
  - already Confirmed rows stay Confirmed and never need payment;
  - pending requests change only when accepted.
- **The €5 minimum (0036):** experiences under €5 per person can't be republished
  or newly requested, and such requests can't be accepted (FB004). Existing prices
  are untouched.
- **Awaiting payment bookings** can't be withdrawn or cancelled by either side
  (0035). They can be paid, or they expire. Messaging stays open while a booking
  awaits payment.
- **`service_role` (the server's secret key) can no longer write the booking tables
  (0036).** The email sender only reads them.
- **Payment is offered only when `PAYMENTS_ENABLED=true`.** Until then, accepted
  bookings can't be paid and lapse at their deadline.

## 2. Approval gate and pre-checks

### PROHIBITED on production

**Do not run these against the production database:**

- `supabase/migrations/payment_reservation_states_isolated_test.sql` (0035's pre-check)
- `supabase/migrations/stripe_payments_isolated_test.sql` (0036's pre-check; its own
  header says "never on production")

Why:
- Each runs `alter table public.booking_request_items disable trigger …` 8 times to
  simulate deadlines and late starts.
- `ALTER TABLE` takes an **exclusive lock on the bookings table** for the whole
  test. Every booking read and write by the live app waits until it ends.
- They also create test hosts, experiences and bookings for the first accounts in
  `auth.users`, and take those hosts' booking locks.

Everything is rolled back afterwards, but while they run they act on the live
table. This runbook previously listed them as production steps; that was wrong.

### What replaces them before any production migration is approved

All of these must hold:

1. **Local evidence (done, 2026-10-13).** On a real PostgreSQL 17 with 0001–0037
   replayed and Supabase's roles shimmed:
   - 0035, 0036 and 0037 apply cleanly;
   - their isolated tests print `FELYN TEST PASSED`;
   - 0037's end-to-end checks pass (28/28), and all 7 deliberately broken versions
     of 0037 were caught.

   This does not prove the production schema matches the repository.
2. **Read-only production preflight (to do).** Run
   `docs/payments/production-preflight-readonly.sql` in the SQL Editor as
   `postgres`.
   - It restates the section-1 preconditions of 0035, 0036 and 0037 as `SELECT`s.
   - It writes nothing and changes no lock state.
   - Every row must be `PASS`, or `INFO`. **Any `FAIL`: apply nothing.** FAIL rows
     sort first.
   - Read the `INFO` rows (sub-€5 experiences, pending and confirmed bookings,
     pg_cron and an estimate of its jobs, active sessions) and decide.
   - Optional follow-ups at the end of the file: Q1 for queued emails, Q2 for the
     exact cron jobs.
   - In a local replay of the repository's 0034 state, `A03` and `A04` showed the
     fingerprints `dee6eb7db4b927af` and `772c14023d39a0aa`. If production differs,
     the function text differs from the repository file — for example whitespace
     when it was pasted. `PASS`/`FAIL` is what decides; a different fingerprint is
     only worth a look.
3. **The migrations' own checks.** Each migration re-checks its starting state and
   **rolls back completely** on any mismatch ("Any ERROR means nothing was
   applied").
4. **A verified backup** (section 3).
5. **Email made safe** (section 4).
6. **A decision on expiry** (section 5).
7. **Optional, strongest.** Run the two prohibited isolated tests against a
   **copy** of production (the verified backup restored into a throwaway database
   or project), never against the live project.

0037's isolated test (`stripe_test_mode_isolated_test.sql`) disables no trigger
and alters no existing table. It creates 0037's own objects inside one statement
that always rolls back, and briefly row-locks one test booking. It may run on
production right before 0037, in the same quiet window. Expected:
`ERROR: FELYN TEST PASSED …`.

## 3. Backups — what each kind covers

**No backup has been made or verified for this release.** This machine has no
Supabase CLI, `psql`, `pg_dump` or Docker.

### 3a. Supabase-managed backup (Dashboard → Database → Backups)

- Check whether daily backups and/or point-in-time recovery (PITR) are listed.
  Availability depends on the plan.
- **Verified** only when you can see a completed backup with a timestamp **after**
  the last change you care about.
- It covers the whole Postgres database:
  - every schema, including `auth`, `storage` metadata, `cron.job`, `vault` and
    `felyn_private` (so the webhook secrets too);
  - roles and ownership.
- A restore replaces the entire project database. Everything after the restore
  point is lost.

### 3b. Database dump you control (`pg_dump`, PostgreSQL 17 client tools)

- Install the tools: EDB installer with "Command Line Tools" only, or
  `winget install PostgreSQL.PostgreSQL.17`.
- Use Dashboard → Connect → **Session pooler** URI, without the password; let
  `-W` prompt for it.
- Work in a folder outside the repository:
  ```
  pg_dump "<uri>" -W --format=custom --schema=public --schema=felyn_admin -f felyn-prod-app-<date>.dump
  ```
- After 0037, add `--schema=felyn_private` only to a dump you store encrypted. It
  contains the webhook signing secrets in plain text. Without it, a restore must
  re-create `felyn_private.stripe_settings` and re-enter the secrets (section 7).
- **Verified** only after:
  - `pg_restore --list` succeeds;
  - **and** a restore into an empty throwaway PostgreSQL 17 database gives
    plausible row counts for the main tables.

  Before that it is "a dump", not a backup.
- It does **not** reliably restore into the live project:
  - `auth` is managed by Supabase (users are best kept by the dashboard backup);
  - `cron` jobs are not included (`cron.job` is a table in another schema; record
    jobs separately, below);
  - Vault secrets are encrypted with a project-specific key.

### 3c. Schema export (structure only)

```
pg_dump "<uri>" -W --schema-only -f felyn-prod-schema-<date>.sql
```
Useful to compare production with the repository, or to rebuild structure. It
contains no rows: no bookings, users, settings row or secrets.

### 3d. Outside the database (no database backup contains these)

| Item | Where it lives | How to keep or recover it |
|---|---|---|
| Storage files (photos) | Supabase Storage | Download the buckets separately; the database has only their metadata |
| Auth configuration (providers, email templates, redirect URLs, SMTP) | Dashboard → Authentication | Screenshot or copy the settings |
| Scheduled jobs | `cron.job` | `select jobname, schedule, command, username, active from cron.job;` (save the output); covered by 3a, not by 3b |
| Vault secrets (e.g. `email_sweep_secret`) | Supabase Vault | Re-enter from the source (Vercel / your password manager) |
| Stripe objects (sessions, PaymentIntents, charges, connected accounts) | Stripe | Stripe keeps them; after any database restore, compare `booking_payments` / `host_payout_accounts` with Stripe and resend missed events from Stripe's Dashboard |
| `felyn_private` signing secrets | database (plaintext) **and** Stripe | Reveal or roll each endpoint's secret in Stripe and re-insert it (section 7) |
| `felyn_private.stripe_settings` (test-mode pin) | database | Covered by 3a. If lost, payments fail closed until 0037's row is re-created: `insert into felyn_private.stripe_settings (id, livemode) values (true, false);` |
| Vercel environment variables | Vercel | Keep a private copy |

### Recovery reality for 0035–0037

- **No down-migrations exist.**
- Undoing them means one of:
  - a new reviewed reverse migration (not written);
  - a dashboard restore (loses later data);
  - a logical restore into a fresh project.
- What the migrations do to data:
  - 0035 and 0036 change booking functions and privileges, but rewrite no existing
    booking row;
  - 0037 only adds objects.

## 4. Email: `send` with a mandatory recipient allow-list

**Agreed approach (2026-10-13):**
- keep `EMAIL_DELIVERY_MODE=send`;
- set a **mandatory, non-empty** `EMAIL_RECIPIENT_ALLOWLIST` containing **only
  addresses Felyn controls** (the test accounts);
- keep this from before the first migration until the test ends.

### How it behaves

Facts, from `src/lib/email/` and 0028/0035:

- **Payment events send no email.** Stripe webhooks, payment and expiry create no
  outbox row.
- **Booking actions queue emails** (`public.email_outbox`):
  - a new request (guest and host);
  - an acceptance ("Request accepted — payment needed");
  - a decline;
  - a cancellation.
- **One rule covers both delivery paths.** Emails go out immediately after the
  action (`scheduleEmailDispatch` → `after()`), and from the `email-outbox-sweep`
  job every 5 minutes, which calls `https://app.felyn.eu/api/email/sweep`. Both run
  `dispatchDueEmails`, so the allow-list applies to both. They use the settings of
  the deployment that is **currently live**: a changed variable takes effect only
  after a redeploy. Do not change the sweep job or
  `email_outbox_sweep_schedule.sql`.
- **Format:** plain addresses separated by commas only, e.g.
  `a@example.com,b@example.com`. Spaces around commas are ignored, and letter case
  doesn't matter.
  - **Empty, unset, spaces only, or only commas: no restriction at all.** Everyone
    gets email. Never leave it empty during the test.
  - **Any malformed entry** (`Name <a@b.com>`, `;` as separator, a domain without a
    dot): the whole email configuration is rejected, **nothing is sent to anyone**,
    and the log shows `email: delivery misconfigured — EMAIL_RECIPIENT_ALLOWLIST
    contains an invalid address`. Queued rows stay `pending` and go out under the
    corrected setting if it is fixed within 23 hours.
- **Non-allow-listed recipients are skipped permanently.** The row is marked
  `skipped` / `not_allowlisted` and Resend is never called. The sender only ever picks
  up `pending` rows and `sending` rows stalled for 10 minutes or more, so a skipped
  email **is never delivered later**, even after the allow-list is removed. This
  includes any real user's email triggered during the test.
- **Not covered by the allow-list:**
  - Supabase Auth emails (sign-up confirmation, password reset), sent by Supabase
    itself;
  - Stripe's own emails. Stripe sends no automatic receipts in test mode.

### Steps

1. **Before the migrations:** in Vercel → Settings → Environment Variables
   (**Production**), set `EMAIL_RECIPIENT_ALLOWLIST` to the controlled test
   addresses. Keep `EMAIL_DELIVERY_MODE=send`. Check that `RESEND_API_KEY`,
   `EMAIL_FROM` and `EMAIL_APP_URL` (`https://app.felyn.eu`) are still set.
2. **Redeploy the current production deployment** (Deployments → ⋯ → Redeploy), so
   the live app and the sweep use the allow-list before anything else happens.
3. **Log check:** in the Vercel function logs after the redeploy, there must be no
   `email: delivery misconfigured`. If there is, fix the variable and redeploy:
   nothing has been sent meanwhile.
4. **Delivery check:**
   - with two allow-listed test accounts, send one booking request;
   - the guest and host emails must arrive;
   - optionally, run preflight query Q1 a few minutes later: no row for that
     request should be `pending`.
5. **Check after the new deploy (section 6, step 9):** the new deployment inherits
   the same Production variables. Repeat check 3.
6. **After the test:** removing the allow-list or leaving it empty means **everyone**
   receives email again. Decide deliberately. Emails skipped during the test stay
   skipped.

## 5. Unpaid-booking expiry

### What exists (0035, reviewed)

- **`public.expire_due_booking_payments()`**
  - `SECURITY DEFINER`, owned by `postgres`, `search_path = ''`.
  - EXECUTE revoked from `public`, `anon`, `authenticated` and `service_role`.
  - For each host with an `AWAITING_PAYMENT` booking whose `payment_due_at <= now()`:
    it takes that host's booking lock **without waiting**. A host that is accepting
    right then is skipped until the next run.
  - It sets those bookings to `PAYMENT_EXPIRED` and returns how many it expired.
  - The update guard allows that change only for the table owner, and only once the
    deadline has passed.
  - **Idempotent:** a second run finds nothing more to expire.
  - Side effects:
    - no email, no in-app notice (0035's triggers ignore `PAYMENT_EXPIRED`);
    - the request total is recomputed;
    - payment attempts are not touched.
- **`supabase/migrations/booking_payment_expiry_schedule.sql`** (NOT applied, NOT
  enabled)
  - It schedules pg_cron job `expire-due-booking-payments` **every minute**
    (`* * * * *`) with the command `select public.expire_due_booking_payments();`.
  - Before scheduling, it checks that the function and pg_cron exist.
  - It replaces any earlier job of that name and refuses unless the job runs as the
    function's owner. It verifies exactly one active job.
  - It makes no HTTP call and uses no key.
  - It is re-runnable. To stop it: `cron.unschedule(<jobid>)` (shown in the file).
  - pg_cron records each run in `cron.job_run_details`, about 1,440 rows per day.
- **Lazy expiry:** each host acceptance (`booking_item_confirm`) first expires that
  host's own lapsed bookings, under the host lock. So lapsed bookings never block
  that host's next acceptance.
- **After the deadline nothing can be paid:**
  - Checkout closes 10 minutes before the deadline;
  - capture needs at least 2 minutes of margin (0037);
  - the payment step refuses at or after the deadline (FB002).

### Without the schedule

A lapsed booking stays `AWAITING_PAYMENT` until that host accepts something else,
or someone runs the function. Until then:
- the guest page says the deadline has passed and offers no payment;
- host lists still say "Awaiting payment";
- messaging stays open;
- the request can't be withdrawn or deleted.

### Assessment

The function and the schedule are safe for the test:
- they act only on bookings whose deadline has passed, which can't be paid anyway;
- they touch nothing else and send nothing.

### Decision (2026-10-13)

**(B) Apply the reviewed schedule.** Run `booking_payment_expiry_schedule.sql` once,
as `postgres`, right after 0037 (SQL checklist, step 5). pg_cron already runs
`complete-past-experiences` and `email-outbox-sweep` in production.

Fallback, if step 5 fails: (A) run `select public.expire_due_booking_payments();` by
hand as `postgres`. It is safe to repeat. Until then, expiry happens lazily.

## 6. Deployment sequence

Constraint: the current `master` app doesn't know the 0035 statuses, while the
branch app reads `payment_due_at`, which only exists after 0035. So the branch
can't be deployed before 0035, and `master` must not handle acceptances after it.

If a host accepts while the old app is live after 0035, the acceptance email is
lost for good: the old sender requires `CONFIRMED`, so it marks the email
`skipped` / `no_longer_confirmed`. The old app also shows the booking as
"Requested". No data is corrupted.

1. **Prepare, with no production effect:**
   - commit the branch locally, excluding
     `supabase/migrations/email_outbox_sweep_schedule.sql`;
   - do **not** push the branch: a preview deployment would run against the
     production database before 0035;
   - finish sections 3 and 4 (steps 1–4).
2. **Vercel (Production):**
   - `PAYMENTS_ENABLED=false`;
   - no `STRIPE_*` variables yet;
   - the email allow-list from section 4.

   Then redeploy the current production and run section 4's log and delivery
   checks.
3. **Confirm** that Vercel → Settings → Git → Production Branch is `master`.
4. **No acceptances** from here until step 9 is live. Tell the test hosts.
5. **Read-only preflight** (section 2): 0 `FAIL`, or stop.
6. **Apply the SQL checklist below**, in order. Stop at the first unexpected result.
7. **Deploy immediately:**
   `git push origin phase-5-payment-reservations:master`.
   - This fast-forwards GitHub's `master` to the branch commit without checking
     `master` out locally. A local checkout with `core.autocrlf=true` would rewrite
     the SQL files with CRLF line endings and change their fingerprints.
   - Git refuses if it isn't a fast-forward.
   - Vercel builds it with payments **off**.
8. **Wait** for the Vercel deployment to show Ready.
9. **Check (read-only):**
   - a booking page and the host Requests page load;
   - `POST https://app.felyn.eu/api/stripe/webhook` answers **404**;
   - `select livemode from felyn_private.stripe_settings;` returns `false`;
   - preflight query Q2 lists 3 jobs: `complete-past-experiences`,
     `email-outbox-sweep` and `expire-due-booking-payments`;
   - the logs show no `email: delivery misconfigured`.
10. **Stripe and secrets** (section 7). Payments stay off meanwhile.
11. **Enable:**
    - set the `STRIPE_*` variables;
    - set `PAYMENTS_APP_URL=https://app.felyn.eu`;
    - set `PAYMENTS_ENABLED=true`;
    - redeploy.
12. **One test host** completes Profile → Payouts and waits for **Ready**. Only
    "Ready" hosts accept requests from now on.
13. **Smoke test** (section 8).

### SQL checklist (Supabase SQL Editor, role `postgres`, one file per run)

Before pasting each file, compare its SHA-256 with the table (e.g.
`Get-FileHash <file> -Algorithm SHA256` in PowerShell, which prints upper case).

The fingerprints are of the files as they are now on disk, with LF line endings.
If a Git checkout rewrote them with CRLF, the hash differs although the SQL is the
same. Stop and ask rather than paste a file whose hash doesn't match. **Not on this list, and
never run on production:**
- `payment_reservation_states_isolated_test.sql`
- `stripe_payments_isolated_test.sql`

| # | File | Expected output | SHA-256 |
|---|---|---|---|
| 0 | `docs/payments/production-preflight-readonly.sql` | Rows only; no `FAIL` row | `e47cdf3d16541bcd28e61dd76b0d32fa6225d5508a316a41e22d079687f1b8f9` |
| 1 | `supabase/migrations/0035_payment_reservation_states.sql` | `Success. No rows returned` | `db097e97aba429905d024ebe595686446d3ea4466de9e4d0d5d61c578988feec` |
| 2 | `supabase/migrations/0036_stripe_payments.sql` | `Success. No rows returned` | `c875e6bdce74e4bc78ef30e06e58632bd065aea2607154bd8456a4adc001b5d3` |
| 3 | `supabase/migrations/stripe_test_mode_isolated_test.sql` | `ERROR: P0001: FELYN TEST PASSED — …` (the error is intentional; nothing is kept) | `404fc0aca68e9d667bc5235580166a8bfb4b4911460a41676db80e806ebd1425` |
| 4 | `supabase/migrations/0037_stripe_test_mode.sql` | `Success. No rows returned` | `765bb98e48e6897b119fe2df39951f41f0d03a30f02a4f8307aaf77a91fb0c0d` |
| 5 | `supabase/migrations/booking_payment_expiry_schedule.sql` | `Success. No rows returned`, NOTICE `OK: expire-due-booking-payments runs every minute as postgres.` | `e71e9787e7728687b6f12872860febc9923ce1e2672346a6706d0a6a974fba0a` |

Any other output stops the sequence:
- if 1, 2 or 4 fails, that migration changed nothing;
- 3 printing `FELYN TEST FAILED` means: don't apply 4;
- if 5 fails, payment works, but expiry stays lazy (section 5).

## 7. Stripe (test mode / Sandbox) and the database secrets

1. Use a **dedicated Stripe sandbox for Felyn**. The webhook cancels any held
   payment from a completed Checkout that matches no Felyn payment, which would
   affect anything else sharing the account.

   Hosts' payout accounts use Stripe's **Accounts v2** API
   (`POST /v2/core/accounts`, then `POST /v2/core/account_links`), because Stripe
   refuses `/v1/accounts` for new Connect integrations. In the sandbox, before the
   first host clicks "Set up payouts with Stripe":
   - finish Connect's platform setup, including the platform profile
     (Stripe error codes `connect_profile_not_submitted`,
     `platform_registration_required`);
   - enable Accounts v2 for the platform if Stripe asks for it
     (Settings → Connect → Platform setup; error code `accounts_v2_access_blocked`);
   - acknowledge that **Felyn carries losses** on connected accounts. Hosts get the
     Express Dashboard, which requires Felyn to collect fees and carry losses
     (error codes `account_creation_liability_unacknowledged…`).

   What the app sends, with `Stripe-Version: 2025-12-15.clover`:
   - the account: `dashboard: express`, `identity.country: es`, the host's
     email as `contact_email`, Felyn as `fees_collector` and `losses_collector`,
     and the `recipient` configuration with the `stripe_balance.stripe_transfers`
     capability (to receive transfers later; nothing is transferred in this build);
   - the onboarding link: `use_case.type: account_onboarding` for the `recipient`
     configuration, returning to `/provider/payouts`. Stripe requires https here,
     so `PAYMENTS_APP_URL` must be `https://…`.
2. Create a restricted key (`rk_test_…`) with write access to:
   - Checkout Sessions;
   - PaymentIntents;
   - Connect accounts (Accounts v2) and account links.

   Stripe's labels for the Accounts v2 permissions aren't recorded here. If host
   onboarding fails with a permission error, check the key's Connect permissions,
   or use `sk_test_…`, which also works. Live keys are refused by the app.

   A failed Stripe call is logged in Vercel's runtime logs as
   `payments: Stripe did not create a connected account (status …, type …, code …, request req_…)`
   or `payments: Stripe did not create an onboarding link (…)`. Look up the
   `req_…` id in the sandbox's Workbench → Logs (Accounts v2 requests appear only
   in Workbench). The log never contains the key, the email or Stripe's message.
3. Add webhook endpoint 1 (your account):
   - URL: `https://app.felyn.eu/api/stripe/webhook`
   - Events:
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `payment_intent.succeeded`
     - `payment_intent.canceled`
     - `charge.refunded`
     - `charge.dispute.created`
     - `charge.dispute.updated`
     - `charge.dispute.closed`
4. Add endpoint 2 (connected accounts):
   - URL: `https://app.felyn.eu/api/stripe/connect-webhook`
   - Event: `account.updated`
   - Events from: **Connected accounts**. Stripe still sends this v1 event for
     accounts created with Accounts v2, in the Connected accounts scope. Felyn
     doesn't use the v2 (`v2.core.account…`) events.
5. As `postgres`, after 0037:
   ```sql
   insert into felyn_private.stripe_webhook_secrets (endpoint, slot, secret)
   values ('platform', 'current', '<endpoint 1 whsec_…>'),
          ('connect',  'current', '<endpoint 2 whsec_…>');
   ```
   - Delete the snippet from the SQL Editor history afterwards.
   - Plaintext at rest: database owner, dashboard and backups can read it; API keys
     can't.
6. Vercel (Production):

   | Variable | Value |
   |---|---|
   | `STRIPE_MODE` | `test` |
   | `STRIPE_SECRET_KEY` | the test key |
   | `STRIPE_WEBHOOK_SECRET` | endpoint 1's secret |
   | `STRIPE_CONNECT_WEBHOOK_SECRET` | endpoint 2's secret |
   | `PAYMENTS_APP_URL` | `https://app.felyn.eu` (https; the app doesn't enforce it in test mode) |

   `SUPABASE_SECRET_KEY` is already set.
7. Rotation: `docs/payments/webhook-signature-verification.md` §4, using the
   `previous` slot.

Dashboard "Send test event" uses made-up object ids:
- they are verified and recorded, but match nothing;
- a synthetic completed Checkout makes the route try to cancel a made-up
  PaymentIntent, which Stripe reports as missing; the route accepts that as nothing
  to cancel.

Prefer a real test Checkout (section 8).

## 8. Smoke test (test cards only)

1. A guest requests an experience of the onboarded host, at least 4 hours ahead.
   The host accepts. The guest's booking page shows **Pay €…**.
2. Pay with `4242 4242 4242 4242`, any future date, any CVC. Felyn shows
   "confirming", then **Confirmed** within seconds. Stripe shows the payment
   captured.
3. Check, read-only:
   ```sql
   select status, host_transfer_status, gross_cents, platform_fee_cents from public.booking_payments order by created_at desc limit 5;
   select event_type, processing_status, delivery_count, outcome from public.stripe_events order by received_at desc limit 10;
   ```
4. Resend an event from Stripe: `delivery_count` grows, and nothing happens twice.
5. Also try:
   - abandoning Checkout: "payment wasn't completed", then pay again;
   - a declined card: `4000 0000 0000 0002`;
   - a booking left unpaid past its deadline, then section 5's expiry.

## 9. Switching payments off again

- Set `PAYMENTS_ENABLED=false` and redeploy.
  - Pay buttons disappear.
  - Both webhook routes answer 404.
- Don't do this while a payment is in progress. A held payment that Stripe can't
  deliver to Felyn is never captured; the bank releases it after about 7 days, and
  the booking expires.
- The migrations stay applied.

## 10. Deliberately not in this build

- **Host transfers and payouts:**
  - no code calls Stripe's transfers, payouts or refunds APIs;
  - 0037 never releases or transfers a host share;
  - 0036's release gate is untouched and unused.
- **Refunds:** made by hand in the Stripe Dashboard by Felyn support. The webhook
  records them and blocks the host transfer.
- **Live mode:** refused by the app's config and the webhook route, and pinned off
  in the database. Going live needs a reviewed migration and code change.
