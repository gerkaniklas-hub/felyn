# Host transfer release gate

Status: **the database side is in `0036_stripe_payments.sql` (not applied
anywhere)**. Approved 2026-10-09: admin-only manual release; the seven days run
from the scheduled end in the acceptance snapshot. No release job, transfer job
or staff UI exists yet.

## What 0036 enforces

The update guard on `booking_payments` enforces this for every caller, including
the database owner.

- **`pending -> released`**
  - The booking is CONFIRMED and `completed_at` is set (FB007).
  - The database clock is at least `confirmed_start_at + duration_minutes + 168 hours`
    (FB007).
  - No refund and no dispute: FB007, and a constraint already forces such
    payments to `blocked`.
  - **Automatic release** (`transfer_release_kind = 'automatic'`): no OPEN
    support case (FB008). That means a thread linked to the booking, or a
    `booking` / `cancellation` / `payment` / `experience` thread of the guest or
    host that has been active since `accepted_at`.
  - **Staff release** (`'staff'`, only through
    `support_staff_release_host_transfer(payment, note)`):
    - `released_by` must equal `auth.uid()`;
    - that user must have the `admin` role in `staff_members`;
    - the session's role must be `authenticated` (an owner or scheduler
      session can't pose as staff);
    - a note of 1–1000 characters is required.

    Anything else is refused with 42501.
  - The release time is always the database's `clock_timestamp()`; any value the
    caller supplies is ignored. Every release adds a row to
    `booking_payment_transfer_releases`, which refuses update, delete and
    truncate.
- **`released -> transferred`**
  - Everything above is checked again.
  - An automatic release requires no OPEN case now.
  - A staff release requires that no OPEN case has activity after the release:
    nothing opened, reopened or answered since then. A case that was open and
    unchanged when the admin released is the one they reviewed.
- **`blocked -> pending`** must clear the release record, so the payment can be
  released again later; every release is kept in the audit table. A payment that
  was already transferred can't go back to `pending`.
