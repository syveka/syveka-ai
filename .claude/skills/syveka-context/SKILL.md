---
name: syveka-context
description: Compact Syveka architecture map (directories, services, tenancy, auth, AI, deploy model, release flow, dangerous operations) plus the shared guardrails every syveka-* skill follows. Load this instead of reading large docs/ files when you need orientation in the Syveka repo.
---

# Syveka context (orientation map)

Load deeper material only when the task needs it. Follow links on demand; do not bulk-read `docs/`.

- Shared safety rules for all `syveka-*` skills: [references/guardrails.md](references/guardrails.md)
- Policy: `CLAUDE.md` (always loaded). Implementation conventions: `docs/DEVELOPMENT.md`.

## Stack

Next.js (App Router) + TypeScript on Vercel (`fra1`) · Supabase (Auth, Postgres + pgvector,
Storage) · Prisma via `@prisma/adapter-pg` · Upstash Redis + QStash · Stripe · Vapi · Resend ·
Anthropic (primary LLM) / OpenAI (embeddings, moderation) · fal (Creator Studio media) ·
next-intl `fi` (default) / `en` / `ar` (RTL) · Vitest + Playwright.

## Where things live

| Concern                    | Path                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| Business logic             | `src/server/services/*.ts` (one file per domain)                         |
| Transport (thin)           | `src/actions/*.ts` (Server Actions), `src/app/api/v1/**/route.ts`        |
| Auth / tenant context      | `src/server/auth/session.ts` (`getTenantContext`), `guard.ts`            |
| RBAC matrix                | `src/server/auth/permissions.ts`; superadmin: `superadmin.ts`            |
| Tenant-scoped DB           | `src/server/db/tenant.ts` (`tenantDb(orgId)`, `unscopedPrisma`)          |
| DB client / pooling        | `src/server/db/prisma.ts`, `connection-string-sanitizer.ts`              |
| Env validation (per integ) | `src/env.ts` (`getRedisEnv()`, `getStripeEnv()`, …)                      |
| AI routing / cost          | `src/server/ai/router.ts`, `cost.ts`, `fallback.ts`, `retry.ts`          |
| Creator Studio providers   | `src/server/ai/creator/*`                                                |
| Health (DB, Redis, SHA)    | `src/app/api/health/route.ts` → `{status, checks, build}`                |
| Schema / migrations        | `prisma/schema.prisma`, `prisma/migrations/`, `prisma/sql/`              |
| Tests                      | `tests/unit` (Vitest), `tests/e2e` (Playwright), `tests/rls`, `staging/` |
| Release pipeline           | `.github/workflows/{ci,staging-release,deploy}.yml`                      |
| Release runbook            | `docs/release-runbook.md`                                                |

`syveka-skills/` is a separate product-side skill orchestrator (TypeScript), **not** Claude Code
skills. Don't confuse the two.

## Critical invariants

- Tenant boundary = `getTenantContext()` (server-verified) + `tenantDb()` injection. Prisma's role
  bypasses RLS; RLS protects only Supabase-native paths. `middleware.ts` is UX only (not `/api`).
- Every Server Action / API route calls `requirePermission(...)`; webhooks and QStash jobs verify
  signatures instead. Sensitive mutations call `audit()`.
- Env is validated per integration; secrets fail closed. `SKIP_ENV_VALIDATION=1` is build-only.
- Money = integer cents; IDs = UUIDs; UI strings need `fi`/`en`/`ar` keys; logical Tailwind only.

## Deploy model

- Vercel git auto-deploy of `main` is **disabled** (`vercel.json`). All deploys go through
  GitHub Actions `workflow_dispatch`.
- Staging: _Staging release validation_ (`staging-release.yml`), GitHub `staging` environment;
  migrates staging DB, deploys, then proves the stable staging alias serves `github.sha`.
- Production: _Production release_ (`deploy.yml`): SHA entered twice → release-chain verifier →
  `production` environment approval → migrate → staged deploy (`--skip-domain`) → health check →
  promote → verify `https://syveka.com` and `PROD_URL` serve the candidate SHA.
- Build SHA is inlined as `NEXT_PUBLIC_BUILD_SHA` and served at `/api/health` `.build`.

## Known dangerous operations (never agent-initiated)

Deploy/promote/rollback/alias changes · Vercel/Supabase/GitHub env or secret changes ·
`prisma migrate deploy|dev|reset|resolve`, `db push` · write SQL against staging/prod ·
editing `_prisma_migrations` · user/membership/org mutations in shared environments · merges ·
workflow dispatch · force-push / history rewrite / branch deletion · editing protected config
(`.claude/hooks/config-protection.mjs` list).

## Incident memory (verified history)

- **Stale alias:** a release succeeded while domains kept serving an older deployment → always
  compare EXPECTED SHA vs `/api/health` `.build` per domain.
- **Pooler exhaustion:** `EMAXCONNSESSION` on session-mode pooler → runtime `DATABASE_URL` must be
  the transaction pooler (port `6543`); `DIRECT_URL` must not be.
- **Prepared-statement collisions (42P05 / "bind message supplies N parameters")** after moving to
  the transaction pooler → see `syveka-db-diagnostics`.
- **"Create your organization" after login** → membership/`last_active_org` drift; see
  `scripts/diagnose-staging-auth-membership.ts` (read-only).
