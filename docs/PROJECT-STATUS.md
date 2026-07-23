# Syveka AI — Project Status

Snapshot date: **2026-07-23**. All facts below were verified directly against the repository
and GitHub during this audit — not inferred from prior documentation or chat history.

## Repository state

| Field | Value |
|---|---|
| Repository | `syveka/syveka-ai` (`https://github.com/syveka/syveka-ai.git`) |
| Local folder | `c:\Users\lenovo\Desktop\syveka copy` |
| Current branch | `chore/staging-release-validation` |
| Default branch | `main` |
| Latest local commit | `878cda1` — "Fix legacy default and secret scan validation" |
| Remote sync | Up to date with `origin/chore/staging-release-validation` (no ahead/behind) |
| Working tree | **Clean of real changes.** `git status` shows ~39 files as "modified", but `git diff --stat` produces zero content diff — `core.autocrlf=true` on this Windows clone is flagging CRLF/LF normalization only, not actual edits. Confirmed by direct diff inspection. |
| Untracked files | None |
| Stashes | None |
| Tags / releases | None exist yet |
| Local branches | `chore/staging-release-validation` (current), `main`, `feature/calendar-booking-v1`, `feature/crm-contacts-v1`, `feature/crm-dashboard-v1`, `feature/crm-deals-v1`, `feature/production-hardening-sprint-1`, `fix/calendar-booking-rls-migration` |
| Remote-only branches | `origin/chore/rc2-production-hardening` (no local copy) |

## Pull request history (verified via `gh pr list --state all`)

| # | Title | Branch | State |
|---|---|---|---|
| 9 | Prepare and validate first safe staging release | `chore/staging-release-validation` | **OPEN, DRAFT** (current work) |
| 8 | Track and test Calendar & Booking RLS migration | `fix/calendar-booking-rls-migration` | Merged 2026-07-18 |
| 7 | Fix workflow translations and i18n validation | `feature/production-hardening-sprint-1` | Merged 2026-07-16 |
| 6 | AI Chat Production Hardening — Milestone 3 | `feature/production-hardening-sprint-1` | Merged 2026-07-13 |
| 5 | CRM Calendar & Booking Assistant V1 | `feature/calendar-booking-v1` | Merged 2026-07-13 |
| 4 | Add CRM Deals & Sales Pipeline module (V1) | `feature/crm-deals-v1` | Merged 2026-07-12 |
| 3 | Add CRM Contacts & Companies module (V1) | `feature/crm-contacts-v1` | Merged 2026-07-12 |
| 2 | CRM Dashboard V1 | `feature/crm-dashboard-v1` | Merged 2026-07-11 |
| 1 | Production readiness hardening for v0.1.0-rc.2 | `chore/rc2-production-hardening` | Merged 2026-07-10 |

