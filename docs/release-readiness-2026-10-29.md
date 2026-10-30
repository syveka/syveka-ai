# Release readiness: `main` at `d5d492c` (sprint of 2026-10-29)

Evidence-based readiness review of `syveka/syveka-ai` at `main` =
`d5d492c49236e92a48c4567a89f69b20991fd198` (merge of #375), carried out in a cloud session with
repository access only. Nothing was deployed, no production system or secret was touched, and no
value of any secret was read. Every claim below names the file, command or test it comes from;
anything not exercised is marked **UNVERIFIED**. The previous review,
`docs/release-readiness-eca6822.md` (2026-10-10), remains valid for what it verified on staging;
this document covers what changed since and what this sprint found and fixed.

## 1. Executive verdict

**READY WITH CONDITIONS** for the Limited Pilot scope defined in
`docs/release-readiness-eca6822.md` §9 (CRM, Calendar, public Booking, typed AI Chat, Business
DNA; Creator Studio safe paths behind its per-org flag; voice after the voice-safety work).

**NOT READY** for an unrestricted production launch with billing, phone voice and inbound email
live, until the human actions in §7 are done.

Why:

- No P0 or P1 defect was found. Four independent read-only sweeps (tenant isolation across all
  225 `unscopedPrisma` call sites, authorization coverage of all 78 route handlers and 106 server
  actions, billing and jobs, product surfaces) and a Business DNA deep dive confirmed the
  tenant boundary, the authorization model, the Stripe idempotency ledger, the QStash job
  guards and the chat-confirmation architecture are sound and tested.
- Every official validation command passes on `main` and on the fix branch (§2).
- The remaining risks are operational (schedules, monitoring, backups, provider configuration,
  retention policy) and a handful of P2 code findings that are fixed in this branch (§4) or
  documented with a proposed fix (§5).

## 2. Repository evidence

| Item              | Value                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base              | `main` = `d5d492c` (clean working tree, no commits ahead of or behind `origin/main` at start)                                                                                 |
| Work branch       | `claude/syveka-release-readiness-69qo1r`, 8 commits on top of `d5d492c` (§4 plus `e8db862`, a test-only follow-up; no migration, no environment variable, no workflow change) |
| Delta since prior | `eca6822` → `d5d492c`: 10 merges, 292 files; one migration (`20261014000000_secure_prisma_migrations_table`, RLS on `_prisma_migrations`); no `src/env.ts` change             |
| Node / npm        | 22.22.0 / 10.9.4 (`package.json` engines `22.x`)                                                                                                                              |
| Tests at `main`   | `npm test`: 300 files passed, 8 skipped (opt-in Postgres/Redis suites); 4177 tests passed, 49 skipped                                                                         |

Validation commands (run locally in this session, on the fix branch after the last commit):

| Command                                   | Result                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                  | PASS                                                                                                                  |
| `npm run lint`                            | PASS (0 errors, 2 pre-existing warnings in `src/lib/voice/audio-duration.ts`)                                         |
| `npm run format:check`                    | PASS                                                                                                                  |
| `npm run typecheck`                       | PASS                                                                                                                  |
| `npm test`                                | PASS on the final branch: 303 files passed, 8 skipped; 4289 tests passed, 49 skipped (opt-in Postgres/Redis suites)   |
| `npm run i18n:check`                      | PASS (1152 keys in parity after the new voice error keys)                                                             |
| `npm run migrations:check`                | PASS (ordered, 8 published checksums match)                                                                           |
| `npx prisma validate`                     | PASS (with the CI placeholder `DATABASE_URL`/`DIRECT_URL`)                                                            |
| `npm run build`                           | PASS (`SKIP_ENV_VALIDATION=1`, as in CI)                                                                              |
| `npm audit --omit=dev --audit-level=high` | PASS (7 low/moderate in production deps: `qs`, `deepmerge` via `html-to-text`/`@react-email`; none high or critical)  |
| `npm audit` (all)                         | 3 critical / 5 high, **all dev-only**: `vitest`/`vite`/`tinypool` (test runner), `react-email`'s nested `next@15.1.2` |
| RLS / integration SQL suites              | NOT APPLICABLE locally (need the `pgvector/pgvector:pg15` harness; they run in CI jobs `rls`, `rls-non-superuser`)    |
| `npm run test:e2e`                        | NOT APPLICABLE locally (needs a deployed `E2E_BASE_URL`; runs in `staging-release.yml`)                               |

Secrets: a pattern scan of all tracked files found no committed credential. The gitleaks CI job
(`ci.yml`, `.gitleaksignore` with two documented false positives) remains the enforcement.

## 3. Business DNA (special priority)

The chat-driven flow requested for this sprint already exists and is the approved implementation
from #274: `proposeBusinessDnaUpdate` (`src/server/ai/tools/index.ts`) →
`previewBusinessDnaPatch` / `applyBusinessDnaPatch` (`src/server/services/business-dna-patch.ts`)
through the generic confirmation store (`src/server/ai/tool-actions.ts`,
`POST /api/v1/ai/actions/{id}`). Verified against the required chain:

| Requirement            | Where                                                                                                        | Verified by                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Strict field allowlist | `BUSINESS_DNA_PATCH_FIELDS`; `.strict()` schemas; `changedFields()` re-checks in preview and apply           | `business-dna-patch-validator.test.ts`, `ai-business-dna-tool.test.ts`    |
| Settings-only fields   | `communicationStyle`, `responseInstructions` never patchable, not offered to the model                       | same, incl. a stored action tampered with a settings-only field           |
| Tenant authorization   | orgId only from `TenantContext`; `tenantDb(orgId)`; action bound to org, user, conversation in Redis         | "can't be confirmed from another organization" (404), tenant mock per org |
| Safe partial updates   | Only named fields; opening hours merged per day; lists are whole lists                                       | "keeps the other days' hours", "unrelated fields kept"                    |
| Version / concurrency  | Basis (before-values) recorded at preview; advisory lock + `SELECT … FOR UPDATE`; stale → nothing written    | 7 stale/lock tests incl. a change landing while waiting for the lock      |
| Idempotency / replay   | Single-use Lua decision, digest-bound, TTL 600 s                                                             | "runs at most once", "replay", "changed arguments are a new action"       |
| Confirmation           | Write tools never run on the model's call; `execute` refuses without an action id or for voice               | "bypassing the confirmation" suite (4 tests)                              |
| Audit trail            | `business_dna.update/create` with before/after fields, `via: ai_chat`, action and conversation ids           | audit assertions in the create/update tests                               |
| Prompt content         | Untrusted KB/scraped text neutralized (`neutralizeTagBreakout`, `sanitizeForPrompt`); user confirms visually | `ai-prompt-untrusted.test.ts`, `prompt-injection-rag-title.test.ts`       |

Stress case: the suite's fixture is literally the car-repair-shop-in-Helsinki scenario (BMW,
Mercedes, VW; Mon–Fri 08–17; FI/EN/AR). `missingBusinessDnaFields` reports what is still
missing after the change (`targetCustomer`, policies, `brandTone`) so chat can ask one question at
a time.

