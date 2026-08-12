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

## Repository facts as of this snapshot (2026-07-23) — SUPERSEDED, see addendum below

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

### Addendum (2026-08-12, superseded by the Phase 8 addendum below)

The section above is a stale point-in-time snapshot from 2026-07-23; do not act on its branch,
PR, or milestone facts. As of this addendum: default branch `main`, PR #9 and the
staging-release-validation work are long since resolved/superseded. 44 more PRs have merged
since (#10–#53), most recently Phase 6 (**Production Inbox Integration**) Workstreams A–C: #52
(real Resend inbound/outbound email + security hardening), #53 (thread status/assignment/
read-unread UI, editable AI drafts). PR #54 (Workstream D — channel-adapter registry foundation
for future SMS/WhatsApp/web-chat support) is open, CI-green, awaiting review/merge
authorization.

### Addendum (2026-08-12, later same day) — read this instead for current state

Phase 6 and Phase 7 both completed and merged since the addendum above (PR #54 through PR #59),
then **Phase 8** (10 more PRs, #55 is actually Phase 7 — see exact numbering below) also
completed and merged. Current `main` HEAD: `06c65fb`. Zero open PRs. As always: this addendum is
also a snapshot, not a live feed — run `git status`, `git log`, `gh pr list` before trusting any
of it.

**Phase 7** ("MVP Activation & Real Business Workflow", PRs #55–#59): consolidated Business DNA
into one shared context module (`src/server/business-dna/context.ts`) used identically by Chat/
Voice/Inbox; added operator-controlled CRM-contact creation from an Inbox thread; moved Inbox to
the top of the primary nav; added a truthful email-channel setup-status indicator; added a
"insert real booking link" handoff control in the Inbox reply composer (no fabricated
availability, reuses the existing public booking flow's own protections).

**Phase 8** ("remaining launch-value gaps", PRs #60–#64): added an owner/admin-only org
setup-readiness checklist on the Dashboard (`src/server/services/setup-readiness.ts` — Business
DNA / email channel / booking / CRM, truthful Ready/Setup required/Not configured states, no
external-provider dimension included since none of Voice/Calendar/Stripe billing is part of the
core MVP loop this checklist targets); added a structural prompt-injection defense
(`neutralizeTagBreakout` in `src/server/ai/prompts/untrusted.ts`) wired into every untrusted-data
prompt wrapper, plus fixed a real "invented opening hours" bug in the AI Chat's
`getCalendarAvailability` tool (was hardcoded 09–17 Europe/Helsinki regardless of the org's real
schedule); extended Business DNA into the booking assistant's scheduling replies and the CRM
deal "sales coach" (which previously had zero org-level grounding — a real gap, not just
polish); made the booking-link control available when editing an AI draft, not just composing a
new reply; added operator-controlled linking of an Inbox thread to an **existing** CRM contact
(not just creating a new one).

## Current milestone

The core MVP loop (`Dashboard → Inbox → Thread → Customer context → AI draft → Booking/CRM
action → approval/send`) is functionally complete, including Business DNA grounding across
every AI surface that has a genuine use case for it, structural prompt-injection defenses, and a
truthful org-readiness checklist. The rest of the core platform (CRM, Calendar/Booking, AI
Chat/RAG, Voice, Billing, Workflows) remains functionally complete per prior milestones.

## Completed features (verified, not just claimed)

Auth (Supabase, no Clerk), RBAC, Onboarding, Organizations (except self-serve delete), CRM
(Contacts/Companies/Deals/Activities/Dashboard, deal AI "sales coach" now Business-DNA-grounded),
Calendar & Booking V1 (incl. AI booking assistant now Business-DNA-grounded, external calendar
import sync), Voice AI (Vapi), AI Chat + RAG (Milestone 3 hardening —
upload→extract→chunk→embed→retrieve→cite→moderate→track-cost; `getCalendarAvailability` tool now
reads the org's real schedule instead of hardcoded hours), Stripe billing, Workflows (trigger
coverage partially unverified), Notifications, Audit logs, Analytics, Superadmin, i18n
infrastructure (612/612/612 key parity), Business DNA (settings UI, AI extraction, one shared
context module consumed by Chat/Voice/Inbox/Booking-assistant/Deal-insights, onboarding nudge),
Inbox (email channel, thread workflow, booking-aware + Business-DNA-grounded AI drafts, CRM
contact auto-match + operator-controlled create-or-link, multi-channel adapter foundation,
booking-link handoff in both compose and edit), org setup-readiness checklist on the Dashboard.
Full detail: `FEATURE-INVENTORY.md` (Inbox rows updated through Phase 7; Phase 8 additions not
yet reflected there as of this addendum).

## Active work

None — zero open PRs as of this addendum (2026-08-12).

## Known blockers

Unverified as of 2026-08-12 — re-check `SECURITY-AUDIT.md` and re-run the dependency audit
before trusting this list; it is carried over from the 2026-07-23 snapshot and may be stale:

1. Dependency CVEs fail the blocking CI gate (High) — `SECURITY-AUDIT.md` H1.
2. Calendar webhook has no signature verification (Medium).
3. No CSP header despite a comment claiming one exists (Medium) — **note:** PR #43
   (`fix/csp-security-headers`, merged 2026-08-11) implemented a nonce-based CSP; this blocker
   is likely resolved but not re-verified in this addendum.
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

As of the Phase 8 addendum (2026-08-12): no P0 blockers are open. Candidates for the next phase
(see Phase 8 completion report for full detail, not duplicated here): a global setup-readiness
widget was shipped (Business DNA/email/booking/CRM) but doesn't yet cover Voice/Calendar/Stripe
billing readiness; no real second Inbox channel (SMS/WhatsApp/web chat) has been implemented,
only the registry foundation to add one; `getCalendarAvailability`'s underlying fix (real
schedule instead of hardcoded hours) has not been extended to any equivalent Voice-side tool
gap-check. Separately, unrelated to Inbox: **P0.1 from `ROADMAP.md`** (unverified currency since
2026-07-23): fix the failing dependency audit (`npm audit fix` for `next`/`postcss`/`sharp`). See
`CODEX-HANDOFF.md` for full acceptance criteria — this is a Codex implementation task, not a
Claude task, unless explicitly asked to do it directly.

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
