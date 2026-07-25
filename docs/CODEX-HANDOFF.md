# Syveka AI — Codex Handoff

Technical implementation handoff for the next task. This is the **only** task assigned right
now — do not start on P1/P2 items from `ROADMAP.md` without a fresh handoff, even if they look
quick.

## Status of the previous handoff (P0.1 — dependency audit)

Done. Resolved in commit `3b285a2` ("fix: unblock dependency audit and formatting"). Superseded
by this handoff.

## Current target

**Diagnose (do not yet fix) a schema-contract drift on `booking_types.duration_options` that now
blocks staging release validation's read-only compatibility preflight.**

## Why this is first

The staging release pipeline was blocked end-to-end by a `20260701000000_initial_baseline`
migration failure (PRs #11, #12, #13, #14 — idempotency fix, temporary DB repair workflow, an
auth-schema permission fix, and cleanup, all merged into `main`). That blocker is **fully
resolved**:

- Staging's `_prisma_migrations` no longer has a failed row for
  `20260701000000_initial_baseline`.
- `prisma migrate deploy` now applies all 10 migrations cleanly against the real staging
  database (verified directly, `prisma migrate status` reports "Database schema is up to date!").
- Workflow run
  [30138154368](https://github.com/syveka/syveka-ai/actions/runs/30138154368) (Staging release
  validation, dispatched from `main` at `70b46f1`) got past every step that used to fail,
  including `Apply Prisma migrations to staging`.

That same run then failed at the **next** step, `Read-only legacy compatibility preflight`
(`prisma/sql/006_legacy_baseline_preflight.sql`), with a genuinely new and unrelated error:

```
psql:prisma/sql/006_legacy_baseline_preflight.sql:1003: ERROR:  Syveka baseline incompatible column booking_types.duration_options: expected type integer[], not_null false, identity , generated , default array[30]; found type integer[], not_null t, identity , generated , default array[30]
CONTEXT:  PL/pgSQL function inline_code_block line 808 at RAISE
##[error]Process completed with exit code 3.
```

In plain terms: the frozen "expected schema" contract (embedded identically in both
`prisma/sql/006_legacy_baseline_preflight.sql` and
`prisma/migrations/20260701000000_initial_baseline/migration.sql`, enforced byte-identical by
`tests/unit/release-migration-contract.test.ts`) says `booking_types.duration_options` should be
**nullable** (`not_null false`). The live staging database — now fully migrated through all 10
migrations for the first time — has it as **`NOT NULL`**. Something diverged between whatever
migration actually shaped this column and the contract's frozen expectation of it.

## What's already known (read-only checks only, nothing changed)

- `prisma/schema.prisma:642` currently declares:
  `durationOptions Int[] @default([30]) @map("duration_options")` — no `?`. Prisma does not
  support nullable array fields, so this schema declaration is inherently `NOT NULL`, matching
  what's live in the database, **not** matching the frozen contract's `not_null false`.
- This strongly suggests the **frozen contract is the stale side**, not the live schema — but
  this has not been verified against migration history, and it must be before anything is
  changed.
- `20260701000000_initial_baseline` is not in the checksum-pinned "published" list in
  `scripts/check-migration-history.mjs`. Migrations 2–9 (including whichever one actually set
  `duration_options` to `NOT NULL`, if it was one of them) **are** pinned — do not assume any of
  them can be edited without the same care applied to the baseline fix.

## Safest next investigation steps (do not act on these yet without re-confirming)

1. `git log -p --all -- prisma/migrations/*/migration.sql | grep -n -B5 'duration_options'` (or
   grep each `migration.sql` directly) to find every statement that touches
   `booking_types.duration_options`, in migration order, and determine which one (if any)
   introduced `NOT NULL`.
2. Confirm whether that migration is in the checksum-pinned list. If it is, it must not be
   edited — the correction belongs in a new additive migration and in the frozen contract, not in
   the pinned file.
3. Decide, deliberately, which side is authoritative: does the application actually rely on
   `duration_options` always being non-null (check `src/server/services/*booking*`,
   `src/lib/validators/*booking*`, and any code path that reads this column assuming it's never
   null)? If yes, the contract (both copies, kept byte-identical per the unit test) is what needs
   correcting to `not_null true` for this column — not the live database.
4. If the contract needs correcting: update both
   `prisma/sql/006_legacy_baseline_preflight.sql` and the identical block inside
   `prisma/migrations/20260701000000_initial_baseline/migration.sql`, keep
   `tests/unit/release-migration-contract.test.ts` passing (it byte-compares the two), and treat
   this exactly as carefully as the baseline idempotency fix was treated — full local
   reproduction against a fresh Postgres before touching anything real.
5. Do **not** touch the live staging database directly to "fix" this by relaxing or adding a
   constraint until the direction in step 3 is settled — changing the contract and changing the
   database are two different fixes for two different diagnoses, and doing the wrong one first
   makes the real problem harder to see.
6. Re-run the read-only preflight locally
   (`psql "$URL" -v ON_ERROR_STOP=1 -f prisma/sql/006_legacy_baseline_preflight.sql`) against a
   database migrated through all 10 migrations before touching staging again — this reproduces
   the failure without needing staging credentials at all.

## Prohibited changes (for tonight, and until the above is deliberately decided)

- Do not modify any published (checksum-pinned) migration file.
- Do not modify `prisma/schema.prisma` or any live database schema, staging or production.
- Do not run `prisma migrate resolve`, `db push`, `migrate reset`, or dispatch any release/repair
  workflow.
- Do not touch `.env.local`, `.env.example`, or any secret.

## Relevant files

- `prisma/sql/006_legacy_baseline_preflight.sql` — the failing read-only check, source of the
  exact error above.
- `prisma/migrations/20260701000000_initial_baseline/migration.sql` — carries a byte-identical
  copy of the same contract between the `-- BEGIN/END LEGACY BASELINE COMPATIBILITY CONTRACT`
  markers.
- `tests/unit/release-migration-contract.test.ts` — enforces the two stay byte-identical; also a
  good place to see the exact contract row format for `booking_types`.
- `prisma/schema.prisma:642` — current source-of-truth declaration for this column.
- `docs/release-runbook.md` — the "Recovering from a failed initial baseline apply" section
  documents the now-resolved migration-bookkeeping issue this handoff supersedes as the active
  blocker.

## Database impact

None yet — this handoff is diagnosis-only. Any eventual fix must be additive (new migration
and/or contract text correction), never a rewrite of a pinned migration or a direct unreviewed
change to staging/production.