Mutation check (this session): three guards were weakened in turn and restored, and the suites
caught each one. Removing the confirmed-action/user check in `execute`: 1 failure. Removing the
`CHAT_FIELDS` allowlist check in the patch service: 1 failure. Skipping the stale-basis
comparison: 4 failures. Working tree verified clean afterwards.

Still **UNVERIFIED** (unchanged from the prior review): live Confirm/Cancel in a signed-in
browser on staging; Arabic and mobile visual layout of the proposal card; the action-store Lua
scripts against a real Redis (`ai-tool-actions-redis.test.ts`, opt-in).

## 4. Fixes completed (this branch)

All on `claude/syveka-release-readiness-69qo1r`, one commit per defect, each validated with the
focused suite plus Prettier, ESLint and `tsc` before committing; the whole-repository commands
in §2 were run after the last commit.

| Commit    | Severity  | Fix                                                                                                                                                                                                                                                                                                                                                                                                      | Tests                                                                                                            |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `29e4893` | P2        | `send-reminder` swallowed every per-recipient email failure after marking the reminder SENT: a provider outage silently lost reminders. Now logs each failure (ids and error name only), marks a reminder that reached nobody FAILED and answers 500 so QStash retries it (the claim accepts FAILED). Also removes an unused `cancelEventReminders` export that updated by `eventId` with no org filter. | `jobs-organization-guard.test.ts` (+4), `calendar-event-reminders.test.ts` (response shape)                      |
| `4431374` | P2        | `changeRoleAction` returned the exception's message (Prisma text) to the client. Now stable codes (`not_found`, `owner_role`, `own_role`, `failed`), logged by name only. Another org's member id reads as `not_found`.                                                                                                                                                                                  | `change-role-action.test.ts` (new, 6)                                                                            |
| `dfcd7c4` | P2        | The four voice actions (assistant save/activate/deactivate, phone number attach) called the paid provider with no rate limit. Now share a per-user `voice` write allowance, failing closed; refusal codes translated in FI/EN/AR.                                                                                                                                                                        | `rate-limit-write-actions.test.ts` (+3, drift guard covers `voice.ts`)                                           |
| `52124ab` | P3        | The MOCK calendar provider was hidden from the production settings list but always "configured", so the connect action could attach a fake calendar to a production org. The adapter now applies the same rule as the list.                                                                                                                                                                              | `calendar-mock-provider-gate.test.ts` (new, 3)                                                                   |
| `016fed2` | P2 (test) | No test enforced that every API route and server action is guarded. A static coverage test now fails on any handler without a session guard, a signature check, or an explicit public declaration with a rate limit.                                                                                                                                                                                     | `tests/unit/security/handler-guard-coverage.test.ts` (new, 92 assertions across 65 routes and 22 action modules) |
| `933af78` | P3        | `createOrganizationAction` was the one unlimited state-changing action (each org has its own free allowances). Now 10/min per user on the `auth` limiter, failing closed.                                                                                                                                                                                                                                | `organization-onboarding.test.ts` (+2)                                                                           |
| `8d94571` | P3        | `embed-document` wrote chunks and READY unconditionally, so a document deleted mid-run ended soft-deleted, READY, with fresh chunks. The READY write is now guarded on the claimed, existing document; otherwise the run's chunks are removed and nothing is recorded or notified.                                                                                                                       | `jobs-organization-guard.test.ts` (+1; fixture tags inserted chunks by document)                                 |