**Note for anyone continuing from prior context**: the branch `feature/production-hardening-sprint-1`
and its PRs (#6, #7) referenced in earlier planning notes are **already merged** — they are
historical, not active work. The active branch and open work is PR #9 on
`chore/staging-release-validation`.

## CI status

PR #9's most recent CI run (`29712079180`, 2026-07-20T02:10–02:16 UTC) — **all 14 required jobs
passed**: Install dependencies, Migration structure validation, i18n key parity, Secret scan,
Prisma generate, Prisma validate, Production dependency security audit, Full dependency audit
report, Lint, TypeScript typecheck, (plus RLS isolation, migration-upgrade drift tests, tests,
build — confirmed passing via `gh pr checks`).

**However, re-running the exact blocking dependency-audit command locally today (2026-07-23)
fails**: `npm audit --omit=dev --audit-level=high` now reports 3 high + 1 moderate vulnerability
(newly disclosed since 2026-07-20) in `next`, `postcss`, `sharp` (all nested under `next`), and
`next-intl`. **This means PR #9's green CI is now stale with respect to that gate** — the next
push or re-run of this workflow on this PR will fail until dependencies are bumped. See
`CI-PRODUCTION-READINESS.md` for exact versions and fix commands. This is the single most
time-sensitive item in this audit.

All other locally-runnable checks pass cleanly as of this audit: `prisma validate`, `prisma
generate`, `npm run i18n:check` (488/488/488 keys, zero drift), `npm run migrations:check`,
`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (310 tests across 34
files, all green), `npm run build` (111/111 static pages generated).

## Completed milestones (verified complete, not merely claimed)

- Foundation: Next.js 15 + TypeScript strict + Tailwind/shadcn + Prisma (43 models) + Supabase
  Auth + env validation.
- Auth: login/register/forgot-password/reset-password/verify/invite, onboarding, org creation.
- RBAC: 5-role matrix, `requirePermission`, audit-logged denials.
- CRM: Contacts, Companies, Deals/pipeline, Activities/timeline, Dashboard — all with real
  transactional, tenant-scoped, audit-logged logic.
- Calendar & Booking V1: event CRUD, availability engine, public booking pages, guest booking
  with transactional double-booking protection, token-based cancel/reschedule, external
  calendar sync (Google/Microsoft, import-only), AI booking assistant (deterministic slots,
  LLM only ranks/explains).
- Voice AI (Vapi): assistant provisioning, Finnish phone numbers, in-call tools, post-call
  pipeline, webhook signature verification.
- AI Chat + RAG (Milestone 3 hardening): document upload → verified extraction → chunking →
  embedding (pgvector) → retrieval → citation-checked generation → double-sided moderation →
  cost/token tracking → conversation summarization. Complete, well-tested end-to-end pipeline.
- Billing: Stripe checkout, billing portal, webhook handling (idempotent, signature-verified),
  plan/entitlement matrix, usage meters.
- Workflows: 6 trigger types (partially verified — only `booking.*` emitters confirmed),
  6 step types, resumable QStash-backed runner, builder UI.
- Notifications: in-app feed, Supabase Realtime badge, email templates.
- i18n infrastructure: en/fi/ar catalogs at 488/488/488 keys, zero parity drift, RTL `dir`
  attribute wired globally.
- CI/CD: 14-job required CI gate, gitleaks secret scanning, migration-history checksum
  anti-tamper guard, three-stage manually-gated release pipeline (CI → staging → production)
  with SHA cross-verification.

## Partially completed / open work

- **PR #9 (current branch)**: staging release validation preparation — appears functionally
  ready per CI history, but blocked by the dependency-audit finding above before it can be
  safely re-validated or merged.
- **Organization self-serve deletion**: `org:delete` permission and a 30-day-grace GDPR
  hard-delete Edge Function both exist, but no Server Action or UI triggers it. Not started.
- **i18n coverage gaps**: several settings/onboarding components (`members-table.tsx`,
  `invite-form.tsx`, `api-keys-manager.tsx`, `organization-form.tsx`, `profile-form.tsx`,
  `onboarding-form.tsx`) hardcode English text despite the message catalogs being complete;
  onboarding has no Arabic strings at all for its hardcoded copy.
- **Dead/unwired infrastructure**: `zustand` (installed, unused), `@tanstack/react-query`
  (provider mounted, zero consumers), `fallbackModel()` OpenAI failover (defined, never called).
- **Workflow trigger coverage unverified**: only `booking.*` trigger emitters were confirmed;
  `contact.created`, `deal.stage_changed`, `deal.won`, `call.completed`, `schedule.cron` are
  declared in the type union but not confirmed to have an `emitWorkflowEvent()` call site.
- **Loading/error UX inconsistency**: only the `/dashboard` route has dedicated `loading.tsx`/
  `error.tsx`; every other route falls back to Next.js defaults.
- **Sentry/Langfuse**: env vars declared, no SDK integration found — observability gap.

## Open blockers (see `SECURITY-AUDIT.md` and `CI-PRODUCTION-READINESS.md` for full detail)

1. Dependency CVEs currently fail the blocking CI audit gate (high: `next`, `postcss`, `sharp`;
   moderate: `next-intl`).
2. Calendar webhook (`/api/v1/webhooks/calendar/[provider]`) has no signature/shared-secret
   verification.
3. No Content-Security-Policy header is actually set, despite a code comment claiming it is.
4. Four file/URL-ingestion endpoints (`kb/documents`, `kb/documents/upload-url`, `ai/files`,
   `ai/files/upload-url`) have no rate limiting.

None of these are cross-tenant data exposure, authentication bypass, or injection
vulnerabilities — see `SECURITY-AUDIT.md` for exact severity classification.

## Production readiness

**Not yet approved for production deploy.** The three-stage release pipeline (CI → staging →
production) is itself well-built and safe to use, but has not been exercised past PR #9/staging
preparation, and the P0 items above should be resolved first. See `ROADMAP.md` P0 and
`CODEX-HANDOFF.md` for the exact next task.

## Overall completion estimate

Based on repository evidence (feature depth, test coverage, CI maturity): the **core platform
(auth, CRM, calendar/booking, AI chat/RAG, voice, billing, workflows, i18n infrastructure) is
functionally complete**, roughly matching the README's own "v0.1" self-assessment for backend
logic depth. What remains before a confident production launch is narrower than a first read of
the README suggests: dependency hygiene, a handful of medium-severity hardening items, i18n
*coverage* completion (not infrastructure), and exercising the already-built release pipeline
once through staging and production. This is a hardening/finishing phase, not a
rebuild-from-scratch or major-gap-filling phase.
