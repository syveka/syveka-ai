# Recovery drill: offline sanitization (§5) and disposable restore (§6/§7)

Companion scripts for `docs/recovery-drill-checklist.md` and `docs/recovery-drill-runbook.md`.

**Status:** validated on **synthetic data only**, in local network-isolated containers. They have
never run on real data or against a remote database. A real run needs the owner's separate,
explicit authorization for each of §5, §6 and §10.

The §4 dump script is not in this repository. The operator keeps it outside version control (it is
machine-specific); the validated copy has SHA-256 `dd5f2a2fd16f833e…`. These scripts consume what
it writes: `roles-<TS>.sql`, `syveka-<prefix>-<TS>.dump` and `SHA256SUMS-<TS>.txt`.

## Files

| File                       | Role                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s5-sanitize-offline.sh`   | §5. Restores the raw dump into a throwaway local container (`--network none`), sanitizes it, verifies it, and writes the sanitized archives             |
| `s6-restore-disposable.sh` | §6/§7. Restores the sanitized archives into an **empty** disposable project in one transaction, then verifies checks, row counts, grants and migrations |
| `sanitize.sql`             | The sanitization statements (one transaction)                                                                                                           |
| `sanitize-checks.sql`      | Forbidden-data counts, one line per check                                                                                                               |
| `expected-checks.txt`      | The checks that must appear, and what passes                                                                                                            |
| `rowcounts.sql`            | Per-table row counts of everything a restore carries                                                                                                    |
| `privileges.sql`           | Grant fingerprint of the public schema (grants to roles other than the owner)                                                                           |
| `destination-prelude.sql`  | First statements of the restore: clears the destination's own default privileges in `public`                                                            |
| `lib.sh`                   | Shared text helpers: check validator, archive-list filters, extension detection                                                                         |
| `rehearsal/rehearse.sh`    | Synthetic end-to-end rehearsal with negative controls (needs Docker and two local images)                                                               |
| `rehearsal/selftest.sh`    | Offline self-test of `lib.sh` (also run by `tests/unit/recovery-drill-scripts.test.ts`)                                                                 |
| `rehearsal/seed-*.sql`     | Synthetic, production-shaped fake data and hosted-Auth/Storage approximations                                                                           |

## Three separate zones

1. **Production source (§3–§4):** read-only, owner-run, outside this directory.
2. **Offline sanitization (§5, `s5`):** no network and no credentials.
   - One `pgvector/pgvector:pg17` container, `--network none`, no published ports, no bind mounts,
     memory-capped, removed on exit.
   - Files move only as byte streams over `docker exec -i`; nothing is mounted.
   - The raw dump is restored whole into an empty server, including the dump's own `auth` and
     `storage` definitions and its roles file (no passwords), so the source shape is kept exactly.
3. **Disposable destination (§6/§7, `s6`):** the drill project only.
   - In remote mode, one `postgres:17` client container is the only thing with network access, and
     it receives sanitized archives only.
   - Host, user and password are typed at prompts, never passed as arguments.

## What is sanitized (`s5`)

Derived from `prisma/schema.prisma` at the drill commit and the runbook's side-effect inventory.
Every check must report exactly once and be `0`; a missing, duplicated, unknown or non-zero check,
or any SQL error, stops `s5` before a sanitized archive exists.

| Check                                      | Neutralized                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–10 (the runbook's §5 table)              | calendar and Meta tokens, webhook endpoints, active workflows, scheduled reminders, scheduled or publishing posts, Stripe ids, Vapi assistants and numbers, pending invitations, live booking tokens |
| `active_api_keys`                          | every API key revoked (`revoked_at`)                                                                                                                                                                 |
| `calendar_push_channels`                   | calendar push-channel ids and verification secret hashes                                                                                                                                             |
| `voice_recording_urls`                     | provider-hosted call-recording URLs                                                                                                                                                                  |
| `voice_transfer_numbers`                   | call-transfer phone numbers                                                                                                                                                                          |
| `auth_user_secrets`                        | password hashes and one-time tokens on `auth.users` (set to empty); fails if `encrypted_password` is absent                                                                                          |
| `auth_sessions` … `auth_saml_relay_states` | sessions, refresh tokens, MFA factors (TOTP secrets), challenges, AMR claims, one-time tokens, flow state (provider tokens), SAML relay state: deleted                                               |
| `auth_unlisted_tables_with_rows`           | any other `auth` table with rows (a newer Auth version) fails the run                                                                                                                                |

**Identities are kept, credentials are not.** `auth.users` rows and `auth.identities` are the
relationships the restored tenants need (`public.users.id = auth.users.id`; identities link a user
to a sign-in method). Only their secret columns are emptied. Sessions, tokens and MFA secrets are
credentials and are deleted. Email addresses and other personal data are **not** anonymized: the
destination is a disposable, owner-only project.

## What is restored (`s6`) and in which order

One `psql --single-transaction` run. Any error rolls back everything, and the destination stays
exactly as it was (rehearsed: stage E).

1. `destination-prelude.sql`: clears the destination's schema-level default privileges for the
   restoring role in `public`. pg_dump writes each object's grants relative to the built-in
   defaults, so a grant the destination's own defaults add at `CREATE` time would survive and widen
   access. The rehearsal caught exactly this: `anon` gained `TRUNCATE` on `business_dna`.
2. Missing extensions the archive references (`vector`, `pg_trgm`, `pgcrypto`, `uuid-ossp`), created
   in the schema the archive qualifies them with. An extension already installed in another schema
   stops the run.
3. `public` pre-data (`--no-owner`: owners become the connecting role; grants are kept).
4. **Data only** for `auth.users`, `auth.identities`, `storage.buckets`, `storage.objects`, parents
   first. The archive lists `identities` before `users`, which broke the foreign key in the
   rehearsal. Their definitions are **never** restored: the destination's Auth and Storage
   services own those schemas. If the destination's columns differ from the source's, the load
   fails and rolls back.
5. `public` data, then post-data (constraints, indexes, policies, triggers, grants, `postgres`'s
   default privileges). Other roles' default privileges in `public` (for example
   `supabase_admin`'s) are skipped and recorded: the platform sets them.
6. The application's `on_auth_user_created` trigger on `auth.users`, after the data, so it does not
   fire for restored rows.

**Not restored:** the `public` schema object, its comment and grants (the destination's own stay);
every other `auth` table; every other `storage` table; the roles file (the destination has the
platform roles; a grant to a missing role fails the transaction).

**Before any write**, the destination must prove it is the expected empty target: server version
`17.11*` (production is `17.6`), database `postgres`, no relation in `public`, no
`_prisma_migrations`, no Auth users, no Storage rows. Otherwise `s6` stops.

**After the restore:** all checks `0`; row counts identical to the sanitized source for every
carried table; the grant fingerprint identical; `on_auth_user_created` present; the migration
history preserved with no unfinished rows; and **exactly** `20261014000000_secure_prisma_migrations_table`
pending at this commit. `s6` does not apply it. Applying it to the destination (`npx prisma migrate
deploy` against the disposable project only) is a separate, separately authorized step, followed by
`tests/staging/release-invariants.sql` and the RLS scripts.

## Storage: coverage and exclusions

- **Covered:** the database metadata rows `storage.buckets` and `storage.objects`, restored as data
  (or skipped with `--without-storage-metadata`, recorded in the evidence).
- **Not covered:** the object **contents** (the files). Database dumps never contain them, and no
  Storage backup copy exists today (`docs/recovery-drill-runbook.md`). Restored `storage.objects`
  rows and `storage_path` columns therefore point at files that do not exist in the destination.
- How Storage recovery is handled remains an **open owner decision**. These scripts neither accept
  nor waive that risk.

## Destination configuration checks (not database checks)

These scripts check database contents only. The disposable project's **configuration** is checked
by the owner in the Supabase dashboard (§1), separately, before §6:

- Auth: signups off, manual linking off, anonymous sign-ins off;
- outbound email: the Email provider and SMTP (with the Email provider enabled and no custom SMTP,
  the built-in sender is active, so outbound-email isolation is **not** established);
- Auth hooks (none registered), Edge Functions (none), Database Webhooks, Cron, Vault secrets;
- integrations: GitHub, Vercel, QStash schedules;
- network restrictions: the operator's current IP only.

## Synthetic rehearsal

```bash
bash scripts/recovery-drill/rehearsal/selftest.sh               # offline, seconds
REHEARSE_ATOMIC=1 bash scripts/recovery-drill/rehearsal/rehearse.sh <empty-work-dir>
```

It needs `public.ecr.aws/supabase/postgres:17.6.1.167` and `pgvector/pgvector:pg17` locally (it
never pulls), about 1 GB of free RAM, and one container at a time.

| Stage | Proves                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | A production-shaped source: the 31 migrations production has applied, Prisma's history, the 2026-10-21 manual RLS remediation without a history row, Auth/Storage rows and a `SYNTHETIC-SECRET` value in every column the drill must neutralize. Dumped with the §4 options as `postgres`                                                                                                         |
| B     | `s5` passes; every check detects its synthetic value **before** sanitizing; all are 0 after; identities are kept                                                                                                                                                                                                                                                                                  |
| C     | Sabotaged copies of the scripts stop `s5` without writing archives: a missing sanitization statement, a SQL error in the checks, a check missing from the output                                                                                                                                                                                                                                  |
| D     | No marker survives in the sanitized archives. `s6` refuses a wrong-version target and a non-empty target before any write. A positive restore matches checks, row counts and grants, with exactly the expected migration pending. The release invariants fail while it is pending; the migration is applied locally, as Prisma records it; the invariants then pass and the history is up to date |
| E     | A restore that fails mid-way (a destination Auth column missing) rolls back and leaves the destination empty                                                                                                                                                                                                                                                                                      |

## What the local rehearsal cannot prove

- **Hosted Auth and Storage schemas.** The local image lacks most hosted Auth and Storage tables;
  the rehearsal uses minimal approximations (`rehearsal/seed-auth-extras.sql`). Whether production
  and the drill project have compatible `auth.users`, `auth.identities`, `storage.buckets` and
  `storage.objects` columns is only known at the real §6 run (a mismatch fails and rolls back).
- **Hosted privileges for `postgres`.** Hosted Supabase (supautils) decides whether `postgres` may
  create extensions, alter its default privileges, insert into `auth`/`storage` tables and create a
  trigger on `auth.users`. The local image allowed all of them; the hosted project may not.
- **The real §4 dump.** It is taken through the Supavisor session pooler with a `postgres:17`
  client; the rehearsal dumps inside the container. Whether the pooler honours the read-only
  `PGOPTIONS` is still unknown.
- **Real data.** Volumes, time to restore at real size, edge cases (several identities per user,
  unusual statuses) and real encrypted values are untested. The marker scan only works for
  synthetic data.
- **`prisma migrate deploy` itself.** The rehearsal applies the migration SQL and records the
  history row the way Prisma does; it does not run the Prisma CLI.
- **The RLS scripts** (`scripts/ci/run-rls-check.sh`) need host tools and a network path, so they
  are not part of the rehearsal. They run against the disposable project in §7.
- **Destination configuration** (the section above) and **Storage object contents**.
