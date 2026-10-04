# Syveka staging and production release runbook

This runbook is the release authority for the first Syveka staging release. A
staging validation is required before production approval. Never use production
credentials to test this workflow, paste secrets into an issue/PR/log, or commit
`.env` files, SQL backups, connection strings, tokens, or credentials.

## Migration history and baseline decision

The original repository shipped a complete Prisma schema but no initial Prisma
migration. The first tracked migration, `20260712000000_dashboard_indexes`,
immediately referenced `deals`, `activities`, and `conversations`. Consequently,
`prisma migrate deploy` failed on an empty database, while previously provisioned
databases depended on manually running `prisma/sql/001` through `003`.

The repair does not edit any published migration:

1. `20260701000000_initial_baseline` is the schema generated from commit
   `06f3bd093d7c5d70a285bd25f7cd350a7777cc41`, the parent schema of the first
   migration. On an empty database it creates that schema. On an existing
   database it verifies the complete compatibility contract (tables, columns,
   PostgreSQL types (including enum names and the vector dimension), nullability,
   identity/generated behavior, declared defaults, primary/unique keys, all 71
   ordered foreign-key definitions, enums, and required indexes) and performs no
   table DDL. Foreign keys include both schemas/tables, both ordered column lists,
   validation state, update/delete actions, and deferrability. It rejects partial
   or drifted databases inside a transaction.
2. The eight published feature/security migrations run unchanged.
3. `20260719000000_initial_security_baseline` additively tracks the original
   extensions, functions, search indexes, and base RLS setup. Existing policies
   are preserved, missing expected policies are added, and every expected
   authenticated policy is validated by schema/table/name, permissive mode,
   command, exact role set, and normalized USING/WITH CHECK predicates. Weak,
   differently defined, additional authenticated/public, or server-only policies
   abort and roll back the migration.
4. Supabase Storage remains an explicit compatibility step because plain
   PostgreSQL has no `storage` schema. `prisma/sql/004_storage.sql` is
   transactional and rerunnable, and refuses same-name policy drift.

Required lexical order:

1. `20260701000000_initial_baseline`
2. `20260712000000_dashboard_indexes`
3. `20260712120000_crm_contacts_companies_v1`
4. `20260712180000_crm_deals_v1`
5. `20260713000000_calendar_booking_v1`
6. `20260714000000_secure_document_upload_intents`
7. `20260715000000_ai_chat_production_hardening`
8. `20260715230000_security_invariant_corrections`
9. `20260718000000_calendar_booking_rls`
10. `20260719000000_initial_security_baseline`

Run `npm run migrations:check` before release. It verifies this order and pins
the checksums of migrations 2 through 9, which were already published.
`20260701000000_initial_baseline` is deliberately excluded from that pinned
list: it has never successfully completed `prisma migrate deploy` in any
shared environment, so it remains safe to correct.

### Recovering from a failed initial baseline apply

Every `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT`
statement in `20260701000000_initial_baseline` is now guarded (native
`IF NOT EXISTS`, or an existence check against `pg_type`/`pg_constraint` for
the statements PostgreSQL does not support that clause on) so the file is safe
to reapply from any partially-created state, for example a database that was
originally provisioned with `prisma db push` before migrations existed. The
migration no longer wraps itself in an explicit `BEGIN`/`COMMIT`: Prisma
already applies each `migration.sql` inside its own transaction, and the extra
literal `BEGIN`/`COMMIT` statements caused Prisma's schema engine to report a
generic `current transaction is aborted, commands ignored until end of
transaction block` error instead of the real PostgreSQL error whenever any
earlier statement failed. To see the real error for any future failure, run
the file directly with `psql -v ON_ERROR_STOP=1 -f
prisma/migrations/20260701000000_initial_baseline/migration.sql` against the
same database instead of `prisma migrate deploy`.

If `prisma migrate deploy` already failed once, `_prisma_migrations` retains a
row for `20260701000000_initial_baseline` with `finished_at` still null. Every
subsequent `prisma migrate deploy` will refuse with `P3009` until that row is
resolved:

1. Confirm with `npx prisma migrate status` that `20260701000000_initial_baseline`
   is the failed migration, and independently verify (do not assume) that its
   DDL did not leave the database in an inconsistent state beyond the
   idempotent objects this migration itself owns.
2. Per two-maintainer approval, run:
   ```sh
   npx prisma migrate resolve --rolled-back 20260701000000_initial_baseline
   ```
   using `STAGING_DIRECT_URL` (or the equivalent production URL, only after a
   verified backup). This only clears the bookkeeping row; it does not touch
   any table.
3. Re-run `prisma migrate deploy`. Because the migration is now idempotent,
   it will finish creating whatever baseline objects are still missing and
   continue on to the remaining nine migrations.

The standalone preflight and the contract embedded in the initial migration are
byte-identical between their marker lines and enforced by a unit test. The
contract intentionally permits unexpected extra columns for legacy forward
compatibility, but an extra column cannot replace an expected name or relax its
type, nullability, generated/identity behavior, or default. Operators must still
review extras before release; the preflight never removes or rewrites them.

## One-time owner setup for staging

Create a dedicated Supabase project containing no production data. Record its
20-character project ref, and create a separate Vercel project whose Preview
environment points only at this staging Supabase project. Never reuse the
production Supabase or Vercel project.

