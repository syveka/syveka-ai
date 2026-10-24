# Recovery drill: offline sanitization (§5) and disposable restore (§6/§7)

Companion scripts for `docs/recovery-drill-checklist.md` and `docs/recovery-drill-runbook.md`.

**Status:**

- Validated on **synthetic data only**, in local network-isolated containers. The scripts have never
  run on real data or against a remote database.
- **The real drill is not ready.** The open blockers are listed at the end of this file.
- A real run needs the owner's separate, explicit authorization for each of §5, §6 and §10.

**The §4 dump script is not in this repository.** It exists and is validated (SHA-256
`dd5f2a2fd16f833e…`), but the operator keeps it outside version control because it is
machine-specific. These scripts consume what it writes: `roles-<TS>.sql`, `syveka-<prefix>-<TS>.dump`
and `SHA256SUMS-<TS>.txt`.

## Files

| File                                      | Role                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s5-sanitize-offline.sh`                  | §5. Restores the raw dump into a throwaway local container (`--network none`), sanitizes, verifies, scans, and only then releases the sanitized archives |
| `s6-restore-disposable.sh`                | §6/§7. Checks the target identity, refuses a non-empty destination, restores in one transaction, then verifies                                           |
| `sanitize.sql`                            | Sanitization statements (one transaction)                                                                                                                |
| `scrub-functions.sql`                     | Session-local scrub and detection functions, shared by `sanitize.sql` and the checks                                                                     |
| `sanitize-checks.sql`                     | Forbidden-data counts, one line per check                                                                                                                |
| `expected-checks.txt`                     | The checks that must appear, and what passes                                                                                                             |
| `secret-patterns.ere`, `secret-query.ere` | The same secret formats as GNU ERE, for scanning the archives' plain-text rendering                                                                      |
| `rowcounts.sql`, `privileges.sql`         | Row counts, and the grant fingerprint (object grants plus `postgres`'s public default privileges)                                                        |
| `destination-prelude.sql`                 | First statements of the restore: clears the destination's own default privileges in `public`                                                             |
| `lib.sh`                                  | Shared helpers: check validator, archive-list filters, extension detection, remote target identity                                                       |
| `rehearsal/`                              | Synthetic seed, the end-to-end rehearsal (`rehearse.sh`) and the offline self-test (`selftest.sh`)                                                       |

## Three separate zones

1. **Production source (§3–§4):** read-only, owner-run, outside this directory.
2. **Offline sanitization (§5, `s5`):** no network and no credentials.
   - One `pgvector/pgvector:pg17` container, `--network none`, no published ports, no bind mounts,
     memory-capped, removed on exit.
   - Files move only as byte streams over `docker exec -i`.
   - The raw dump is restored whole into an empty server, with the dump's own `auth`/`storage`
     definitions and its roles file (no passwords).
   - The sanitized archives are written **inside** the container, verified and scanned there, and
     copied out only if everything passes. A failed run releases nothing.
3. **Disposable destination (§6/§7, `s6`):** the drill project only.
   - In remote mode, one `postgres:17` client container is the only thing with network access, and
     it receives sanitized archives only.

## What is sanitized (`s5`), and what is not

This is **credential and outbound-side-effect removal, not anonymization.**

Every check must report exactly once and be `0`. A missing, duplicated, unknown or non-zero check, a
SQL error, or a secret-format hit in the archive scan stops `s5` before anything is released.

| Check(s)                                         | Neutralized                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–10 (the runbook's §5 table)                    | Calendar and Meta tokens, webhook endpoints, active workflows, scheduled reminders, scheduled or publishing posts, Stripe ids, Vapi assistants and numbers, pending invitations, live booking tokens                                                                                                                                                                                                                                                                                            |
| `active_api_keys`                                | Every API key revoked                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `calendar_push_channels`                         | Push-channel ids and verification secret hashes                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `voice_recording_urls`, `voice_transfer_numbers` | Provider-hosted recording URLs; call-transfer numbers                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `integration_error_texts`                        | `last_error` of calendar and social connections (provider responses can echo tokens in no fixed format)                                                                                                                                                                                                                                                                                                                                                                                         |
| `workflow_email_recipients`                      | The `to` of every `email.send` workflow step, at any depth, rewritten to `redacted@drill.invalid`. Checked by an independent jsonpath query, not the scrubber's own detector                                                                                                                                                                                                                                                                                                                    |
| `json_sensitive_values`                          | In **every** JSON column of every carried table: credential-named keys (`*token*`, `*secret*`, `*password*`, `api_key`, `authorization`, `cookie`, `credential`, `private_key`, `webhook_url`, `callback_url`, …) at any depth, plus the string rules below. This covers `auth.users.raw_user_meta_data`/`raw_app_meta_data`, `auth.identities.identity_data`, `storage.objects.metadata`, `organizations.settings`, `workflows.steps`/`trigger`, `voice_assistants.enabled_tools` and the rest |
| `text_secret_patterns`                           | In **every** text, varchar and text-array column of every carried table: known secret formats (Stripe, Stripe webhook, Anthropic, OpenAI, Slack, GitHub, AWS, Google API and OAuth, Meta, Resend, JWT, private keys), URLs with embedded `user:password@`, and token/signature query parameters (`token=`, `sig=`, `X-Amz-Signature=`, …)                                                                                                                                                       |
| `auth_user_secrets`                              | Password hashes and one-time tokens on `auth.users`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `auth_sessions` … `auth_saml_relay_states`       | Sessions, refresh tokens, MFA factors (TOTP secrets), challenges, AMR claims, one-time tokens, flow state (provider tokens), SAML relay state: deleted                                                                                                                                                                                                                                                                                                                                          |
| `auth_unlisted_tables_with_rows`                 | Any other `auth` table with rows fails the run                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

"Carried tables" means every table in `public`, plus `auth.users`, `auth.identities`,
`storage.buckets` and `storage.objects`: everything a restore can carry.

**Defense in depth:** after the database checks pass, `s5` renders both archives to plain text inside
the container and greps them with `secret-patterns.ere`/`secret-query.ere`. Any hit stops the run
with nothing released (rehearsal control C7).

### Personal data retained (intentionally)

The destination is a disposable, owner-only project, and the drill's purpose is a faithful restore,
so this personal data is **kept**:

- names and email addresses: `auth.users` (including `raw_user_meta_data.full_name`),
  `auth.identities`, `users`, `contacts`, `invitations`, bookings' guests, event attendees;
- phone numbers: contacts, bookings, `voice_calls.caller_number`;
- conversation content: chat messages, voice transcripts and summaries, inbox messages;
- documents and document chunks, Business DNA, calendar events (titles, descriptions, locations),
  audit-log `before`/`after` values, Creator Studio prompts and captions;
- Storage object paths (the files themselves are not included; see Storage below).

Identities (`auth.users` rows, `auth.identities`) are kept because the restored tenants depend on
them (`public.users.id = auth.users.id`). Only their secret columns and credential-named JSON keys are
removed.

### Coverage limits

- **Free text.** A credential written in no recognizable format (for example a password pasted into
  a chat message, a document or a voice transcript) cannot be detected. The checks prove that the
  **known formats and credential-named JSON keys** are gone, not that every secret is.
- **Encrypted columns** (`*_token_enc`) are cleared. Values encrypted elsewhere, in a format the
  patterns do not know, would pass unnoticed.
- **Key-name matching is heuristic.** A credential under an innocuous JSON key with a value in an
  unknown format is missed. Conversely, harmless values under credential-like keys are redacted too
  (for example `tokenExpiresAt`).
- **Workflow configuration beyond `email.send`.** Today's step types are `condition`, `ai.generate`,
  `email.send`, `crm.create_activity`, `notify.member` and `wait.duration`. Recipients of other
  outbound step types added later are covered only by the generic JSON rules. All workflows are
  deactivated in any case.
- **Expired, not rotated.** Invitation tokens and booking-token hashes are expired, not replaced.

## Destination identity (`s6`)

Version and emptiness alone are not trusted.

- **In remote mode,** the operator types the session pooler host, the **expected disposable-project
  ref**, and the production and staging refs (to refuse). The refs are never echoed.
- **The connection user's ref is the identity.** The pooler routes a connection to the project named
  in the user (`postgres.<ref>`). That ref must equal the expected ref and differ from production and
  staging. `lib.sh validate_remote_target` checks this **before the password is asked and before any
  container starts or connection is made**.
- **Rehearsed without network:** stage F covers production, staging, a mismatch, an expected ref equal
  to production or staging, a non-pooler host and malformed refs.
- **Then, read-only, before any write:**
  - server version `17.11*` (production is `17.6`);
  - database `postgres`;
  - no `_prisma_migrations`, no Auth users, no Storage rows;
  - no relation in `public`.

  Each refusal is specific (rehearsal stages E1–E3b).

## What is restored, and the two failure modes

**The restore is one `psql --single-transaction` run, in this order:**

1. `destination-prelude.sql` clears the destination's schema-level default privileges for `postgres`
   in `public`. Otherwise grants the destination adds at `CREATE` time would survive. The rehearsal
   caught `anon` gaining `TRUNCATE` on `business_dna`.
2. Missing extensions referenced by the archive are created, in the schema the archive names.
3. `public` pre-data, with `--no-owner`; grants are kept.
4. **Data only** for `auth.users`, `auth.identities`, `storage.buckets` and `storage.objects`,
   parents first. Their definitions are never restored.
5. `public` data, then post-data.
6. The application's `on_auth_user_created` trigger, after the data.

**Failure during the restore: rolled back.**

- The script prints `RESTORE ROLLED BACK` with stage `restore`. Nothing was committed, and the
  destination is unchanged (rehearsal E4).
- Exception: if the connection itself was lost, the operator confirms the destination is still empty
  before any retry.

**Failure after the commit: data remains.**

- The script prints `DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: <stage>)`. The stage is
  one of `verify-checks`, `verify-rowcounts`, `verify-privileges`, `verify-auth-trigger` or
  `verify-migration-history`.
- The destination holds sanitized data. **Nothing is deleted automatically**; the owner decides how
  to clean up, for example by deleting the disposable project in §10 (rehearsal E5).

**After the commit, the script verifies:**

- all checks are `0`;
- row counts equal the sanitized source;
- the grant fingerprint is equal (object grants **and** `postgres`'s public default privileges);
- `on_auth_user_created` is present;
- the history has no unfinished rows;
- **exactly** `20261014000000_secure_prisma_migrations_table` is pending.

`s6` does not apply that migration. Applying it to the disposable project only (`npx prisma migrate
deploy`) is a separate, separately authorized step, followed by `tests/staging/release-invariants.sql`
and the RLS scripts.

## Grants and ACL limits

**Verified, by `privileges.sql`, which must be identical in source and destination:**

- every grant on a `public` table, view, sequence and function to a role other than its owner;
- `postgres`'s schema-level default privileges in `public`.

**Not restored, and not verified against the source:**

- grants on the managed schemas' tables (`auth.*`, `storage.*`): the destination's Auth and Storage
  services own them, and only their rows are restored;
- other roles' default privileges in `public` (for example `supabase_admin`'s, which are skipped and
  recorded in the evidence);
- `postgres`'s **global** default privileges, and the ACL of the `public` schema object itself. These
  are the destination platform's own;
- column-level grants;
- object ownership: normalized to `postgres` by `--no-owner`. Owners other than `postgres` are
  recorded in the evidence.

## Storage: coverage and exclusions

- **Covered:** the `storage.buckets` and `storage.objects` metadata rows, or skipped with
  `--without-storage-metadata`.
- **Not covered:** the object **contents**. No Storage backup copy exists (`docs/recovery-drill-runbook.md`),
  so restored rows point at files that do not exist in the destination.
- Storage recovery is an **open owner decision**. Nothing here accepts or waives that risk.

## Destination configuration (not a database check)

The owner checks the disposable project's configuration in the dashboard (§1), separately from these
scripts:

- signups, manual linking and anonymous sign-ins off;
- outbound email: with the Email provider on and no custom SMTP, the built-in sender is active, so
  **outbound-email isolation is not established**;
- Auth hooks, Edge Functions, Database Webhooks, Cron and Vault secrets: none;
- GitHub, Vercel and QStash: none linked;
- network restrictions: the operator's current IP only.

## Synthetic rehearsal

```bash
bash scripts/recovery-drill/rehearsal/selftest.sh                       # offline, seconds
bash scripts/recovery-drill/rehearsal/rehearse.sh <empty-work-dir>      # Docker, ~5 minutes
```

It needs `public.ecr.aws/supabase/postgres:17.6.1.167`, `pgvector/pgvector:pg17` and `postgres:17`
locally (it never pulls), about 1 GB of free RAM, and one container at a time.

| Stage | Proves                                                                                                                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | A production-shaped source: 31 migrations, Prisma history, the 2026-10-21 manual remediation without a history row, and synthetic secrets in token columns, nested JSON, free text and text arrays. Dumped with the §4 options as `postgres`                                  |
| B     | `s5` passes. Every check, including JSON and text, sees its synthetic value before sanitizing; all are 0 after. Identities are kept                                                                                                                                           |
| C     | Seven sabotaged copies each stop `s5` with nothing released: a missing statement, a SQL error, a missing check, an omitted JSON scrub, an omitted text scrub, an omitted workflow-recipient rule, and the text scrub plus its check disabled (caught by the archive scan)     |
| D     | No marker survives in the archives. The wrong version is refused. A positive restore matches checks, row counts and grants (including default privileges) with exactly the expected migration pending. Invariants fail before the migration is applied locally and pass after |
| E     | Each guard (Auth users, Storage rows, migration history, other public relations) refuses before any write. A mid-load failure rolls back with no cleanup banner. A post-commit failure prints `DATA REMAINS` with its stage and deletes nothing                               |
| F     | Remote identity: production, staging, mismatched, equal-to-production/staging, non-pooler and malformed inputs are refused before the password prompt, with no container started and no network connection                                                                    |

## What the local rehearsal cannot prove (the real drill's open blockers)

- **Hosted Auth/Storage compatibility.** The local image needs approximations
  (`rehearsal/seed-auth-extras.sql`). Column compatibility between production and the drill project
  is only known at the real §6 run (a mismatch rolls back).
- **Hosted `postgres` privileges:** creating extensions, altering its default privileges, writing
  `auth`/`storage` rows, creating the trigger on `auth.users`.
- **The real §4 dump** through the Supavisor pooler with a `postgres:17` client, including whether
  `PGOPTIONS` read-only is honoured.
- **Real data:** volumes, time to restore, edge cases, real encrypted values, free-text secrets in
  unknown formats.
- **`prisma migrate deploy` itself** (the rehearsal applies the SQL and records the row as Prisma
  does), and the RLS scripts, which run against the disposable project in §7.
- **Owner decisions still open:** outbound-email isolation in the drill project, Storage recovery,
  and the authorizations for §4, §5, §6 and §10.