- **Concurrency**
  - Every write to `support_threads` takes a *shared* advisory lock keyed on
    the thread owner, then stamps `case_activity_at = clock_timestamp()`. That
    covers opening, reopening, status changes, and every message (through
    0029's `support_messages_touch_thread`).
  - Release and transfer take the guest's and host's keys *exclusively*, in a
    fixed order, before reading the threads with a fresh snapshot.
  - So a case being opened while a release runs is either seen by the release
    (it waits for the case's transaction) or stamped after it (the case waited
    for the release), and then the transfer check catches it.
  - Shown on a real PostgreSQL 17 server: held transactions in both orders, 25
    simultaneous case-vs-release races, 25 message-vs-staff-release races, and
    25 double admin releases. With either lock removed, the "case first" order
    lets the release through.

**Callers must use READ COMMITTED,** Postgres's and Supabase's default. The
fresh-snapshot read after the lock relies on it.

The sections below are the design as approved; the implementation follows it.

## Where things stand (0036)

- A confirmed payment starts with `host_transfer_status = 'pending'`.
- `pending -> released` is allowed only once the booking is CONFIRMED and
  `completed_at` is set. `transfer_released_at` can't be earlier than
  `completed_at`.
- A refund or dispute forces the transfer to `blocked`.
- `released -> transferred` records the Stripe `tr_…` id.
- Nothing sets `released` today, so no transfer can happen.

`completed_at` (0016) is set by a daily job once the experience's date has
passed. That says the date passed, not that the experience took place or went
well, so it must never release money on its own.

## The gate

A host transfer may be **released** only when all of these hold, checked by the
database at release time and checked again when the transfer is created:

1. **Paid and confirmed:** the payment is `confirmed` (captured) and the booking
   is still `CONFIRMED`. A cancelled booking never releases.
2. **Experience completed:** `completed_at is not null`.
3. **Seven-day review period:** `now() >= confirmed_start_at + duration_minutes * interval '1 minute' + interval '7 days'`.
   The review clock starts at the experience's scheduled end, from the
   snapshot written at acceptance (0033), not from anything a client sends.
4. **No refund and no dispute:** `refunded_cents = 0`, `dispute_id is null`,
   and the transfer is `pending`, not `blocked`.
5. **No unresolved support case:**
   - no `support_threads` row for this booking item with `status = 'OPEN'`;
   - and, because guests and hosts can also open threads not linked to a
     booking, no `OPEN` thread by this booking's guest or host in the
     categories `booking`, `cancellation`, `payment` or `experience`, created
     on or after the booking's `accepted_at`. This is conservative: such a
     thread may be about something else, so staff decide.

If conditions 1–4 hold and only 5 fails, the payment needs **staff review**:
it waits until a staff member releases it explicitly, or blocks it.

### Why the database can enforce this without trusting clients

- Every input is already server-owned:
  - payment status and amounts come from 0036's attempt rows (owner-only);
  - booking status, `completed_at` and the acceptance snapshot are protected
    by the 0031–0035 guards;
  - `support_threads` rows are created only by `support_open_thread`, which
    checks `auth.uid()` and that the booking item belongs to the caller;
  - thread status changes only through the definer functions (a user can
    reopen a RESOLVED thread by replying; only staff resolve or close);
  - staff are rows in `staff_members` (no client grants), checked by
    `is_felyn_staff()`.
- No client role or `service_role` can write `booking_payments` (0036). The
  gate lives in that table's update guard, so even a release path written
  wrongly later can't release early.

## Proposed implementation (a later stage)

Columns on `booking_payments`:

- `transfer_release_kind`: `automatic` or `staff`;
- `transfer_released_by`: the staff member, or null;
- `transfer_release_note`: required for a staff release.

Constraint: kind `staff` if and only if `released_by` is set.

**Guard** (`pending -> released`):

- Kind `automatic` requires conditions 1–5.
- Kind `staff` requires 1–4, plus `released_by` being a `staff_members` row.
  Recommended: role `admin` only, because this releases money.
- Staff can't bypass completion, the review period, a refund or a dispute;
  they can only clear a support case.

**Automatic release:** `release_due_host_transfers()`, owner-only, scheduled by
pg_cron once an hour. It releases every pending payment that meets 1–5, takes no
input, and is idempotent.

**Staff actions:** `support_staff_release_host_transfer(payment_id, note)` and
`support_staff_block_host_transfer(payment_id, note)`.

- SECURITY DEFINER; they check `auth.uid()` and `is_felyn_staff()`, as the
  existing `support_staff_*` functions do.
- Executable by `authenticated` only; `service_role` gets no execute.
- Each action also writes an internal staff note to the related support
  thread.

**Transfer creation** (the later transfer job):

- Immediately before calling Stripe, re-check the gate (an extended
  `booking_payment_transfer_blocker`; a thread may have reopened since the
  release).
- Create the transfer with `amount = host_share_cents`,
  `source_transaction = charge_id`, `transfer_group`, and idempotency key =
  payment id.
- Record the `tr_…` id through an owner-only function.

**Mirror in TypeScript:** `getHostTransferEligibility` already refuses without
`transferReleasedAt` (`awaiting_release`) and when `transferBlocked`. A
`HOST_TRANSFER_REVIEW_PERIOD_MS = 7 days` constant will join the timing module
when the release stage is built, with a test tying it to the migration.

## Open points

- Should the review period run from the scheduled end (recommended: it's in
  the snapshot) or from `completed_at`, which the daily job sets up to a day
  later?
- Staff release: `admin` only (recommended), or any support staff?
- How long Felyn may hold a host's share before transferring, and whether that
  needs safeguarding: confirm with Stripe and the accountant before launch.
  Stripe's docs note that disputes and refunds after a transfer need a
  transfer reversal, which fails if the host's Stripe balance can't cover it.
  The seven-day period lowers that risk but doesn't remove it.
