# Syveka AI — Claude Handoff

**Read this file first, every session, before touching code.** Then run `git status`, confirm
the active branch, confirm the latest commit, and review recent `git log` — this file is a
snapshot, not a live feed.

## Project identity

- Project: **Syveka AI** — multi-tenant AI business SaaS platform, Finnish-SMB first, expanding
  to EN/AR markets, eventually a broader global business platform (CRM, calendar/booking, AI
  chat/RAG, voice agents, workflows, billing, and later marketing/website-builder/mobile/security
  add-ons).
- Domain: syveka.com. Business email: info@syveka.com.
- Repository: `syveka/syveka-ai` (`https://github.com/syveka/syveka-ai.git`).

## Repository facts as of this snapshot (2026-07-23)

- Local folder: `c:\Users\lenovo\Desktop\syveka copy`
- Current branch: `chore/staging-release-validation`
- Default branch: `main`
- Latest commit: `878cda1` ("Fix legacy default and secret scan validation")
- Working tree: appears to show ~39 modified files via `git status`, but this is **pure
  CRLF/LF line-ending noise** from `core.autocrlf=true` on Windows — `git diff --stat` shows
  zero actual content changes. Do not assume there is uncommitted work here; verify with
  `git diff --stat` (not just `git status`) before acting.
- Open work: PR #9 (`Prepare and validate first safe staging release`, DRAFT) on the current
  branch. PRs #1–#8 are all merged historical work.

## Current milestone

Finishing the **staging-release-validation** hardening pass (PR #9) and clearing the P0
production blockers found in this audit before the first staging/production dispatch. The core
platform (CRM, Calendar/Booking, AI Chat/RAG, Voice, Billing, Workflows) is functionally
complete — this is a hardening/finishing phase, not a build-from-scratch phase.

## Completed features (verified, not just claimed)

Auth (Supabase, no Clerk), RBAC, Onboarding, Organizations (except self-serve delete), CRM
(Contacts/Companies/Deals/Activities/Dashboard), Calendar & Booking V1 (incl. AI booking
assistant, external calendar import sync), Voice AI (Vapi), AI Chat + RAG (Milestone 3
hardening — upload→extract→chunk→embed→retrieve→cite→moderate→track-cost), Stripe billing,
Workflows (trigger coverage partially unverified), Notifications, Audit logs, Analytics,
Superadmin, i18n infrastructure (488/488/488 key parity). Full detail: `FEATURE-INVENTORY.md`.

## Active work

PR #9 — staging release validation. CI last passed 2026-07-20 (run `29712079180`), but **the
blocking dependency-audit check would fail if re-run today** (new CVEs in `next`/`postcss`/
`sharp`/`next-intl`) — this is the first thing to fix. See `CI-PRODUCTION-READINESS.md` and
`CODEX-HANDOFF.md`.

## Known blockers

1. Dependency CVEs fail the blocking CI gate (High) — `SECURITY-AUDIT.md` H1.
2. Calendar webhook has no signature verification (Medium).
3. No CSP header despite a comment claiming one exists (Medium).
4. Four file/URL-ingestion endpoints have no rate limiting (Medium).

None are cross-tenant data exposure, auth bypass, or injection vulnerabilities.

## Security restrictions (do not violate)

- Never commit `.env` files, secrets, API keys, or database backups.
- Never run destructive git operations (`reset --hard`, `push --force`, branch deletion,
  history rewrite) without explicit instruction.
- Never merge PRs, publish releases, or dispatch `deploy.yml`/`staging-release.yml` — these
  require owner action per `docs/release-runbook.md`.
- Never modify production secrets or data.
- Never change the `DATABASE_URL`/`DIRECT_URL` connection role without flagging it as an
  architecture-level decision requiring approval — see below.

## Approved architecture (do not restart without evidence of a critical flaw + approval)

- **Tenant isolation lives at the application layer**, not in RLS. Postgres RLS is fully
  enabled (43/43 tables) and well-built, but the app's Prisma connection uses a role that
  bypasses RLS — real isolation comes from `tenantDb(orgId)` (auto-injects `organizationId` for
  32 allow-listed models) plus manual discipline at `unscopedPrisma` call sites. **This is the
  single most important fact to internalize before touching any database-access code.** Full
  detail: `DATABASE-AUDIT.md` §6.
- **Anthropic Claude is the sole AI generation provider**; OpenAI is embeddings+moderation only.
  A router/fallback abstraction exists but is dead code — don't assume it works.
- **AI chat streaming is deliberately buffered** (full generation + output moderation before any
  client flush). This is a safety trade, not a bug — don't "fix" it without preserving the
  moderation-before-flush guarantee.
- **SSRF defenses (`url-ingestion.ts`) and document-parsing sandboxing (`parser-security.ts`)
  are production-grade and the strongest-engineered parts of the codebase** — do not weaken
  them while working nearby.

## Files that are sources of truth

`docs/PROJECT-CONTEXT.md`, `docs/PROJECT-STATUS.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`,
`docs/NEXT-STEPS.md`, `docs/CLAUDE-HANDOFF.md` (this file), `docs/CODEX-HANDOFF.md`. Supporting
detail lives in `docs/ARCHITECTURE.md`, `docs/FEATURE-INVENTORY.md`, `docs/DATABASE-AUDIT.md`,
`docs/SECURITY-AUDIT.md`, `docs/AI-RAG-AUDIT.md`, `docs/CI-PRODUCTION-READINESS.md`,
`docs/UX-AUDIT.md`. Pre-existing team docs (`docs/release-runbook.md`,
`docs/ci-deployment-enforcement.md`, `docs/ai-chat-production-hardening.md`,
`docs/calendar-booking-v1.md`, `docs/crm-dashboard-v1-release-polish.md`) were verified accurate
during this audit and remain authoritative for their specific subsystems.

Do **not** treat `README.md`'s "Implementation status (v0.1)" table as fully verified — it
predates this audit and is broadly accurate but doesn't reflect the newly-found dependency CVEs,
i18n coverage gaps, or the RLS-bypass nuance. Prefer this documentation set.

`syveka-ai-architecture.md`, referenced by `README.md:4` as "architecture source of truth,"
**does not exist in the repository** — this is a broken reference, not a file to go looking for.

## Exact next task

**P0.1 from `ROADMAP.md`**: fix the failing dependency audit (`npm audit fix` for
`next`/`postcss`/`sharp`). See `CODEX-HANDOFF.md` for full acceptance criteria — this is a
Codex implementation task, not a Claude task, unless explicitly asked to do it directly.

## Commands safe to run (read-only or local-only, no approval needed)

`git status`, `git log`, `git diff`, `git branch -a`, `gh pr list/view/checks`,
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx prisma validate`,
`npx prisma generate`, `npm run i18n:check`, `npm run migrations:check`,
`npm run format:check`, `npm audit --omit=dev --audit-level=high` (read-only check).

## Actions requiring approval

Any `git push`, any PR merge, any `workflow_dispatch` of `staging-release.yml` or `deploy.yml`,
any change to `.env.local`/production secrets, any destructive git command, any change to the
database connection role, the `next-intl` major-version upgrade, and implementing Organization
self-serve deletion (needs a PRD first, per `NEXT-STEPS.md`).