In GitHub, create an Environment named exactly `staging`. Restrict its deployment
branches to trusted branches and, preferably, require an environment reviewer.
Configure these environment variables:

- `STAGING_SUPABASE_PROJECT_REF`: the staging project ref.
- `STAGING_SUPABASE_URL`: `https://<staging-ref>.supabase.co`.
- `PRODUCTION_SUPABASE_PROJECT_REF`: the production ref, used only as a nonsecret
  deny-list guard.
- `PRODUCTION_VERCEL_PROJECT_ID`: the production project ID, used only as a
  nonsecret deny-list guard.

Configure these secrets only on the `staging` Environment:

- `STAGING_DATABASE_URL`: staging pooled application URL.
- `STAGING_DIRECT_URL`: staging direct/session-pooler migration URL; do not use
  transaction-pooler port 6543.
- `STAGING_SUPABASE_SERVICE_ROLE_KEY`.
- `STAGING_OPENAI_API_KEY` with staging/test usage limits.
- `STAGING_VERCEL_TOKEN`.
- `STAGING_VERCEL_ORG_ID`.
- `STAGING_VERCEL_PROJECT_ID`.
- `STAGING_E2E_USER_EMAIL` and `STAGING_E2E_USER_PASSWORD` for a seeded staging
  tenant with the default pipeline and permissions needed by the smoke suite.

Also configure the separate Vercel staging project's Preview environment with
all application runtime settings from `.env.example`, using staging/test values.
At minimum this includes Supabase URL/keys, both database URLs, AI keys, Upstash,
QStash, Stripe test-mode values, Resend, and Calendar encryption/OAuth settings.
The staging project ID must not equal `PRODUCTION_VERCEL_PROJECT_ID`.

### Workflow bootstrap after this pull request merges

GitHub can dispatch a workflow only after that workflow file exists on the
default branch. Therefore, merge this pull request only after `CI required`
passes, then run **Staging release validation** from `main`. Merging does not
deploy production: the production workflow has only `workflow_dispatch`, and
Vercel's independent Git production deployment must be disabled.

For both GitHub Environments, restrict deployment branches/tags to `main` only.
For `production`, require an owner/reviewer approval and disallow administrator
bypass except through the audited emergency process. These settings are part of
the gate; the workflow's own `github.ref` check is defense in depth.

## Staging release validation

1. Create a backup or verify Supabase staging PITR before the first migration.
2. After this workflow exists on the default branch, open **Actions -> Staging
   release validation -> Run workflow**, select `main`, and record its exact SHA.
3. Enter the staging Supabase project ref. The workflow rejects a mismatch, a
   production project-ref match, or a production Vercel-project match.
4. The workflow installs dependencies; runs formatting, i18n, lint, typecheck,
   tests, build, Prisma validation, migration-history validation, and the
   production dependency audit.
5. It runs the read-only `006_legacy_baseline_preflight.sql`, then
   `prisma migrate deploy` against staging before application deployment, then
   `prisma migrate status`.
6. It applies rerunnable Supabase Storage compatibility and validates the private
   `documents` bucket plus embedding-key configuration.
7. It runs read-only release assertions and rollback-wrapped RLS/tenant tests.
8. Only after all database checks pass does it build and deploy the separate
   Vercel staging project.
9. It waits for `/api/health`, then runs Playwright smoke tests against the new
   deployment URL.

The smoke gate covers authentication startup, CRM dashboard, contacts and
companies, deals pipeline, Calendar and Booking links, AI chat/API startup,
document upload, Knowledge Base configuration, database health, RLS, tenant
relationships, and server-only table restrictions.

Do not run migrations repeatedly as a test. Prisma migrations are one-time and
tracked in `_prisma_migrations`. Rerun only `prisma migrate status`,
`tests/staging/release-invariants.sql`, the rollback-wrapped SQL tests, and the
document/storage configuration check. CI reruns only documented compatibility
and assertion SQL; tracked Prisma migrations remain one-time operations.

## Production preflight and backup

Production requires a verified backup before approving the GitHub `production`
Environment (current evidence status: `docs/CI-PRODUCTION-READINESS.md`, addendum
2026-10-04):

- Confirm Supabase PITR is enabled and the recovery window covers the release.
- Create an on-demand logical backup using an approved encrypted destination.
- Record backup time, database project ref, Git SHA, migration status, restore
  owner, and the tested restore procedure in the private change record.
- Test restore into an isolated non-production project when the backup process or
  schema has changed.
- Never store a backup in the repository, Actions artifacts, PRs, or unencrypted
  developer folders.

Before approval, archive the successful staging workflow URL, compare the release
SHA with the production candidate, run `npm run migrations:check`, and review
every pending migration in the order above. From an approved operator session,
run the compatibility preflight before any write:

```sh
psql "$PROD_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/006_legacy_baseline_preflight.sql
npx prisma migrate status
```

### Backup and recovery evidence (as of 2026-10-04)

**Source.** These are the owner's dashboard observations of the production Supabase project
"syveka" on 2026-10-04 (an owner-supplied summary of screenshots). They're observations, not proof
that a restore works, and they don't establish which backup will be the latest at release time.

