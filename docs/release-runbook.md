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

Production requires a verified backup before approving the GitHub `production` Environment.

- **Option A (point-in-time recovery) is the required default.**
- **Option B is an exception** for narrow releases only. It applies only when every eligibility condition below holds and the owner accepts its risk in writing.
- **Option B-M is an exception for metadata-only migrations; see below.**
- If any condition isn't met, Option A is required.

Whichever option applies, its records go in the private change record before the `production` Environment is approved.

### Option A (default): PITR

- Confirm Supabase PITR is enabled and the recovery window covers the release.
- Create an on-demand logical backup using an approved encrypted destination.
- Record backup time, database project ref, Git SHA, migration status, restore owner, and the tested restore procedure in the private change record.
- Test restore into an isolated non-production project when the backup process or schema has changed.

### Option B (exception): daily physical backup + pre-release logical backup, without PITR

#### Eligibility

All conditions must hold, verified for the exact release SHA against the SHA production currently serves:

1. **No database change.**
   - `git diff --name-only <production-sha> <release-sha> -- prisma` prints nothing: no new or changed migration, `schema.prisma`, or `prisma/sql/*` file.
   - Before approval, the read-only `npx prisma migrate status` against production (the operator preflight below) reports the schema is up to date. If it lists any pending migration, Option B doesn't apply: the release would apply it automatically after approval.
2. **No destructive database operation.** No backfill, bulk update or delete, or manual SQL. The only database writes are the release workflow's existing rerunnable steps, which are unchanged in this release.
3. **A verified application rollback target.** Before approval, the current production deployment (ID or URL) is recorded as the rollback target. `vercel rollback <that deployment> --timeout 5m --yes` restores it; the release also prints this command.

#### Requirements

All are recorded before approval:

4. **Daily backup.** The latest Supabase daily **PHYSICAL** backup is less than 24 hours old when the gate is approved. Record its timestamp.
5. **Pre-release logical backup.**
   - Taken no more than 60 minutes before approving the gate, and after any announced production write freeze.
   - Stored in an approved encrypted destination.
   - Record its UTC timestamp, size, and SHA-256 checksum.
   - Verified readable (`pg_restore --list` succeeds).
   - It is **not** restore-tested.
6. **Release identity.** Record:
   - the exact release SHA;
   - the production SHA it replaces;
   - the previous production deployment (rollback target);
   - a **named rollback owner**, available for the whole release window.
7. **The owner's explicit written risk acceptance.** It must name this release SHA, state each of the following, and acknowledge each risk individually; a general approval is not enough:
   - **PITR is not available** for this release.
   - **Recovery-point window.**
     - For a problem the release itself causes, data written after the logical backup can be lost.
     - For any other incident, recovery falls back to the latest usable daily backup. That is up to about 24 hours of data, or more if a daily backup failed.
   - **No restore has been tested** for either backup, so the recovery time is unknown.
   - **Storage objects** are excluded from database backups. If separate Storage backup coverage isn't verified, Storage loss is unrecoverable.
   - **Confirmation** that the release contains no migrations or schema changes (condition 1).

Option B never applies to a release that changes the schema or migrations. The only exception for such a release is Option B-M below, under its own conditions. Option B doesn't remove the restore-test requirement when the backup process or schema has changed.

### Option B-M (exception): metadata-only migration, without PITR

A narrow exception for a release whose only database change is access-control metadata. It applies only when **every** condition below holds for the exact release SHA and the owner accepts its risk in writing. If any condition isn't met, Option A is required.

#### Eligibility

1. **Metadata-only migrations.**
   - Every pending migration contains only these statements:
     - `ENABLE ROW LEVEL SECURITY` / `DISABLE ROW LEVEL SECURITY`;
     - `CREATE POLICY` / `DROP POLICY`;
     - `GRANT` / `REVOKE`.
   - A PL/pgSQL `DO` block is also permitted when its only effects are the statements listed above, whether it runs them directly or through `EXECUTE`. The block may also read the system catalogs (`SELECT` from `pg_catalog`, for example `pg_roles`), but only to decide whether to run those statements.
   - All other data reads and writes are forbidden, and so is all DDL outside the list above.
   - It contains no `INSERT`, `UPDATE` or `DELETE`, no `DROP TABLE` or `DROP COLUMN`, no `ALTER COLUMN`, no type change, no backfill and no other data rewrite.
   - A reviewer confirms this in writing for the exact release SHA, naming each pending migration reviewed.
