# Syveka AI — Project Context

Permanent memory file. Read this first in any new session before touching code.
Audit snapshot date: **2026-07-23**. Verified against repository `syveka/syveka-ai`,
local clone `c:\Users\lenovo\Desktop\syveka copy`, branch `chore/staging-release-validation`,
commit `878cda1`.

## 1. Vision

Syveka is a long-term global AI SaaS platform for businesses. The current codebase's own
identity string (`README.md:3`) is narrower — "Multi-tenant AI business assistant for Finnish
SMBs" — reflecting the initial go-to-market wedge (Finland, `fi` default locale, EUR currency,
Europe/Helsinki default timezone, `fra1` Vercel region). The long-term product scope, per the
owner's direction, is broader and will eventually combine:

- AI chat and knowledge assistants (RAG)
- CRM (contacts, companies, deals/pipeline, activities)
- Calendar and booking
- AI voice agents
- Workflow automations
- Marketing tools
- Website builder
- Business analytics
- Customer support
- AI agents
- Portfolio and client projects
- Future mobile applications
- Future business security tools ("Syveka Secure")

**Current priority: finish the core Syveka platform (the modules already under active
development) before expanding into secondary products.** Marketing Suite, Website Builder,
Mobile app, and Syveka Secure are explicitly future/deferred scope — see `ROADMAP.md` P3/P4.

## 2. Target customers

Finnish SMBs first (business ID / Y-tunnus and VAT ID fields on `Organization`, Finnish phone
provisioning for voice agents, `Europe/Helsinki` defaults throughout). Localization already
covers Finnish, English, and Arabic with full parity (488/488/488 keys), indicating an
intended expansion beyond Finland into other EU and Arabic-speaking markets.

## 3. Approved technology stack (verified against actual code, 2026-07-23)

| Technology                                               | Status                                                                                                           | Evidence                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Next.js 15 (App Router)                                  | **Active, primary framework**                                                                                    | `package.json` `next@^15.2.0`; 41 page routes, 18 API routes under `src/app`                                                    |
| TypeScript (strict)                                      | **Active**                                                                                                       | `tsconfig.json`, `npm run typecheck` passes clean                                                                               |
| Supabase (Postgres host, Auth, Storage, Realtime config) | **Active** — Auth + Storage are load-bearing; Realtime is configured but has no confirmed application subscriber | `src/server/supabase/server.ts`, `supabase/config.toml`, `prisma/sql/004_storage.sql`                                           |
| Supabase Auth                                            | **Active, sole auth system**                                                                                     | `src/server/auth/session.ts`, `src/middleware.ts`; no Clerk anywhere in the repo                                                |
| PostgreSQL (+ pgvector, pg_trgm)                         | **Active**                                                                                                       | `prisma/schema.prisma:10`, HNSW index on `document_chunks.embedding`                                                            |
| Prisma                                                   | **Active, central ORM**                                                                                          | `src/server/db/prisma.ts`, `tenant.ts`; 43 models                                                                               |
| Row Level Security                                       | **Active at the database level, but bypassed by the app's own DB connection** — see `DATABASE-AUDIT.md` §6       | `prisma/migrations/20260719000000_initial_security_baseline`                                                                    |
| Stripe                                                   | **Active**                                                                                                       | `src/server/integrations/stripe.ts`, full webhook handler, checkout, billing portal                                             |
| Vapi                                                     | **Active**                                                                                                       | `src/server/integrations/vapi.ts`, `src/server/services/voice.ts`, webhook + post-call job                                      |
| Resend                                                   | **Active**                                                                                                       | `src/server/integrations/resend.ts`, 3 react-email templates                                                                    |
| OpenAI APIs                                              | **Active — moderation and embeddings only, not chat generation**                                                 | `src/server/integrations/openai.ts` (`text-embedding-3-small`, `omni-moderation-latest`)                                        |
| Anthropic Claude                                         | **Active — sole chat/generation model**                                                                          | `src/server/integrations/anthropic.ts`; not in the originally-listed stack but is the actual production LLM                     |
| Clerk                                                    | **Not present** — confirmed absent from `package.json` and all source                                            | N/A                                                                                                                             |
| Redis (Upstash)                                          | **Active**                                                                                                       | `src/server/integrations/redis.ts` — rate limiting, idempotency, entitlement caching                                            |
| QStash (Upstash)                                         | **Active**                                                                                                       | `src/server/jobs/{queue,verify}.ts` — background job queue for embedding, reminders, workflows, post-call processing            |
| Playwright                                               | **Active but minimal**                                                                                           | `playwright.config.ts`, one smoke spec (`tests/e2e/smoke.spec.ts`), run only in the staging-release workflow, not local CI      |
| Zod                                                      | **Active, used pervasively**                                                                                     | One validator file per domain under `src/lib/validators/`; also gates `src/env.ts`                                              |
| Tailwind CSS                                             | **Active**                                                                                                       | `tailwind.config.ts`                                                                                                            |
| shadcn/ui                                                | **Active but minimal owned set**                                                                                 | `src/components/ui/` currently has only button/card/input/label; README documents the `npx shadcn add ...` command for the rest |
| GitHub Actions                                           | **Active, mature**                                                                                               | `.github/workflows/{ci.yml,deploy.yml,staging-release.yml}` — 14-job CI, gated manual staging/production release chain          |
| i18n (en/fi/ar)                                          | **Active, infrastructure complete, coverage inconsistent**                                                       | `messages/*.json` (488 keys, 0 drift); several settings components still hardcode English — see `UX-AUDIT.md`                   |
| Zustand                                                  | **Declared, not used**                                                                                           | `src/stores/` is empty; zero imports anywhere in `src/`                                                                         |
| @tanstack/react-query                                    | **Declared, provider wired, zero consumers**                                                                     | `QueryProvider` wraps the app; no `useQuery`/`useMutation` call sites found                                                     |
| Sentry / Langfuse                                        | **Declared as optional env vars, no SDK integration found**                                                      | `src/env.ts` optional vars; no `@sentry`/`langfuse` imports found in the audited files                                          |