| Item                   | Observation                                                                                              | Status                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Daily backups          | Listed daily from 2026-09-27 to 2026-10-03; the latest visible is 2026-10-03 22:15:37 UTC, type PHYSICAL | Available (observed)          |
| Point-in-time recovery | The "Point in time" tab shows "Enable add-on"                                                            | **Not enabled**               |
| Storage objects        | The dashboard states that database backups exclude Storage objects; only their metadata is included      | **Not covered by any backup** |
| Restore test           | None performed                                                                                           | **Pending**                   |

**The recovery requirement is not met yet.** The gate above ("Confirm Supabase PITR is enabled") is
**not satisfied**: PITR is off. No restore has been tested, and Storage files have no backup.

The successful staging release #124 (`7a1a8fe`) is release-pipeline evidence, not backup or
recovery evidence.

**Options checked against Supabase's official documentation (2026-10-04):**

| Option                                                                                    | Available for this project?                                                                                          | What it tests                                                                                               | Cost (official pricing)                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. **Restore the existing PHYSICAL backup to a new project** ("Restore to a New Project") | **Yes.** It needs a paid plan with physical backups enabled; the PHYSICAL daily backups show both.                   | The actual managed backup we would rely on                                                                  | The new project bills hourly, rounded up to the full hour, until deleted. It mirrors the source's compute and disk size. Example compute rates: Micro $0.01344/h, Small $0.0206/h, Medium $0.0822/h. Disk: 8 GB included, then $0.125 per GB-month. The org's $10 monthly compute credit may absorb part of it. Compute is **not** covered by the Spend Cap. |
| B. **Logical export (`supabase db dump`) restored into an isolated local Postgres**       | Yes, on any plan, with the database password and the Supabase CLI, Docker and psql.                                  | Only that a **new logical dump** of today's data can be restored. It does **not** test the managed backups. | $0 infrastructure. It requires copying production data out of Supabase, which needs separate approval.                                                                                                                                                                                                                                                       |
| C. **Enable PITR**                                                                        | Available on Pro, Team and Enterprise as an add-on, and the project "must also use at least a Small compute add-on". | Nothing by itself: it changes the recovery point. A restore still has to be tested.                         | 7-day retention: $0.137/h (about $100/month); 14 days: about $200/month; 28 days: about $400/month. Plus any compute upgrade to Small. Recurring.                                                                                                                                                                                                            |

What the official documentation also says:

- **Physical backups can't be downloaded.** "When PITR is disabled, you can still use physical
  backups for restoration, but they are not available for direct download." The existing backup can
  only be tested through a Supabase restore (option A); it can't be pulled into a local database.
- **Restore in place takes the project offline.** "The project is inaccessible during this process."
  It must never be used for a drill.
- **What a new project receives:** schema, data, roles, Auth users with hashed passwords, and the
  **encryption root key**, so Vault and encrypted columns stay readable.
- **What it doesn't receive:** Storage objects and bucket settings, Edge Functions, Auth settings,
  API keys, Realtime settings, extension settings and read replicas. It stays in the source's region.
- **`pg_cron` and `pg_net` jobs run automatically when the restore completes** and can't be paused
  beforehand.
- A project created by restore can't itself be a clone source.
- Daily backups "do not store passwords for custom roles".

Sources (checked 2026-10-04):

- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/platform/clone-project
- https://supabase.com/docs/guides/platform/manage-your-usage/compute
- https://supabase.com/docs/guides/platform/manage-your-usage/disk-size
- https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore

### Recovery drill plan (proposed; not executed, needs owner approval)

**Recommendation: option A, once.** It is the only option that tests the backups actually relied
on, and its cost is bounded by deleting the project the same day. Option B is a complementary
logical-export check and is not a substitute; it needs separate approval because it copies
production data out. PITR (option C) is a business decision about the recovery point, covered
below; it doesn't replace the drill.

**Source and destination**

- **Source:** the latest daily PHYSICAL backup of the production project "syveka", chosen on the day
  of the drill. Record its exact timestamp.
- **Destination:** a **new, temporary** project created by "Restore to a New Project", for example
  `syveka-restore-drill-<date>`. It lands in the same organization and region.
- **Never** restore in place on production, and never restore into the shared staging project.

**Prerequisites and permissions**

- An owner or admin of the production organization, with billing visibility.
- Read the cost overview the dashboard shows before confirming. Stop if it exceeds the approved
  ceiling.
- **Read-only, beforehand, on production.** Confirm whether `pg_cron` jobs or `pg_net`-based
  database webhooks exist:
  - `select jobid, schedule, active from cron.job;` if the `cron` schema exists;
  - `select count(*) from supabase_functions.hooks;` if it exists;
  - the extension list in the dashboard.

  This repository creates neither; its jobs run through QStash, outside the database. **If any
  exist, stop and re-plan:** they would run in the restored project immediately.

- The operator's `psql` (Postgres 17 or newer, matching the docs) and this repository's
  `tests/staging/*.sql` read-only assertions.

**Steps**

1. **Record the starting point:** production project ref, the chosen backup timestamp, the start
   time, and the operator.
2. **Start the restore.** Dashboard: production project, Database, Backups, "Restore to a New
   Project", select the backup. Review the cost and confirm.
