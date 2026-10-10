# Recovery drill: executable dry-run checklist

Companion to `docs/recovery-drill-runbook.md`. **Nothing here has been executed.** A real run
needs the owner's explicit approval, because it copies production data out of Supabase.

Vendor guidance (Supabase Support, ticket **SU-494644**, authoritative): a safe drill is
**logical dump → inspect/sanitize → restore into a separate, disposable Supabase project**.
Supabase has **no project-wide setting that blocks outbound network traffic** before or during a
restore, and no universal isolation checklist: isolation is the application's job, which is what
this checklist does. **Never restore production data into the active staging project.**

Every SQL check below returns counts only, never row contents. Table and column names are from
`prisma/schema.prisma` at the drill's commit; re-check them before each run.

## 0. Go / no-go

- [ ] Owner approval recorded (who, when, which backup or dump time).
- [ ] Named operator and a second person reviewing evidence.
- [ ] The commit used for the drill is recorded (its migrations must match the dump).

**Abort if** no approval is recorded, or the operator would need production provider keys at any
step.

## 1. Disposable project

- [ ] New Supabase project, named `syveka-recovery-drill-<date>`, same Postgres major version as
      production, EU region.
- [ ] Auth: **no SMTP configured** (no emails can be sent), signups disabled.
- [ ] **No Edge Functions** deployed (in particular not `gdpr-erasure`).
- [ ] No integrations enabled (Database Webhooks, Cron, Vault secrets: none).
- [ ] Network restrictions allow database access only from the operator's IP.
- [ ] Not linked to any Vercel project, GitHub environment or QStash schedule.

**Abort if** the project was created from a production backup ("restore to new project"): that
path starts outbound extensions immediately.

## 2. Secret isolation

- [ ] Only the disposable project's own keys are used, and they are stored only in the operator's
      session for the drill.
- [ ] No production value is present anywhere in the drill environment: `QSTASH_TOKEN`,
      `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `VAPI_API_KEY`, `META_APP_SECRET`, `FAL_API_KEY`,
      `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, calendar OAuth client secrets, and the encryption keys
      used for stored tokens.
- [ ] The dump file stays in the approved encrypted location; it is never committed, attached or
      uploaded to Actions.

**Abort if** any production provider key or encryption key is found in the drill environment.

## 3. Production preflight (read-only)

- [ ] Run the read-only outbound preflight from `docs/release-runbook.md` on production. Expected:
      `pg_cron`, `pg_net`, `http`, `dblink`, `postgres_fdw`, `wrappers` all absent;
      `supabase_functions.hooks`, `cron.job`, `net.http_request_queue` `MISSING`; zero outbound
      triggers, foreign servers and subscriptions.

**Abort if** any outbound-capable extension, hook, job or subscription appears.

## 4. Dump and inspect

- [ ] `supabase db dump` (roles, schema, data) to the encrypted destination. Record UTC time, size
      and SHA-256.
- [ ] Inspect: no `cron`/`net` schema objects, no foreign data wrappers, no subscriptions.
- [ ] Per-table row counts recorded from production at dump time (for comparison in §7).

## 5. Sanitize (in an isolated local Postgres, `docker run --network none` with pgvector)

Apply, then verify each count is **0**:

| Check                        | SQL (count only)                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calendar OAuth tokens        | `select count(*) from calendar_connections where access_token_enc is not null or refresh_token_enc is not null`                                                    |
| Social (Meta) tokens         | `select count(*) from social_accounts where access_token_enc is not null or refresh_token_enc is not null`                                                         |
| Outbound workflow webhooks   | `select count(*) from webhook_endpoints`                                                                                                                           |
| Active workflows             | `select count(*) from workflows where is_active`                                                                                                                   |
| Pending reminders            | `select count(*) from reminders where status = 'SCHEDULED'`                                                                                                        |
| Scheduled or in-flight posts | `select count(*) from creator_posts where publish_status in ('SCHEDULED','PUBLISHING')`                                                                            |
| Stripe ids                   | `select (select count(*) from organizations where stripe_customer_id is not null) + (select count(*) from subscriptions where stripe_subscription_id is not null)` |
| Vapi assistants and numbers  | `select count(*) from voice_assistants where vapi_assistant_id is not null or phone_number is not null or is_active`                                               |
| Open invitations             | `select count(*) from invitations where status = 'PENDING'`                                                                                                        |
| Live booking tokens          | `select count(*) from booking_tokens where used_at is null and expires_at > now()`                                                                                 |

- [ ] All ten checks return 0. Dump the sanitized database (record size and SHA-256).

**Abort if** any check is non-zero after sanitization.

## 6. Restore into the disposable project

- [ ] Restore the **sanitized** dump only.
- [ ] Re-run all ten checks from §5 against the disposable project: all 0.
- [ ] `npx prisma migrate status` against the disposable project: up to date at the drill commit.

## 7. Verify data and isolation

- [ ] Per-table row counts match §4, except the rows sanitization deleted.
- [ ] `psql -v ON_ERROR_STOP=1 -f tests/staging/release-invariants.sql`: `ALL STAGING RELEASE INVARIANTS PASSED`.
- [ ] RLS scripts (`scripts/ci/run-rls-check.sh` with the `tests/rls/*` sets, as in
      `staging-release.yml`): every "ALL … ASSERTIONS PASSED" notice, and "Cleanup verified" for each.
- [ ] Optional functional check: a local build of the drill commit pointed at the disposable
      project with **no provider keys and no QStash token**; sign in as a known test user; open
      CRM, Calendar and Business DNA.

**Abort (and destroy) if** any invariant or RLS assertion fails.

## 8. Storage (separate from the database)

Database backups don't contain files; see `docs/storage-backup-design.md`.

- [ ] Restore the latest Storage backup copy into the disposable project's buckets, by exact path.
- [ ] Every `documents.storage_path` and `creator_reference_assets.storage_path` row resolves to an
      object; record missing paths per organization (count only).
- [ ] Sampled objects match the backup manifest's SHA-256.

## 9. Evidence (private change record)

- [ ] Approval, operator, reviewer, drill commit.
- [ ] Dump time, size, SHA-256 (raw and sanitized).
- [ ] Preflight output; the ten sanitization counts (before restore and after); row-count
      comparison; invariant and RLS output; Storage resolution counts.
- [ ] Time to restore (the recovery time this drill measured).

## 10. Destroy

- [ ] Delete the disposable Supabase project; record the time.
- [ ] Remove the local container and volumes.
- [ ] Delete the raw and sanitized dumps per the agreed retention; record it.
- [ ] Revoke the disposable project's keys if the deletion is delayed.
