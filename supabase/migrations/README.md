# Migration history — known gap

This directory is **not currently a fully reproducible clean-install history**.
A fresh Supabase project cannot be created from these files alone. Read this
before assuming `0001` → latest can be replayed end-to-end.

## Missing file: `0018_experience_cancellation_columns.sql`

- Migration 0018 **was applied** to the live Supabase database. It introduced
  the cancellation-related schema on `booking_request_items` — at minimum the
  `cancelled_at` and `cancelled_by` columns, a widened `status` check
  constraint (adding `CANCELLED` to the allowed values), and a constraint
  pairing `cancelled_at`/`cancelled_by` (referenced by name in 0019's preflight
  as `booking_request_items_cancelled_pair_check`).
- Its **original SQL file was lost before this project's migrations were ever
  committed to Git** — there is no commit, stash, branch, tag, or local backup
  containing it. It cannot be recovered.
- The **exact original constraint definitions and full file contents are
  unavailable**. What's listed above is reconstructed only from what later
  migrations' preflight checks explicitly depend on, and from columns already
  in active use by the application — not from the original text.
- No reconciliation or "replacement 0018" file has been created for this gap,
  and none should be assumed to exist. Do not guess at or recreate 0018's
  contents without a deliberate, clearly-labeled decision to do so.

## How later migrations relate to this gap

- **`0019` onward** contain explicit preflight checks (`do $$ ... raise
  exception ...`) that verify the schema 0018 is assumed to have left behind
  actually exists before making any change — e.g. 0019 aborts if
  `cancelled_at` or the `booking_request_items_cancelled_pair_check`
  constraint isn't present. These checks are the only remaining evidence of
  what 0018 must have contained.
- **`0021`** additionally notes that `decided_at` was understood to have been
  added by 0018 as well, though this specific detail was not independently
  re-verified against the live schema at the time 0021 was written.

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
  migrations in order — the sequence has a real, undocumented gap at 0018
  and will not produce the same schema as the current live database.
- Anyone provisioning a new environment from this repo needs a proper
  baseline/reconciliation migration (or a full schema dump) first. None
  exists yet as of this writing.