2. **A passing restore drill.**
   - It follows `docs/recovery-drill-checklist.md` sections 0–10: logical dump → sanitize → restore into a disposable, isolated Supabase project.
   - It never restores into the active staging project (vendor guidance, Supabase ticket SU-494644).
   - It ran against the current production database, after that database's most recently applied migration.
   - It completed no more than 30 days before the `production` gate is approved.
   - Its recorded results show all of the following:
     - all ten sanitization counts are 0;
     - `tests/staging/release-invariants.sql` passes;
     - the RLS scripts pass;
     - per-table row counts match;
     - the time to restore is recorded;
     - the disposable project is destroyed.

#### Requirements

All are recorded before approval:

3. **Pre-release logical backup.**
   - Taken no more than 60 minutes before approving the gate, and after the production write-freeze announcement.
   - Stored in an approved encrypted destination.
   - Record its UTC timestamp, so the 60-minute limit can be audited.
   - Record its SHA-256 checksum and size.
   - Verified readable (`pg_restore --list` succeeds).
4. **Daily backup.** The latest Supabase daily **PHYSICAL** backup is less than 24 hours old when the gate is approved. Record its timestamp.
5. **Release identity.** Record:
   - the exact release SHA;
   - the production SHA it replaces;
   - the rollback target;
   - a **named rollback owner**, present for the whole release window.
6. **The owner's explicit written risk acceptance.** It must name this release SHA and acknowledge each of the following individually; a general approval is not enough:
   - **PITR is not available** for this release.
   - **Up to about 24 hours of data can be lost** for a problem found late.
   - **Recovery time is measured only by the drill** (condition 2), not by an in-place restore.
   - **Storage objects** are excluded from database backups.
   - **The migration was reviewed as metadata-only** (condition 1).
7. **24-hour post-deploy watch.** Billing, calendar, and `contact.created` workflow errors are watched for 24 hours after the deploy, before the write freeze ends.

#### Limits

- Option B-M never applies to a migration containing anything outside condition 1.
- Option B-M doesn't remove the restore-test requirement. Condition 2 is that requirement.

### All options

- Never store a backup in the repository, Actions artifacts, PRs, or unencrypted developer folders.

Before approval, archive the successful staging workflow URL, compare the release
SHA with the production candidate, run `npm run migrations:check`, and review
every pending migration in the order above. From an approved operator session,
run the compatibility preflight before any write:

```sh
psql "$PROD_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/006_legacy_baseline_preflight.sql
npx prisma migrate status
```

### Read-only outbound preflight (Supabase SQL Editor)

Used by `docs/recovery-drill-runbook.md` (step 2) and `docs/recovery-drill-checklist.md` (section 3) before every recovery drill. It reports whether the database has any outbound-capable
extension, scheduled job, HTTP queue, webhook hook, trigger, foreign server or subscription. It
reads catalogs and counts only.

**Where and how to run it.** In the Supabase dashboard **SQL Editor**, as `postgres`:

- Paste the whole script, with nothing selected, and run it once. The SQL Editor sends it as one
  query string, which PostgreSQL runs as a single transaction, so `set transaction read only`
  and the two `set local` timeouts apply to every statement in it.
- The results panel shows one grid: `section`, `item`, `result`. The three `SET` lines produce no
  grid.
- **Trust the output only if the first rows show** `transaction_read_only = on`,
  `statement_timeout = 15s` and `lock_timeout = 2s`. Otherwise stop: the settings weren't applied.
- **Don't run it statement by statement** (for example `psql -f` with autocommit, or a selected
  part of the script). Each statement is then its own transaction, `SET TRANSACTION` and
  `SET LOCAL` only warn, and the session row shows `transaction_read_only = off`, which the rule
  above treats as a stop.

**What it does:**

- It creates no objects and writes nothing; its settings last only for that transaction.
- It prints counts and statuses only: never job commands, function bodies, URLs, headers or
  customer rows.
- Every `result` is one of:
  - a number, including `0`: counted;
  - `MISSING`: the object is absent;
  - `NO PERMISSION (schema)` or `NO PERMISSION (table)`: present but not readable by this role;
  - a count marked `(RLS-FILTERED)`, where row-level security may hide rows.