## 4. Development workflow

- Feature branches (`feature/*`, `fix/*`, `chore/*`) → PR into `main` → CI required (14 jobs)
  → merge. Confirmed via GitHub PR history #1–#9, all following this pattern.
- Release flow is a three-stage, manually-gated pipeline: PR CI → manual `workflow_dispatch`
  staging release (exact SHA, real staging Supabase/Vercel projects, Playwright smoke) →
  manual `workflow_dispatch` production release (SHA typed twice, cross-verified against both
  successful CI and staging runs for that exact SHA, protected GitHub `production` Environment
  approval). See `docs/release-runbook.md` and `docs/ci-deployment-enforcement.md` (pre-existing
  team documentation, verified accurate against `.github/workflows/*` during this audit).
- Documentation-driven feature delivery: each major feature shipped so far has a companion doc
  in `docs/` (`ai-chat-production-hardening.md`, `calendar-booking-v1.md`,
  `crm-dashboard-v1-release-polish.md`) describing architecture, RBAC, testing, and known
  limitations at ship time. **Continue this convention** for future features.

## 5. Main architecture decisions (verified, in force)

1. **Tenant isolation is enforced primarily at the application layer**, via a Prisma Client
   Extension (`tenantDb(orgId)`) that auto-injects `organizationId` into every query for an
   allow-listed set of 32 models, plus manual per-call-site filtering for the remainder
   (`unscopedPrisma`). Postgres RLS is also fully enabled (43/43 tables) but is bypassed by the
   app's own service-role database connection — RLS is real protection only for direct
   Supabase Storage/PostgREST/Realtime access, not for the Next.js/Prisma application path. See
   `DATABASE-AUDIT.md` §6 for full detail. **This is the single most important architectural
   fact for any future contributor to understand before touching database access code.**
2. **Composite foreign keys tie child records to their parent's organization** for the
   highest-risk relations (`Document`↔`Collection`, `DocumentChunk`↔`Document`,
   `ConversationDocument`↔`Conversation`/`Document`) — added retroactively in migration
   `20260715230000_security_invariant_corrections` after being shipped without this guarantee
   two hours earlier. This pattern is not used for most other cross-model relations (e.g.
   `Contact.company`, `Deal.contact`), which rely on application-layer discipline only.
3. **Anthropic Claude is the only generation model in production use.** OpenAI is used
   exclusively for moderation and embeddings. A model-router/fallback abstraction exists in
   code (`src/server/ai/router.ts`) but the OpenAI failover path is never actually invoked —
   treat it as unimplemented, not as a working multi-provider system, until wired up.
4. **AI chat streaming is intentionally buffered, not token-streamed to the client.** The full
   response is generated and passed through output moderation server-side before any text is
   sent, then replayed to the client in fixed 120-character chunks to simulate streaming. This
   is a deliberate safety trade documented in `docs/ai-chat-production-hardening.md` — do not
   "fix" it into true token streaming without an equivalent moderation-before-flush guarantee.
