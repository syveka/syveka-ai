# Syveka AI — Changelog

No `CHANGELOG.md` existed prior to this entry. The release history below for PRs #1–#9 is
reconstructed from verified Git/GitHub history (`git log`, `gh pr list --state all`) as a
starting baseline — never delete entries below; add new ones above the oldest, newest at top of
its section, and never rewrite history that's already merged.

## 2026-07-23 — Full project audit and permanent documentation snapshot

Performed a complete repository, architecture, database, security, AI/RAG, CI/CD, and UX audit
of Syveka AI (branch `chore/staging-release-validation`, commit `878cda1`) and created the
permanent documentation set under `docs/`: `PROJECT-CONTEXT.md`, `PROJECT-STATUS.md`,
`ARCHITECTURE.md`, `FEATURE-INVENTORY.md`, `DATABASE-AUDIT.md`, `SECURITY-AUDIT.md`,
`AI-RAG-AUDIT.md`, `CI-PRODUCTION-READINESS.md`, `UX-AUDIT.md`, `DECISIONS.md`, `ROADMAP.md`,
`NEXT-STEPS.md`, `CLAUDE-HANDOFF.md`, `CODEX-HANDOFF.md`, and this file. No product code was
changed. Headline findings:

- Core platform (auth, CRM, calendar/booking, AI chat/RAG, voice, billing, workflows, i18n
  infrastructure) is functionally complete and well-tested — this is a hardening/finishing
  phase, not a rebuild.
- The dependency-audit CI gate that last passed 2026-07-20 now fails locally (new CVEs in
  `next`/`postcss`/`sharp`/`next-intl`) — flagged as the top-priority next task.
- Tenant isolation is enforced at the application layer (`tenantDb()` + manual discipline), not
  by Postgres RLS — the app's Prisma connection bypasses RLS. RLS remains fully enabled (43/43
  tables) as a real backstop only for the Supabase-native client surface.
- SSRF defenses and document-parsing sandboxing were re-verified as production-grade, resolving
  prior-review concerns.
- Three Medium-severity hardening items found: missing calendar-webhook signature verification,
  missing CSP header (despite a comment claiming one exists), and unrate-limited file/URL
  ingestion endpoints.
- AI chat streaming is confirmed to be a deliberate buffered design (full generation + output
  moderation before any client flush), not a defect.
- i18n infrastructure is complete (488/488/488 key parity) but coverage has gaps in several
  settings/onboarding components.

## Reconstructed prior release history (from Git/GitHub, not previously documented)

### PR #9 — Prepare and validate first safe staging release (`chore/staging-release-validation`) — OPEN/DRAFT

Staging release validation preparation: migration-history compatibility contract, legacy-baseline
preflight, staging/production release workflows, cross-platform migration checksum fixes.

### PR #8 — Track and test Calendar & Booking RLS migration (merged 2026-07-18)

Tracked the Calendar & Booking RLS migration (`20260718000000_calendar_booking_rls`) as a formal
Prisma migration rather than a standalone SQL script.

### PR #7 — Fix workflow translations and i18n validation (merged 2026-07-16)

Corrected dotted translation keys into nested objects; strengthened the i18n parity checker;
fixed CI workflow translation issues.

### PR #6 — AI Chat Production Hardening — Milestone 3 (merged 2026-07-13)

Delivered the production-hardening pass documented in `docs/ai-chat-production-hardening.md`:
SSE streaming (buffered-by-design), rate limiting, Zod validation, double-sided moderation,
token/cost tracking, conversation summaries, citation verification, retry handling, secure file
upload pipeline, embeddings, and a substantial test suite.

### PR #5 — CRM Calendar & Booking Assistant V1 (merged 2026-07-13)

Delivered Calendar & Booking V1 per `docs/calendar-booking-v1.md`: availability engine, public
booking pages, guest booking with transactional double-booking protection, token-based
cancel/reschedule, external calendar sync (Google/Microsoft import), AI booking assistant.

### PR #4 — Add CRM Deals & Sales Pipeline module (V1) (merged 2026-07-12)

Deals, pipelines, pipeline stages, and the sales-pipeline Kanban UI.

### PR #3 — Add CRM Contacts & Companies module (V1) (merged 2026-07-12)

Contacts and Companies CRUD, search, archive/restore, notes-as-activities, GDPR consent capture.

### PR #2 — CRM Dashboard V1 (merged 2026-07-11)

CRM dashboard with sales-funnel/win-rate aggregation; the only route with dedicated
`loading.tsx`/`error.tsx`.

### PR #1 — Production readiness hardening for v0.1.0-rc.2 (merged 2026-07-10)

Initial production-readiness pass: foundation (Next.js 15, TypeScript strict, Tailwind/shadcn,
Prisma, Supabase Auth, env validation), RBAC, initial RLS/security baseline.