```sql
-- Restore-drill preflight for the Supabase SQL Editor (read-only).
-- Run the whole script at once. Output: one grid of (section, item, result).
-- Prints counts and statuses only: never job commands, function bodies, URLs,
-- headers, request or response bodies, server options, connection strings or
-- customer rows. Creates no objects; the settings below last only for this
-- transaction.
-- result values: a number (including 0) = counted; MISSING = object absent;
-- NO PERMISSION (schema|table) = present but not readable by this role;
-- "(RLS-FILTERED)" = row-level security may hide rows, so the count may be low.
-- If the session rows don't show transaction_read_only = on and the timeouts
-- below, the settings weren't applied: stop and report.
set transaction read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';

with
me as (
  select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user
),
obj(ord, name, sch, rel) as (
  values (30, 'cron.job', 'cron', 'job'),
         (31, 'cron.job_run_details', 'cron', 'job_run_details'),
         (32, 'net.http_request_queue', 'net', 'http_request_queue'),
         (33, 'net._http_response', 'net', '_http_response'),
         (34, 'supabase_functions.hooks', 'supabase_functions', 'hooks')
),
o as (
  -- Catalog lookup: unlike to_regclass, it doesn't fail without schema USAGE.
  select obj.ord, obj.name,
         case when c.oid is null then 'MISSING'
              when not has_schema_privilege(n.oid, 'USAGE') then 'NO PERMISSION (schema)'
              when not has_table_privilege(c.oid, 'SELECT') then 'NO PERMISSION (table)'
              else 'readable' end as access,
         case when c.oid is null then null
              when not c.relrowsecurity then 'all rows'
              when me.rolsuper or me.rolbypassrls then 'all rows (bypasses RLS)'
              when pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity
                then 'all rows (owner)'
              else 'RLS-FILTERED' end as visibility
  from obj
  cross join me
  left join pg_namespace n on n.nspname = obj.sch
  left join pg_class c on c.relnamespace = n.oid and c.relname = obj.rel
),
metric(ord, obj, item, q) as (
  values
    (40, 'cron.job', 'cron_jobs_visible', 'select count(*) as n from cron.job'),
    (41, 'cron.job', 'cron_jobs_active', 'select count(*) as n from cron.job where active'),
    (42, 'cron.job', 'active_jobs_with_direct_http_call',
     $q$select count(*) as n from cron.job where active and command ~* '(net\.http_|http_(get|post|put|patch|delete|request)\s*\(|dblink)'$q$),
    (43, 'cron.job_run_details', 'cron_runs_last_7_days',
     $q$select count(*) as n from cron.job_run_details where start_time > now() - interval '7 days'$q$),
    (44, 'cron.job_run_details', 'cron_runs_failed_last_7_days',
     $q$select count(*) as n from cron.job_run_details where start_time > now() - interval '7 days' and status = 'failed'$q$),
    (50, 'net.http_request_queue', 'pg_net_requests_pending', 'select count(*) as n from net.http_request_queue'),
    (51, 'net._http_response', 'pg_net_responses_retained', 'select count(*) as n from net._http_response'),
    (52, 'net._http_response', 'pg_net_responses_last_24h',
     $q$select count(*) as n from net._http_response where created > now() - interval '24 hours'$q$),
    (60, 'supabase_functions.hooks', 'webhook_hook_rows', 'select count(*) as n from supabase_functions.hooks')
),
http_fn as (
  -- Bodies are only pattern-matched here; they are never selected for output.
  select p.oid, n.nspname, p.proname,
         p.prosrc ~* '(net\.http_|http_(get|post|put|patch|delete|request)\s*\(|dblink)' as calls_out
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
),
result(ord, section, item, result) as (
  select 1, 'session', 'transaction_read_only', current_setting('transaction_read_only')
  union all select 2, 'session', 'statement_timeout', current_setting('statement_timeout')
  union all select 3, 'session', 'lock_timeout', current_setting('lock_timeout')
  union all select 4, 'session', 'checked_as', current_user::text
  union all select 5, 'session', 'checked_at_utc', to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI')

  union all
  select x.ord, 'extension', x.name,
         case when e.extname is null then 'not installed' else 'INSTALLED' end
  from (values (10, 'pg_cron'), (11, 'pg_net'), (12, 'http'), (13, 'dblink'),
               (14, 'postgres_fdw'), (15, 'wrappers')) as x(ord, name)
  left join pg_extension e on e.extname = x.name
  union all
  select 16, 'extension', 'extensions_installed_total', count(*)::text from pg_extension

  union all
  select o.ord, 'object', o.name,
         case when o.access = 'readable' then 'readable, ' || o.visibility else o.access end
  from o

  union all
  -- query_to_xml runs only in the 'readable' branch, so a missing or
  -- unreadable table yields its status instead of an error.
  select m.ord, 'count', m.item,
         case when o.access <> 'readable' then o.access
              else (xpath('/row/n/text()', query_to_xml(m.q, false, true, '')))[1]::text
                   || case when o.visibility = 'RLS-FILTERED' then ' (RLS-FILTERED)' else '' end
         end
  from metric m
  join o on o.name = m.obj

  union all
  select 70, 'count', 'outbound_triggers', count(*)::text
  from pg_trigger t join http_fn f on f.oid = t.tgfoid
  where not t.tgisinternal
    and ((f.nspname = 'supabase_functions' and f.proname = 'http_request') or f.calls_out)
  union all
  select 71, 'count', 'outbound_triggers_enabled', count(*)::text
  from pg_trigger t join http_fn f on f.oid = t.tgfoid
  where not t.tgisinternal and t.tgenabled <> 'D'
    and ((f.nspname = 'supabase_functions' and f.proname = 'http_request') or f.calls_out)
  union all
  select 72, 'count', 'other_functions_with_direct_http_call', count(*)::text
  from http_fn f
  where f.calls_out
    and f.nspname not in ('pg_catalog', 'information_schema', 'net', 'cron', 'supabase_functions')
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e')

  union all select 80, 'count', 'foreign_data_wrappers', (select count(*) from pg_foreign_data_wrapper)::text
  union all select 81, 'count', 'foreign_servers', (select count(*) from pg_foreign_server)::text
  union all select 82, 'count', 'foreign_tables', (select count(*) from pg_foreign_table)::text
  union all
  select 83, 'count', 'subscriptions',
         case when has_column_privilege('pg_catalog.pg_subscription', 'subenabled', 'SELECT')
              then (xpath('/row/n/text()', query_to_xml('select count(*) as n from pg_catalog.pg_subscription', false, true, '')))[1]::text
              else 'NO PERMISSION (table)' end
  union all
  select 84, 'count', 'subscriptions_enabled',
         case when has_column_privilege('pg_catalog.pg_subscription', 'subenabled', 'SELECT')
              then (xpath('/row/n/text()', query_to_xml('select count(*) as n from pg_catalog.pg_subscription where subenabled', false, true, '')))[1]::text
              else 'NO PERMISSION (table)' end
)
select section, item, result
from result
order by ord;
```