## 5. Findings

Severity: P0 launch blocker · P1 serious · P2 important · P3 improvement. "Status" is the state
on the fix branch.

| Severity | Area       | Finding                                                                                                                                                                                                                                                | Evidence                                                                                                                            | Status                                                                 |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P2       | Jobs       | Reminder emails lost silently on provider failure                                                                                                                                                                                                      | `send-reminder/route.ts` (`.catch(() => undefined)`)                                                                                | **Fixed** `29e4893`                                                    |
| P2       | Auth       | `changeRoleAction` leaks exception text                                                                                                                                                                                                                | `src/actions/members.ts`                                                                                                            | **Fixed** `4431374`                                                    |
| P2       | Voice      | Paid-provider voice actions without rate limit                                                                                                                                                                                                         | `src/actions/voice.ts`                                                                                                              | **Fixed** `dfcd7c4`                                                    |
| P2       | Tests      | No structural guard-coverage test for handlers                                                                                                                                                                                                         | `tests/unit/security/` had two files                                                                                                | **Fixed** `016fed2`                                                    |
| P2       | Billing    | PAST_DUE read-only grace measured from `subscription.updatedAt`; every `invoice.payment_failed` and `customer.subscription.updated` rewrite bumps it, so lockout lands ~14 days after the **last** retry (known since the prior review; **not fixed**) | `billing/entitlements.ts:137-140`; `webhooks/stripe/route.ts` `payment_failed` `updateMany` and `applySubscriptionUpsert`           | **Open**: needs a `pastDueSince` column (schema change, §7)            |
| P2       | Creator    | A post stranded in `PUBLISHING` (function killed at `maxDuration` during the platform call) is never reclaimed; the retry sees the claim fail and returns done                                                                                         | `creator-publishing.ts:114-127` (claim matches SCHEDULED/FAILED only)                                                               | **Open** (out of pilot scope; proposed fix §9)                         |
| P2       | Voice/GDPR | Call transcripts and recording URLs on `VoiceCall` have no retention and are outside the 30-day purge; the recording is a Vapi-hosted URL (bearer link) rendered by the call page                                                                      | `schema.prisma:1285,1288`; `usage-rollup/route.ts:26-28` (contacts, documents, conversations only); `voice/calls/[callId]/page.tsx` | **Open**: policy decision (§7), then code                              |
| P3       | Billing    | Quota checks are check-then-write for AI messages, contacts, storage intents; overrun bounded by rate limits; seats are serialized                                                                                                                     | `ai-spend.ts`, `contacts.ts:136-140`, `documents.ts:46-52`, `members.ts` under `lockOrgSeats`                                       | Open, accepted for pilot                                               |
| P3       | Jobs       | `run-workflow` and `publish-creator-post` create a user notification on every failed attempt (up to 4 per run)                                                                                                                                         | `run-workflow/route.ts:831-851`, `creator-publishing.ts:285-299`                                                                    | Open                                                                   |
| P3       | Jobs       | `publish-creator-post` logs whole error objects (may carry provider response bodies)                                                                                                                                                                   | `publish-creator-post/route.ts:39`, `creator-publishing.ts:271`                                                                     | Open                                                                   |
| P3       | AI         | Anthropic client has no request timeout (SDK default 10 min) while job `maxDuration` is 120–300 s; a hung call is killed by the platform and the post-call summary paid again on retry                                                                 | `integrations/anthropic.ts:10`; `vercel.json`                                                                                       | Open (set `timeout` below the shortest consumer's `maxDuration`)       |
| P3       | Jobs       | `usage-rollup` iterates every org unpaginated; the 7-day "already warned" check is check-then-write                                                                                                                                                    | `usage-rollup/route.ts:32-79`                                                                                                       | Open                                                                   |
| P3       | Booking    | Public booking is limited per IP only (10/min); no per-org or per-booking-type cap                                                                                                                                                                     | `booking/[org]/[slug]/route.ts:32-34`                                                                                               | Open                                                                   |
| P3       | Booking    | Reschedule with a duration no longer in `durationOptions` computes slots with the type's duration but `endsAt` with the old one (conflict check still prevents double-booking)                                                                         | `booking.ts:826-838`                                                                                                                | Open                                                                   |
| P3       | Booking    | Guest web booking and AI/voice booking take different advisory-lock domains, so both can pass their conflict checks for the same slot (documented, deferred)                                                                                           | `calendar/locks.ts:33-52`; `docs/DECISIONS.md:115-120`                                                                              | Open, known                                                            |
| P3       | Webhooks   | Calendar and Vapi webhooks have no IP rate limit; Microsoft batches are unbounded (one indexed lookup per item before the secret check)                                                                                                                | `webhooks/calendar/[provider]/route.ts:58-66`                                                                                       | Open                                                                   |
| P3       | Webhooks   | Generic inbox-email endpoint uses a static shared secret with no timestamp (replay bounded by `externalId` dedup); the Resend/svix endpoint is the production path                                                                                     | `webhooks/inbox-email/route.ts:33-42`                                                                                               | Open: keep `INBOX_EMAIL_WEBHOOK_SECRET` unset for the pilot            |
| P3       | Auth       | `isCrossOrigin` applied to some paid JSON routes but not `ai/chat`, `ai/files*`, `kb/documents*`, `business-dna/extract` (defense in depth only while cookies are SameSite=Lax)                                                                        | `src/server/security/same-origin.ts` callers                                                                                        | Open                                                                   |
| P3       | Auth       | Write actions outside CRM/calendar/booking/integrations/voice (inbox, prompts, workflows save/toggle, api-keys, settings, members role/remove, creator confirmations) have no write limiter                                                            | `src/actions/*.ts` (see `rate-limit-write-actions.test.ts` drift guard for the covered set)                                         | Open                                                                   |
| P3       | Creator    | Likeness consent attestation reachable by MEMBER (`creator:write`)                                                                                                                                                                                     | `profiles/[id]/consent/route.ts`, `permissions.ts`                                                                                  | Open: product decision                                                 |
| P3       | KB         | `GET /kb/documents/{id}` returns `storagePath`, `sourceUrl`, raw `error`; delete of an unknown id throws (500) instead of 404; storage-object removal failures are swallowed (orphans)                                                                 | `kb/documents/[id]/route.ts`, `documents.ts:213-229`                                                                                | Open                                                                   |
| P3       | Jobs       | Five job routes `JSON.parse` the verified body without a guard (malformed → 500 → retries → DLQ); only operator-forged messages reach it                                                                                                               | `embed-document:81`, `post-call:60`, `send-reminder:29`, `run-workflow:276`, `publish-creator-post:31`                              | Open                                                                   |
| P3       | Inbox      | `InboxMessage.externalId` is globally unique: one email delivered to two orgs' mailboxes is rejected for the second (coupling, no leak)                                                                                                                | `inbox.ts:240-255`                                                                                                                  | Open                                                                   |
| P3       | Deps       | Dev-only critical/high advisories (`vitest`/`vite`/`tinypool`; `react-email` pins `next@15.1.2`); production audit clean at high                                                                                                                       | `npm audit`                                                                                                                         | Open: bump `vitest` 3→latest 3.x/4 and `react-email` in a dedicated PR |
| P3       | CI         | `pgvector/pgvector:pg15` pulled unauthenticated and unpinned in 5 jobs (Docker Hub rate limiting caused failed runs on 2026-10-09)                                                                                                                     | `ci.yml:187,234,387,439,488`                                                                                                        | Open: workflow change needs owner review                               |

Verified sound (no finding), with the evidence used:

- **Tenant isolation.** All 225 `unscopedPrisma` call sites traced to a server-verified org, a
  parent fetched through `tenantDb`, a signed token/webhook/job payload, or superadmin.
  `tenantDb` overrides `organizationId` in every write payload. RAG filters org in both SQL paths
  (`match_chunks` also requires `deleted_at is null` and `status='READY'` since migration
  `20260727000000`).
- **Authorization.** 78 route exports: 55 session-guarded, 13 signature/secret, 6 public with IP
  limits, 2 session + signed OAuth state, 2 intentionally public; 106 actions: 92
  `requirePermission`, 2 superadmin (in the service), 5 self-scoped session, 7 auth; none
  unguarded (now enforced by `handler-guard-coverage.test.ts`). Role matrix: billing is
  OWNER-only; OWNER can't be demoted/removed; self role change blocked; superadmin from
  `app_metadata.is_superadmin` only.
- **RLS.** Enabled on every public table including `_prisma_migrations` (migration
  `20261014000000`); `tests/staging/release-invariants.sql` asserts RLS on _any_ public table,
  so a new table can't ship unprotected.
- **Billing.** Stripe signature before any write; durable `StripeWebhookEvent` ledger with
  atomic claim and stale-PROCESSING reclaim, fail-closed when the ledger is unavailable;
  out-of-order protection by re-fetching Stripe state; org association by
  `org.stripeCustomerId === sub.customer`, fail closed; entitlements from the DB subscription
  only; plan change serialized with a Redis `SET NX` claim and idempotency keys.
- **Jobs.** All 8 routes verify the QStash signature including the URL; org from the payload is
  always joined to the resource; `isOrganizationActive` before and after paid calls;
  post-call, run-workflow, embed-document, calendar-sync and reconcile are idempotent by design.
- **Booking.** Advisory lock per owner calendar then conflict check in one transaction;
  hashed single-use manage tokens with constant-time compare; DST-safe slot computation; OAuth
  state HMAC-bound to org/user/provider and the live session; AES-256-GCM tokens at rest.
- **Voice.** Timing-safe HMAC before parsing; org from the assistant id lookup; voice identity
  limited to the allowed read/book tools; per-call write caps; post-call idempotent.
- **Knowledge.** DNS-pinned SSRF guard with redirect re-resolution; upload intents bound to
  org+user and consumed transactionally; MIME sniffed before create and again in the job.
- **CRM.** All relations (`companyId`, `contactId`, `ownerId`, `stageId`) asserted through
  `tenantDb`; no raw SQL; bounded search and pagination.

## 6. Reliability and observability

- `/api/health` reports DB, Redis and the build SHA. **No uptime monitor or alert is configured
  in the repository** (§7).
- Sentry is DSN-gated with allowlist scrubbing; the DSN's presence in production is
  **UNVERIFIED**.
- Job failures: embed-document, reminders (now), workflows and publishing log structured events;
  QStash DLQ growth has no alert.
- Retention purge (`usage-rollup`) runs only if its QStash schedule exists: **UNVERIFIED**.

## 7. Human actions required (Ehab)

Only actions that need dashboard access, a secret, or a decision. Everything that could be done
from the repository was done.

| #   | System / page                                                                   | Check or change                                                                                                                                                                               | Why                                                                          | Risk if skipped                                               | Time   | Blocks launch?                                |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ | --------------------------------------------- |
| 1   | Upstash console → QStash → Schedules                                            | A schedule posting to `/api/v1/jobs/usage-rollup` at `0 2 * * *` exists and delivered in the last 24 h (and `calendar-sync` / `reconcile-creator-generations` if those features are in scope) | 30-day GDPR purge and quota notices run only from this schedule              | Soft-deleted personal data is never purged; no quota warnings | 10 min | **Yes** (retention promise)                   |
| 2   | Vercel → production project → Environment Variables                             | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` set; `NEXT_PUBLIC_SENTRY_ENVIRONMENT` only on staging. Names and presence only.                                                                        | Server errors are otherwise invisible                                        | Production incidents go unnoticed                             | 10 min | Yes for pilot operations                      |
| 3   | Uptime monitor of your choice (e.g. Better Stack, UptimeRobot)                  | Monitor `GET /api/health` on the production domain: alert on non-200 or on `build` ≠ the released SHA                                                                                         | Nothing else alerts on downtime                                              | Outage discovered by customers                                | 15 min | Yes for pilot operations                      |
| 4   | Resend dashboard                                                                | Sending domain verified; `RESEND_API_KEY` present in Vercel production (name only)                                                                                                            | Booking confirmations and reminders                                          | Bookings confirmed on screen but no email                     | 10 min | **Yes** if booking is in the pilot            |
| 5   | Stripe dashboard → Developers → Webhooks; Billing → Subscriptions → Retries     | Endpoint enabled with the production secret; price ids match `src/server/services/billing/plans.ts`; Smart Retries and the final action after failed retries configured                       | Billing is otherwise inert, and dunning is a Stripe setting (no app emails)  | Paid plans never activate; failed payments never close        | 20 min | Only if billing is live in the pilot          |
| 6   | Supabase → Database → Backups / PITR                                            | Confirm the backup option per `docs/release-runbook.md` (PITR, or Option B with written risk acceptance); storage backup per `docs/storage-backup-design.md`                                  | No application-level backup exists                                           | Unrecoverable data loss                                       | 30 min | **Yes**                                       |
| 7   | Decision (then a small PR)                                                      | Retention for voice transcripts and recordings (e.g. 90 days), and whether the Vapi recording URL may be shown directly                                                                       | GDPR erasure requests can't be met for callers today                         | Legal exposure once phone voice is live                       | 15 min | Yes **before phone voice**, not for the pilot |
| 8   | Decision (then an approved migration)                                           | Approve adding `Subscription.pastDueSince` so the 14-day read-only grace starts at the first failed payment (§5, P2)                                                                          | Schema change needs explicit authorization                                   | Paid limits stay available up to ~5 weeks unpaid              | 5 min  | No (commercial, not safety)                   |
| 9   | GitHub → repo settings / `ci.yml` review                                        | Approve pinning `pgvector/pgvector:pg15` by digest and adding read-only Docker Hub credentials or a GHCR mirror                                                                               | Workflow changes are protected                                               | Random CI failures on Docker Hub rate limits                  | 15 min | No                                            |
| 10  | Staging (signed-in browser, test org OWNER)                                     | Run the Business DNA manual QA list in `docs/release-readiness-eca6822.md` §2 (Confirm/Cancel live, Arabic, 375 px)                                                                           | The only part of the Business DNA flow not covered by automated tests        | A visual/RTL defect reaches pilot users                       | 20 min | No, but before announcing chat setup          |
| 11  | GitHub → review and merge this branch's PR; then dispatch `staging-release.yml` | Review the 7 commits (§4), merge, run a staging release on the new SHA, then `deploy.yml` with the §7 runbook of the prior review                                                             | Fixes only help once released; the release chain requires staging on the SHA | —                                                             | 30 min | —                                             |

## 8. Launch checklist

| Area                     | State                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Authentication           | PASS (server-side `getUser()`, stale-claim fallback, open-redirect guard, OAuth callbacks session-bound)                |
| Authorization            | PASS (all handlers guarded; now enforced by test)                                                                       |
| Tenant isolation         | PASS (all `unscopedPrisma` sites traced; `tenantDb` write override)                                                     |
| RLS                      | PASS in repository (every public table; release invariants assert it) · HUMAN CHECK: production re-run via `deploy.yml` |
| Database / migrations    | PASS (`migrations:check`, `prisma validate`; one migration since the prior review, RLS-only)                            |
| Business DNA             | PASS (automated + mutation check) · HUMAN CHECK: live browser QA (#10)                                                  |
| AI chat / tool execution | PASS (confirmation store, moderation, fail-closed limits)                                                               |
| CRM                      | PASS                                                                                                                    |
| Knowledge / RAG          | PASS (deleted-document gap closed in `8d94571`)                                                                         |
| Booking                  | PASS (P3 notes in §5)                                                                                                   |
| Voice                    | PASS for webhook integrity and tool scoping · FAIL for retention/GDPR until #7 is decided                               |
| Billing                  | PASS for integrity (ledger, ordering, association) · HUMAN CHECK #5 · P2 grace reset open (#8)                          |
| Jobs / automations       | PASS (reminder delivery now recorded and retried) · HUMAN CHECK #1 (schedules)                                          |
| Observability            | HUMAN CHECK #2, #3                                                                                                      |
| CI                       | PASS (17 required jobs; Docker Hub pin recommended, #9)                                                                 |
| Deployment configuration | PASS (`deploy.yml` release-chain verifier, staged-then-promote, rollback command printed)                               |
| Rollback / recovery      | PASS for application rollback (`vercel rollback`) · HUMAN CHECK #6 (backups)                                            |
| Dependencies             | PASS for production (`--omit=dev` clean at high) · dev-only advisories to bump                                          |

## 9. Next engineering priorities

**Before launch (after this branch is merged):**

1. Human actions #1–#6 above.
2. `pastDueSince` migration (needs #8): set on the transition to `PAST_DUE`, cleared on
   `ACTIVE`; `entitlements.ts` measures the 14 days from it; tests: repeated
   `invoice.payment_failed` and `customer.subscription.updated` leave the clock unchanged.
3. Anthropic client `timeout` below the shortest consumer's `maxDuration` (post-call: 120 s), so
   a hung provider call fails inside the job instead of being killed by the platform.

**First week after launch:**

1. Creator Studio: reclaim a `PUBLISHING` post older than the function's `maxDuration` the way
   `embed-document` reclaims stale `PROCESSING` (or mark it FAILED with a notification), and
   notify once per run, not per attempt.
2. Voice retention job (after #7): purge `transcript`/`recordingUrl` past the chosen age and on
   contact deletion; proxy or sign recording playback.
3. Per-org/per-booking-type cap on public bookings; IP limits on the calendar and Vapi webhooks;
   Microsoft batch size cap.
4. Extend `actionWriteLimitError` to the remaining write actions (inbox, prompts, workflows,
   api-keys, settings, members, creator confirmations).
5. `vitest`/`react-email` dev dependency bumps in one dedicated PR.

**Later roadmap:**

- Serialize guest web booking and AI/voice booking on the same lock domain
  (`docs/DECISIONS.md`).
- `usage-rollup` pagination and an idempotent "warned" marker; DLQ-growth alerting.
- Return 400 for malformed job bodies; sanitized provider error logging in publishing.
- Scope `InboxMessage.externalId` uniqueness per mailbox.