3. **Lock the new project down** as soon as it is ready:
   - Settings, Network restrictions: allow only the operator's IP.
   - Don't configure SMTP, Auth providers, hooks or webhooks.
   - Don't deploy Edge Functions.
   - Don't hand out its API keys.
   - **Never point the application, a Vercel project, QStash, Stripe, Vapi, Resend, calendars or
     Meta at it.**
4. **Run validations** with no customer content. Every query is an aggregate or a structural check:
   - **Migrations:** compare `select migration_name, checksum from _prisma_migrations order by 1`
     with production and with this repository (`npm run migrations:check`). The expected result is
     identical lists.
   - **Schema:** compare `supabase db dump --schema-only` hashes, or `pg_dump --schema-only`
     excluding volatile objects, between the copy and production.
   - **Aggregate counts:** `count(*)` per tenant-owned table, plus `auth.users` and
     `auth.identities`. Only counts are recorded. The production backup is a past snapshot, so expect
     the copy's counts to be at or below today's production counts, with no table unexpectedly empty.
   - **Relationships:** zero rows from orphan checks. Examples:
     - `organization_members` without `organizations` or `users`;
     - `public.users` without a matching `auth.users`;
     - `bookings` without `booking_types`;
     - `document_chunks` without `documents`.
   - **RLS, policies and invariants:**
     `psql "$DRILL_URL" -v ON_ERROR_STOP=1 -f tests/staging/release-invariants.sql`, then
     `-f tests/staging/storage-invariants.sql`. Both are read-only. Storage metadata is present even
     though the objects aren't.
   - **Encrypted data:** confirm that columns encrypted with application keys (calendar and social
     tokens) are still ciphertext. The application keys aren't in the database and must **not** be
     brought to the drill.
5. **Measure** the elapsed time from confirmation to "ready" and to "validations done". That gives a
   measured restore time for this database size, which we don't have today.
6. **Clean up the same day.** Delete the temporary project (Settings, General, Delete project).
   Billing stops at deletion, rounded up to the hour. Confirm the next invoice or usage page shows
   only the drill hours. Delete any local outputs; only counts and hashes are kept.

**Estimated cost.** Roughly a few hours of the production compute size plus disk above 8 GB:

- Micro: a few cents.
- Medium for 24 hours: about $2.

The production compute size and disk size aren't known here; the dashboard cost screen shows the
exact figure. **Proposed ceiling: $5, with deletion within 24 hours.**

**Estimated duration.** Unknown. Per Supabase, it depends on database size. Plan about half a day,
and measure the actual time.

**Protecting the copied data.** The temporary project holds real production data:

- Auth users with hashed passwords;
- CRM data;
- the **Vault root key**, so Vault-encrypted columns are readable;
- application-encrypted provider tokens, unreadable without the application keys.

Treat it as production:

- owner-only access;
- IP-restricted;
- no extra dashboard members;
- no exports, screenshots of rows, or copies to laptops;
- deleted the same day.

Its existence and deletion go in the private change record.

**Pass criteria (all required):**

- the restore completes;
- migration lists match;
- the schema matches, apart from documented volatile objects;
- no table is unexpectedly empty, and Auth counts are plausible;
- zero orphans;
- both invariant scripts pass;
- the project is deleted.

Anything else is a **fail**. Record the reason and fix it before production.

**Evidence to record** (in the private change record, not in this repository):

- backup timestamp and type, start and end times, and the measured restore time;
- the cost screen total;
- migration and schema comparison results;
- aggregate counts (numbers only);
- orphan and invariant script results;
- deletion time;
- operator and approver.

### Storage files: separate backup and restore plan

**No database backup or restore covers Storage objects.** The private buckets `documents`,
`voice-recordings`, `exports`, `creator-reference-assets` and `creator-generated-media` hold the only
copy of those files.

**Proposed (needs a separate owner decision):**

1. Inventory object counts and total size per bucket, from metadata only (`storage.objects`
   aggregates).
2. Choose an encrypted destination outside Supabase, with access limited to the owner, and a
   retention period.
3. Copy the buckets using Supabase's documented approach: download and re-upload with a script, or
   the S3-compatible API.
   - S3 access keys are credentials: creating them is an owner action.
4. Test a restore of a **sample** into a temporary bucket in the drill project (option A) or a local
   Supabase stack. Verify checksums and sizes only, never contents.
5. Decide a schedule (for example weekly, plus before each production release). Cost depends on
   total size and the chosen destination, which are unknown today.

**Until then:** losing a Storage object, whether by deletion, corruption or a project-level
incident, is **unrecoverable**.

### Release acceptance: data-loss window, rollback and the PITR gate

- **Data-loss window today:** with daily physical backups only, an incident can lose everything
  written since the last daily backup. That's up to about 24 hours: the latest one seen was
  22:15 UTC. PITR would reduce that to seconds within its retention period.
- **Before a release:** a fresh logical dump taken immediately before the release migrations limits
  the loss **for a release-caused problem** to the minutes between that dump and the incident. The
  runbook's existing step: "Create an on-demand logical backup using an approved encrypted
  destination".

  It doesn't improve the window for unrelated incidents. Restoring a logical dump is manual and
  slower than a managed restore.