**A clean result:**

- all six extensions `not installed`;
- all five objects `MISSING`, so every count that depends on them is `MISSING` too;
- `outbound_triggers`, `outbound_triggers_enabled`, `foreign_data_wrappers`, `foreign_servers`,
  `foreign_tables`, `subscriptions` and `subscriptions_enabled` all `0`;
- `other_functions_with_direct_http_call` `0`, **or** `1` when the identification query below
  shows that the only match is Supabase's own `extensions.grant_pg_net_access()` helper (see
  "Known result" below);
- no `NO PERMISSION` or `RLS-FILTERED`.

Anything else is an outbound-capable item: stop the drill and report it.

**What it can't establish:**

- **A backup's state:** it shows the database at that moment, not a historical snapshot.
- **Indirect outbound calls**, through dynamic SQL or helpers its text match doesn't catch.
- **Restorability:** anything about a backup's integrity or whether it can be restored.

**Identifying a matching function.** Run this, the same way, if
`other_functions_with_direct_http_call` isn't `0`. It returns names, language, references, match
statistics and an MD5 of the body. It never returns the body itself, and it calls nothing.

```sql
-- Identify the function(s) counted as other_functions_with_direct_http_call.
-- Read-only. Returns names, language, references and match statistics only:
-- never the function body, URLs, credentials or customer data. Calls nothing.
-- body_md5 lets the body be compared with Supabase's published definitions
-- without revealing it.
set transaction read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';

with f as (
  -- Same filter as the preflight's other_functions_with_direct_http_call.
  select p.oid, n.nspname, p.proname, l.lanname, p.prorettype, p.proowner, p.prosecdef, p.prosrc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname not in ('pg_catalog', 'information_schema', 'net', 'cron', 'supabase_functions')
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and p.prosrc ~* '(net\.http_|http_(get|post|put|patch|delete|request)\s*\(|dblink)'
)
select
  current_setting('transaction_read_only') as read_only,
  f.nspname as schema,
  f.proname as function_name,
  f.lanname as language,
  format_type(f.prorettype, null) as returns,
  pg_get_userbyid(f.proowner) as owner,
  f.prosecdef as security_definer,
  (select count(*) from pg_trigger t
    where t.tgfoid = f.oid and not t.tgisinternal) as table_triggers,
  coalesce((select string_agg(e.evtname || ' on ' || e.evtevent
                              || case e.evtenabled when 'D' then ' (disabled)' else ' (enabled)' end,
                              '; ' order by e.evtname)
            from pg_event_trigger e where e.evtfoid = f.oid), 'none') as event_triggers,
  (select count(*) from regexp_matches(f.prosrc, 'net\.http_', 'gi')) as net_http_mentions,
  (select count(*) from regexp_matches(f.prosrc, 'function\s+net\.http_', 'gi')) as net_http_in_grant_alter_ddl,
  (select count(*) from regexp_matches(f.prosrc, '(^|[^a-z_.])http_(get|post|put|patch|delete|request)\s*\(', 'gi'))
    as unqualified_http_calls,
  (select count(*) from regexp_matches(f.prosrc, 'dblink', 'gi')) as dblink_mentions,
  (select count(*) from regexp_matches(f.prosrc, '\mexecute\M(?!\s+on\M)', 'gi')) as dynamic_execute_statements,
  md5(f.prosrc) as body_md5
from f
order by schema, function_name;
```