5. **Money is stored in integer cents; IDs are UUIDs; every sensitive mutation calls `audit()`.**
   These are repo-wide conventions, not per-feature choices (`README.md` "Non-negotiable
   conventions").
6. **RLS/SQL and Prisma migrations are two separate systems that must stay in sync manually.**
   RLS policies, extensions, and Storage bucket policies live in `prisma/sql/*.sql`
   (hand-applied) in addition to being formalized in later tracked Prisma migrations. A fresh
   environment provisioned purely via `prisma migrate deploy` does **not** get Storage buckets —
   that step (`prisma/sql/004_storage.sql`) has no tracked-migration equivalent. Treat this as a
   deployment-runbook responsibility, not something Prisma alone handles.
7. **RBAC is a fixed 5-role matrix** (OWNER, ADMIN, MANAGER, MEMBER, VIEWER) defined once in
   `src/server/auth/permissions.ts` and enforced via `requirePermission()` at the start of every
   Server Action and API route handler. Superadmin is a **separate axis** gated on
   `auth.users.app_metadata.is_superadmin` (not a role value, not user-settable) — do not
   conflate the two systems.

## 6. Core product priorities (current)

In dependency order, per what is already built and what remains — see `ROADMAP.md` for the
full prioritized breakdown:

1. Close the P0 production blockers (dependency CVEs, calendar webhook signature, missing CSP,
   unrate-limited file-ingestion endpoints) before any production deploy.
2. Finish i18n coverage gaps (Members, API Keys, Organization/Profile settings, Onboarding).
3. Decide and either wire up or remove: `fallbackModel()` dead code, Zustand, react-query.
4. Then continue toward full production launch of the already-built core (CRM, Calendar/
   Booking, AI Chat/RAG, Voice, Billing, Workflows) — most of which is functionally complete
   per `FEATURE-INVENTORY.md`.

## 7. Future product areas (explicitly deferred, not started)

Portfolio/client-projects module, Marketing Suite, Website Builder, mobile applications,
"Syveka Secure" (paid security add-on), public REST API surface beyond webhooks (the
`resolveApiKey` auth helper exists and is ready per `README.md:82`, but no public API routes
consume it yet), Google/Outlook calendar **outbound** sync (inbound/import sync exists),
CSV contact import UI, PWA push notifications, RAG re-ranking, custom-LLM voice mode.

## 8. Cost principles

- Lowest reasonable monthly cost is a stated design principle. The stack already favors
  pay-as-you-go/serverless services (Vercel, Supabase, Upstash Redis+QStash) over fixed
  infrastructure.
- AI cost is actively metered: real token usage from provider responses (not estimated) ×
  a static price table, recorded per-message and rolled up into `UsageRecord`, gated by
  plan-tier entitlements (`assertWithinLimit`) before generation is allowed.
- Known unmetered cost-risk surfaces (see `SECURITY-AUDIT.md` and `AI-RAG-AUDIT.md`): the
  knowledge-base/chat-file upload and embed-document pipeline has **no dedicated rate limiter**,
  only a storage-size entitlement checked at upload-URL issuance — a user could enqueue many
  documents in quick succession bounded only by per-file size (25MB) and monthly storage quota,
  not by requests-per-minute.
- Do not introduce a new paid service before checking whether an existing one (Redis, QStash,
  Supabase Storage) already covers the need — the stack is intentionally consolidated.

## 9. Decisions that must not be reversed without explicit owner approval

See `DECISIONS.md` for the full list. Highlights relevant to any coding session:

- Do not replace `tenantDb()`/`unscopedPrisma` application-layer tenant scoping with "RLS will
  handle it" reasoning — RLS does not protect the Prisma connection today (see §5.1 above).
  Any change to the database connection role (e.g. switching to a non-bypassing role) is an
  architecture-level decision requiring explicit owner approval, not a routine fix.
- Do not restart or replace the AI chat/RAG architecture (Anthropic generation + OpenAI
  moderation/embeddings + pgvector retrieval) without evidence of a confirmed critical flaw —
  it is deliberately and non-trivially engineered (see `AI-RAG-AUDIT.md`).
- Do not remove or weaken the URL-ingestion SSRF defenses (`src/server/security/url-ingestion.ts`)
  or the document-parsing sandboxing (`src/server/security/parser-security.ts`) — both are
  verified production-grade and are the strongest-engineered parts of the codebase.
- Do not silently fold future "correction" migrations into the migration they're fixing —
  the existing convention (see `20260715230000_security_invariant_corrections`) is to ship
  corrections as separate, clearly-commented additive migrations, preserving history.
- Do not treat `README.md`'s "Implementation status (v0.1)" table as verified fact — several
  rows (e.g. blanket "✅" for testing, CI/CD) are broadly accurate but the table predates this
  audit and does not reflect the newly-found dependency CVEs, i18n coverage gaps, or the
  RLS-bypass nuance. Prefer this documentation set going forward.