- **Application rollback is not database recovery.**
  - **Application rollback:** redeploy the previous immutable build (see Rollback), with no data
    loss. It's the default response to a bad release.
  - **Database recovery:** restore a backup. It loses data written after the backup point, so it's
    for destructive or corrupting changes only, with incident approval.
- **The current gate stands.** "Confirm Supabase PITR is enabled and the recovery window covers the
  release" is a **mandatory** pre-approval step today. It is **not met**, and this document doesn't
  remove it.

**Proposed amendment (pending owner decision; not in effect).** Replace the PITR line with:

- **either** PITR enabled, covering the release window;
- **or all of the following:**
  1. the latest daily PHYSICAL backup is under 24 hours old, verified on the day;
  2. a passing option-A restore drill within the last 90 days (and after major schema changes);
  3. a logical dump taken immediately before the release migrations, stored encrypted, with its
     restore procedure written down;
  4. the owner's written acceptance of a recovery point of up to about 24 hours for incidents
     unrelated to a release;
  5. a Storage backup in place, or the owner's written acceptance that Storage loss is
     unrecoverable.

**Owner decision required:** adopt this alternative (and accept that recovery point), **or**
keep PITR mandatory and approve its recurring cost: at least about $100/month for 7 days, plus a
Small compute minimum. Neither is assumed here.

**Unknowns** (no figures are invented here):

- restore time for this database;
- production database and Storage sizes;
- the compute size;
- whether `pg_cron`/`pg_net` jobs exist in production;
- how long a logical dump and restore would take;
- the business's acceptable recovery point and recovery time.

## Production deployment order

1. Freeze schema-changing writes and notify the release owner.
2. Verify backup/PITR and the exact release SHA.
3. Confirm successful main-push CI and manually dispatched staging runs for the
   exact SHA.
4. Manually dispatch **Production release** from `main`; enter the exact 40-digit
   SHA twice. The verifier checks that it is the current `main` tip and queries
   GitHub for both successful runs at that same SHA.
5. Approve the protected GitHub `production` Environment. This approval happens
   only after the immutable release-chain verifier succeeds.
6. The workflow reruns the read-only compatibility preflight, then runs
   `npx prisma migrate deploy` once using production-only database credentials.
7. Run `npx prisma migrate status` and the read-only
   `tests/staging/release-invariants.sql` assertion.
8. Apply the rerunnable `prisma/sql/004_storage.sql` and validate its exact policy
   definitions with `tests/staging/storage-invariants.sql`.
9. Build the same immutable SHA with the pinned Vercel CLI (no Vercel credential in
   the build step; `NEXT_PUBLIC_BUILD_SHA` set to the candidate) and deploy it
   **staged** (`--skip-domain`). The workflow records the currently live deployment
   as the rollback target, verifies the staged deployment is this project's READY
   build of the candidate, checks its `/api/health` (healthy, same build SHA)
   through the protection-bypass header, then promotes it explicitly and fails
   unless both `https://syveka.com` and `PROD_URL` point at it and serve a healthy
   build of the candidate SHA. On any failure after the rollback target is recorded,
   the job summary prints the exact `vercel rollback <previous deployment>` command.
10. Run the production smoke checklist. End the write freeze only after it passes.