**Known result: `extensions.grant_pg_net_access()`.** The owner-run production preflight
(2026-10-04 18:18 UTC) reported `other_functions_with_direct_http_call = 1`; every other item was
clean. The identification query showed:

- `extensions.grant_pg_net_access()`, `plpgsql`, returns `event_trigger`, owner `supabase_admin`;
- no table triggers; one event trigger, `issue_pg_net_access`;
- 8 `net.http_*` mentions, all 8 inside permission statements; no direct HTTP calls, `dblink` or
  dynamic `EXECUTE`;
- `body_md5 = 2ee4e6920eeba3068bcfa838105352e2`.

That MD5 is an exact match for a Supabase-authored definition in `supabase/postgres` (for example
[`88de835` schema-15.sql L271](https://github.com/supabase/postgres/blob/88de835f0eb1a8a7299fa2696026769fe27b9943/migrations/schema-15.sql#L271)).
That definition only creates the `supabase_functions_admin` role if missing and grants or revokes
usage on `net.http_get` and `net.http_post` when `pg_net` is created; it makes no HTTP call. So
this finding is **explained, not outbound code**. Treat it as clean only when the identification
query again returns exactly this one function with this `body_md5`. A different function, a
different hash, or any direct call is a stop. Whether this exact definition is a Supabase hosted
release was not established.

**Tested** only on throwaway local Postgres containers, never against staging or production:

- **2026-10-04 (Postgres 17, no network):** sent as one query string, as the SQL Editor does.
  Every absent object reported `MISSING`; as a non-superuser it distinguished schema denial,
  table denial, `0`, `RLS-FILTERED` and `MISSING`; settings reverted after the run and catalog
  object counts were unchanged; a write was rejected; no planted URL, command or function text
  appeared in the output.
- **2026-10-18 (pgvector Postgres 15, this repository's migrations applied):** as one query
  string, the session rows showed `on`, `15s` and `2s`, every absent object reported `MISSING`,
  every count was `0`, and the identification query returned no rows. A write after
  `set transaction read only` in one query string was rejected. Run statement by statement
  (`psql -f`), the session row showed `transaction_read_only = off`, so the stop rule above
  catches it.

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

## Nightly usage rollup and retention purge schedule (QStash)

`src/app/api/v1/jobs/usage-rollup/route.ts` is the nightly job that **permanently deletes
soft-deleted contacts, documents and conversations older than 30 days** (the GDPR retention
promise, §13.3) and creates the in-app 80%-of-quota notifications (§15.6). Its own header says it runs from a
QStash cron, but — like `calendar-sync` and `reconcile-creator-generations` above — **the code
alone does not create its own trigger**, and nothing else enqueues it. A QStash recurring schedule
must be registered manually, once per environment:

- POST destination: `/api/v1/jobs/usage-rollup`
- Cron: `0 2 * * *` (the schedule in the route header; QStash evaluates cron in UTC by default)
- Initial JSON body: `{}` (the route ignores the body; only the QStash signature over it matters)
- The request must be delivered and signed by QStash (verified via `verifyJobRequest`, the same
  signature check every other `jobs/*` route uses) — do not point any other caller at this route.

**Until this schedule is registered for an environment, soft-deleted personal data is never
purged there and no quota notifications are created** — silently, because nothing calls this route. To
check an environment, look for this destination in the QStash console's Schedules list; its last
successful delivery should be under 24 hours old.

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
