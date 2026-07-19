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
   database it verifies all baseline tables and performs no table DDL. It rejects
   partially provisioned databases.
2. The eight published feature/security migrations run unchanged.
3. `20260719000000_initial_security_baseline` additively tracks the original
   extensions, functions, search indexes, and base RLS setup. Existing policies
   are preserved, missing expected policies are added, and authenticated/public
   policies on server-only tables abort the migration.
4. Supabase Storage remains an explicit compatibility step because plain
   PostgreSQL has no `storage` schema. `prisma/sql/004_storage.sql` is rerunnable.

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

## Staging release validation

1. Create a backup or verify Supabase staging PITR before the first migration.
2. Open **Actions -> Staging release validation -> Run workflow** on the exact
   commit under review.
3. Enter the staging Supabase project ref. The workflow rejects a mismatch, a
   production project-ref match, or a production Vercel-project match.
4. The workflow installs dependencies; runs formatting, i18n, lint, typecheck,
   tests, build, Prisma validation, migration-history validation, and the
   production dependency audit.
5. It runs `prisma migrate deploy` against staging before application deployment,
   then `prisma migrate status`.
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
document/storage configuration check. CI intentionally reruns only the deprecated
Calendar/Booking compatibility wrapper to prove its documented idempotency.

## Production preflight and backup

Production requires a verified backup before approving the GitHub `production`
Environment:

- Confirm Supabase PITR is enabled and the recovery window covers the release.
- Create an on-demand logical backup using an approved encrypted destination.
- Record backup time, database project ref, Git SHA, migration status, restore
  owner, and the tested restore procedure in the private change record.
- Test restore into an isolated non-production project when the backup process or
  schema has changed.
- Never store a backup in the repository, Actions artifacts, PRs, or unencrypted
  developer folders.

Before approval, archive the successful staging workflow URL, compare the release
SHA with the production candidate, run `npm run migrations:check`, inspect
`npx prisma migrate status` with production-scoped credentials through an approved
operator session, and review every pending migration in the order above.

## Production deployment order

1. Freeze schema-changing writes and notify the release owner.
2. Verify backup/PITR and the exact release SHA.
3. Confirm the staging workflow for that SHA passed.
4. Approve the protected GitHub `production` Environment only after CI succeeds.
5. Run `npx prisma migrate deploy` once using `PROD_DIRECT_URL`.
6. Run `npx prisma migrate status` and the read-only
   `tests/staging/release-invariants.sql` assertion.
7. Apply `prisma/sql/004_storage.sql` only if storage has not been provisioned or
   its rerunnable compatibility check is part of the release procedure.
8. Deploy the application for the same immutable SHA.
9. Run the production smoke checklist. End the write freeze only after it passes.

Required production Environment secrets are `PROD_DATABASE_URL`,
`PROD_DIRECT_URL`, and `VERCEL_TOKEN`. Required variables are `PROD_URL`,
`PRODUCTION_SUPABASE_PROJECT_REF`, and `PRODUCTION_VERCEL_PROJECT_ID`. Keep all
runtime production values in the hosting provider's protected production scope.
Never echo, export to artifacts, or expose any of these values to client bundles.

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