Required production Environment secrets are `PROD_DATABASE_URL`,
`PROD_DIRECT_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and
`VERCEL_AUTOMATION_BYPASS_SECRET` (the production Vercel project's Protection
Bypass for Automation secret; the release fails closed without it).
Required production Environment variable is `PROD_URL`. The automatically
provided `GITHUB_TOKEN` needs only `contents: read` and `actions: read`.
`PRODUCTION_SUPABASE_PROJECT_REF` and `PRODUCTION_VERCEL_PROJECT_ID` are staging
deny-list variables. Keep all runtime production values in the hosting provider's protected production scope.
Never echo, export to artifacts, or expose any of these values to client bundles.

## Calendar webhook subscription maintenance schedule (QStash)

`ensureWebhookSubscription()` (P0.2) reuses a subscription only while it has more than
12 hours left before expiry. Nothing renews it on a schedule by itself — the only other
caller is the settings-page toggle-on action, which runs once, immediately, and never
again. `src/app/api/v1/jobs/calendar-sync/route.ts` is the recurring maintenance sweep
that keeps enabled calendars' webhook subscriptions (and verification secrets) renewed,
but **the code alone does not create its own trigger** — a QStash recurring schedule
must be registered manually, once per environment, before this is operationally
complete:

- POST destination: `/api/v1/jobs/calendar-sync`
- Cron: `0 */6 * * *` (every 6 hours — comfortably more frequent than the 12-hour
  freshness buffer above, so a subscription is always renewed well before it lapses)
- Initial JSON body: `{}`
- The request must be delivered and signed by QStash (verified via
  `verifyJobRequest`, the same signature check every other `jobs/*` route uses) —
  do not point any other caller at this route.

This is a required pre-deployment operational step, not a code change. **Do not
consider P0.2 operationally complete for an environment until this schedule has
actually been registered against it** — until then, any calendar's webhook
subscription still silently lapses days after a user enables sync, exactly as before
this fix, because nothing will be calling this route on a recurring basis.

## Creator Studio crash-recovery reconciliation schedule (QStash)

`src/app/api/v1/jobs/reconcile-creator-generations/route.ts` (docs/creator-studio.md §16) recovers
stale/abandoned Creator Studio generations after a process crash and repairs the rare
COMPLETED/FAILED-with-stuck-credits edge case — but, like `calendar-sync` above, **the code alone does
not create its own trigger**. A QStash recurring schedule must be registered manually, once per
environment, before this is operationally complete:

- POST destination: `/api/v1/jobs/reconcile-creator-generations`
- Cron: `*/5 * * * *` (every 5 minutes — comfortably more frequent than the 10-minute
  `GENERATING_STALE_MS` threshold, so an abandoned generation is caught soon after it becomes stale)
- Initial JSON body: `{}`
- The request must be delivered and signed by QStash (verified via `verifyJobRequest`, the same
  signature check every other `jobs/*` route uses) — do not point any other caller at this route.

**Do not consider the P0 crash-recovery work in docs/creator-studio.md §16 operationally complete for an
environment until this schedule has actually been registered against it** — until then, a generation
whose process crashes mid-flight stays stuck `GENERATING` with credits `RESERVED` indefinitely, exactly
as before that work, because nothing will be calling this route on a recurring basis.

## Production smoke checklist

- `/api/health` returns HTTP 200 with database and Redis checks `ok`.
- Login starts; a test operator can authenticate and reach the dashboard.
- CRM dashboard KPIs render without cross-tenant counts.
- Contacts and companies list/detail pages load; an authorized staging-like test
  mutation can be created and removed if the production change window permits.
- Deals pipeline and expected stages render.
- Calendar loads; Availability and Booking Types load; a public booking page can
  calculate slots without exposing private calendar data.
- AI chat API returns an authenticated stream and records usage; unauthenticated
  requests return 401.
- Knowledge Base lists documents; upload-intent creation uses a tenant-prefixed
  path; the `documents` bucket is private; an embedding job can reach pgvector.
- RLS and tenant assertions pass, and authenticated/public policies remain absent
  from calendar connections, sync state, booking tokens, reminders, and document
  upload intents.
- Audit logging, queues, email, and error monitoring show no release regression.

## Rollback

Prefer application rollback. Redeploy the previous known-good immutable SHA while
leaving successfully applied additive migrations in place; the migrations are
backward-compatible additions and security constraints. Do not edit
`_prisma_migrations`, drop columns/tables, disable RLS, remove tenant constraints,
or restore a backup as an ad-hoc rollback.

If a migration fails, stop deployment and preserve its logs. Determine whether
PostgreSQL rolled back the statement/transaction. Use `prisma migrate status` and
the migration table to diagnose. Repair with a reviewed additive corrective
migration; use `prisma migrate resolve` only when the database state has been
independently verified and two maintainers approve the exact command.

Restore the database only for confirmed destructive/corrupting changes. That
requires incident/change approval, a maintenance window, stopping application
writes, restoring into an isolated project first, validating tenant/RLS
invariants, and then following the organization's audited recovery procedure.

## Data export and deletion requests (manual runbook)

Status as of 2026-10-04: **operational preparation, not a compliance statement.**

- **No export or deletion tooling exists in the app.** There's no export route or action, and no
  UI or Server Action that deletes an organization or a user account.
- **Every request is handled manually**, by an approved operator, under owner approval.
- **A documented procedure is not a verified deletion capability.** This procedure has never been
  exercised end to end, and `gdpr-erasure` is incomplete (section 5). Report deletion as
  "procedure documented, capability unverified" until a dry run on a disposable non-production
  organization shows zero remaining rows for `<ORG_ID>`, zero objects under `<ORG_ID>/` in all five
  buckets, and the provider steps recorded.
- **Legal review is separate.** It covers which data must be exported or deleted, and which retention
  exceptions apply; this runbook doesn't decide either.

Placeholders used below: `<REQUEST_ID>`, `<ORG_ID>`, `<USER_ID>`, `<CONTACT_ID>`, `<REQUESTER_EMAIL>`,
`<APPROVER>`. Never paste real values or customer content into the repository, PRs or issues.

### 1. Intake and identity/authority verification

1. **Log the request** in the private change record as `<REQUEST_ID>`. Record:
   - the date received and the channel;
   - the request type (export, deletion or both);
   - the scope (individual user, CRM contact, or whole organization);
   - the response deadline.
2. **Verify identity out-of-band.** Use a reply to the account's verified email address, or a
   confirmation from a signed-in session. Never act on an unauthenticated email alone.
3. **Verify authority:**
   - **Organization-wide request:** the requester must be the organization's current `OWNER`. Check
     `organization_members.role` for `<ORG_ID>` and `<USER_ID>` with a read-only query. `org:delete`
     is reserved for `OWNER` in `src/server/auth/permissions.ts`.
   - **A user's own account data:** the requester must be that user.
   - **A CRM contact (a customer's customer):** Syveka acts for the customer organization. Forward
     the request to that organization's owner, and act only on their documented instruction.
4. **Get owner approval** (`<APPROVER>`) before any production read beyond counts, and before any
   write. Record it in the change record.

### 2. What is in scope

| Scope        | Where the data is                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | Every table with `organization_id` (51 models). All of them cascade from `organizations` except `stripe_webhook_events`, which has `organization_id` with no FK and keeps billing event ids and types after deletion. Storage objects under `<ORG_ID>/` in all five private buckets: `documents`, `voice-recordings`, `exports`, `creator-reference-assets`, `creator-generated-media` (`prisma/sql/004_storage.sql`). |
| User account | `users`, plus Supabase Auth's `auth.users`. Deleting the Auth user does **not** remove `public.users`: there's no delete trigger, by design (`prisma/migrations/20260902000000_handle_new_user_email_reconciliation`). See the user-reference table below.                                                                                                                                                             |
| CRM contact  | `contacts`. `activities` and contact tags cascade with it. `deals`, `inbox_threads` and `event_attendees` keep the record but set the contact to null. `calendar_events.contact_id` and `voice_calls.contact_id` have **no FK** and must be handled explicitly. Free text in notes, inbox messages, transcripts and documents may also mention the person; finding those needs a scoped search approved by the owner.  |

**How references to a user behave on deletion:**

| Behavior                                 | Columns                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cascade                                  | `organization_members`, `notifications`, `document_upload_intents`                                                                                                                                                                                                                                                                     |
| Set to null                              | `activities.user_id`, `inbox_threads.assigned_to`, `inbox_messages.approved_by`, `messages.user_id`, `audit_logs.actor_id`, `entitlement_grants` issuer/revoker                                                                                                                                                                        |
| **Plain columns, no FK** (they'd dangle) | `conversations.user_id`, `calendar_connections.user_id`, `availability_schedules.user_id`, `calendar_events.created_by_id`, `event_attendees.user_id`, `workflows.created_by_id`, `prompts.created_by_id`, `creator_profiles.owner_user_id`, and the creator generation, campaign, post and credit-transaction `created_by_id` columns |

### 3. Export (tenant-scoped)

There's no export tool, so this is a manual procedure:

1. Use an approved operator session with a **read-only** database role. Never use the
   service-role key from a laptop.
2. For an organization, export each table with `organization_id = '<ORG_ID>'`. Then export the child
   tables that have no `organization_id` through their parent:
   - `pipeline_stages`, `tags_on_contacts`, `inbox_messages`, `event_attendees`,
     `availability_rules`, `availability_overrides` and `messages`.
   - **Exclude secrets:** encrypted OAuth tokens (`calendar_connections.*_enc`, social account
     tokens), API key hashes, webhook endpoint secrets, `booking_tokens`.
3. For a user, export their `users` row and memberships. Add the rows that reference `<USER_ID>`
   from the table above, limited to the organizations the request covers.
4. **Storage:** download every object under `<ORG_ID>/` in the five buckets. Paths are nested, for
   example `<ORG_ID>/<uuid>/<file>`, so list them recursively.
5. **Package:** use machine-readable files (CSV or JSON per table) plus a manifest of table names,
   row counts and SHA-256 hashes. Encrypt the archive with AES-256 (`age`, or 7-Zip AES-256).
6. **Deliver** through an expiring link. Send the passphrase through a separate channel.
   - **Never store the archive** in the repository, GitHub artifacts, the `exports` bucket without an
     expiry, or unencrypted developer folders.
   - **Delete operator copies** after delivery is confirmed. Record that deletion.
7. **Record** row counts, the archive hash, the delivery time and the copy deletion. Don't record
   content.

### 4. Data held by integrated providers

| Provider                     | Data                                                                                      | Action for export or deletion                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase                     | Database, Storage, Auth users, backups/PITR                                               | Sections 3 and 5. Backups expire on the provider's schedule; see section 6                                                                                                  |
| Vercel                       | Runtime and build logs (may include request paths and ids)                                | Expire under the plan's log retention; no per-record deletion                                                                                                               |
| Upstash Redis                | Short-lived keys: AI action proposals (10 min), rate limits, Vapi tool-call claims (24 h) | Expire automatically                                                                                                                                                        |
| Upstash QStash               | Job payloads (ids, trigger data) until delivered; failed messages in the DLQ              | Purge the DLQ messages for `<ORG_ID>`                                                                                                                                       |
| Anthropic, OpenAI            | Prompts, completions, transcription and embedding inputs                                  | No per-record deletion through this app. Retention follows each provider's current API terms; check them at request time                                                    |
| Vapi                         | Assistants, call logs, recordings, transcripts                                            | `deactivateAssistant` deletes the assistant. Recordings and call logs need deletion in Vapi (API or dashboard), per call                                                    |
| Resend                       | Sent and received email logs                                                              | Per Resend's retention; request deletion through Resend if required                                                                                                         |
| Stripe                       | Customer, subscriptions, invoices, payment methods                                        | Cancel the subscription. Invoices and tax records are usually retained under accounting law (owner and legal decision). Delete the customer object only after that decision |
| Google, Microsoft calendars  | Events the app synced or created in the user's own calendar                               | Revoke the OAuth grant (disconnect). Events in the user's external calendar remain theirs                                                                                   |
| Meta (social accounts)       | Posts already published                                                                   | Delete on Meta per post; disconnecting doesn't unpublish                                                                                                                    |
| fal.ai                       | Creator Studio generation inputs and outputs                                              | Per fal.ai's retention terms                                                                                                                                                |
| Sentry (only once activated) | Scrubbed error events: no messages, no identity                                           | Per the Sentry project's retention; can be deleted per project or issue                                                                                                     |

### 5. Deletion order

**Organization-wide** (after owner approval and any export):

1. **Stop new external side effects.** Do this first: the jobs below still act for a soft-deleted
   organization (see `docs/SECURITY-AUDIT.md`, addendum 2026-10-04).
   - Set every workflow to `is_active = false`.
   - Deactivate voice assistants.
   - Cancel `SCHEDULED` reminders and scheduled creator posts.
   - Disconnect calendars (this revokes the tokens) and social accounts.
2. **Billing:** cancel the Stripe subscription, and decide invoice retention (section 4).
3. **Soft delete:** set `organizations.deleted_at = now()` for `<ORG_ID>`. There's no UI or action
   for this; an approved operator runs a single reviewed `UPDATE`. Sign-in membership lookups,
   provider ingress and #227's notification checks then treat the org as gone.
4. **Grace period:** 30 days (the `gdpr-erasure` function enforces it).
5. **Hard delete.** Don't rely on `supabase/functions/gdpr-erasure` as it is. It has these gaps:
   - **Storage misses most files:** it lists only the top level of `<ORG_ID>/`, up to 1,000
     entries, without recursing, so nested files such as `<ORG_ID>/<uuid>/<file>` aren't removed.
   - **Two buckets missing:** it skips the two Creator Studio buckets.
   - **No error checks:** it ignores errors from both storage removal and row deletion.
   - **Stripe ignored:** it never acts on the Stripe customer it selects.
   - **Deployment unknown:** whether it is deployed to production isn't recorded.

   Until it is fixed in a reviewed PR, do this instead:
   1. **Purge storage manually** with a recursive listing of all five buckets. Record object counts
      before and after.
   2. **Delete the organization row.** In one transaction, an approved operator deletes
      `organizations` where `id = '<ORG_ID>'`. Foreign-key cascades remove the tenant rows.
   3. **Decide** what to do with `stripe_webhook_events` rows for `<ORG_ID>`.

6. **Users:**
   - **Shared users:** a user who belongs to other organizations keeps their account. Only the
     membership was removed, by the cascade.
   - **Account deletion requests:** delete the account only when the user asked for it, and only
     after section 5's individual steps.
7. **Providers:** complete section 4's deletions, and record any provider ticket ids.

**Individual user account:**

1. **Transfer ownership.** If the user is an `OWNER` anywhere, ownership must be transferred
   first. Owners can't be removed (`removeMember`).
2. **Delete or reassign the user's references.** These are the plain columns with no FK, listed in
   section 2:
   - **Delete:** their conversations, calendar connections (revoke tokens first) and availability.
   - **Reassign** workflows and prompts they created, or accept that the creator id dangles. After
     #227, a creator who isn't a member receives no workflow notifications.
3. **Remove memberships.** Notifications cascade on the user delete, and activities, messages and
   audit entries keep the record with a null actor.
4. **Delete the user.** Delete the `public.users` row, then the Supabase Auth user (Auth admin, by
   an approved operator).

**CRM contact (on the customer's instruction):** archiving a contact soft-deletes it. The retention
job `jobs/usage-rollup` hard-deletes soft-deleted contacts, documents and conversations after 30
days. **Whether its QStash schedule is registered in each environment is unverified**; this runbook
documents schedules only for `calendar-sync` and `reconcile-creator-generations`. Without the
schedule, nothing is purged. Also handle `calendar_events` and `voice_calls` rows that reference
`<CONTACT_ID>`, since they have no FK, and any Vapi recordings of those calls.

### 6. Retention exceptions and backups

- **Retention exceptions** (owner and legal decision; record each one):
  - billing and tax records at Stripe;
  - legally required audit evidence;
  - data under a legal hold.
- **Backups:** PITR and backups keep deleted data until their retention window passes.
  - Record when the deleted data will have aged out of backups.
  - Never selectively restore deleted data.
  - If a restore happens for another reason, re-apply the deletion register: the ids deleted under
    each `<REQUEST_ID>`.

### 7. Audit evidence

`audit_logs` cascade away with the organization. Keep the evidence **outside** the database, in the
private change record:

- `<REQUEST_ID>`, the dates, the verification method, and `<APPROVER>`;
- the scope and the operator;
- row and object counts before and after (counts only);
- the export archive hash and the copy deletion;
- provider ticket ids and retention-exception decisions;
- the backup age-out date.

### 8. Tooling gaps and owner approvals

**Gaps, each a separate reviewed change:**

1. An export tool: per-tenant and per-user, read-only, producing an encrypted archive.
2. A fixed `gdpr-erasure`: recursive storage purge across all five buckets, error checks, an
   explicit Stripe decision, and a recorded deployment.
3. A soft-delete action that first stops external side effects (section 5, step 1), and the job
   guards in `docs/SECURITY-AUDIT.md`.
4. User-account deletion that handles the plain user-id columns.
5. A confirmed `usage-rollup` QStash schedule in each environment.

**Needs owner approval every time:**

- any production read beyond counts;
- every write or delete;
- Stripe customer deletion;
- each retention exception;
- each provider deletion request;
- running or deploying `gdpr-erasure`.
