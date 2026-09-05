# Syveka AI — Development Reference

This is a living technical reference for working in this codebase day to day: commands,
architecture, and implementation-level conventions. It does not set policy and never overrides
or supersedes the rules in the repository's `CLAUDE.md` Engineering Charter — if anything here
ever conflicts with that file, the charter wins.

## 1. Commands

Use Node.js 22.x for local development, CI, staging, and production builds. This matches the
runtime declared in `package.json` and the minimum supported by the current Supabase client.

```bash
npm run dev              # Next.js dev server
npm run build             # prisma generate && next build
npm run lint               # ESLint (flat config, next/core-web-vitals + next/typescript)
npm run typecheck          # tsc --noEmit
npm run format / format:check   # Prettier (writes / checks)
npm test                    # vitest run — all of tests/unit/**/*.test.ts
npx vitest run tests/unit/permissions.test.ts   # single test file
npx vitest run -t "test name"                    # single test by name
npm run test:e2e            # Playwright, tests/e2e/** (needs E2E_BASE_URL in CI)
npm run i18n:check           # locale key parity across messages/{en,fi,ar}.json
npm run migrations:check     # prisma/migrations order + checksum validation
npm run db:generate / db:migrate / db:deploy / db:seed / db:studio
```

Local setup, Supabase/Stripe one-time configuration, and the exact migration sequencing
(tracked Prisma migrations vs. the hand-applied `prisma/sql/001-006` scripts) are documented in
`README.md`. The full CI job graph — 16 required jobs including RLS isolation under both a
superuser and a non-superuser Supabase-like role, migration drift/legacy-upgrade tests, and a
gitleaks secret scan — is defined in `.github/workflows/ci.yml`; read a job's steps directly
before assuming what a script name checks.

## 2. Architecture source of truth

`docs/ARCHITECTURE.md` is the authoritative, verified architecture description (component map,
tenant-isolation sequence diagram, AI/RAG flow, billing flow, deployment flow) and is kept
current with the actual repository state — prefer it over re-deriving architecture from scratch.
`docs/DATABASE-AUDIT.md`, `docs/AI-RAG-AUDIT.md`, `docs/SECURITY-AUDIT.md`, and
`docs/TENANTDB-ARCHITECTURE-AUDIT.md` hold the detailed, model-by-model / flow-by-flow findings
behind it. Other files under `docs/` (`ROADMAP.md`, `PROJECT-STATUS.md`, `NEXT-STEPS.md`,
`*-HANDOFF.md`) are point-in-time status snapshots, not standing architecture — verify against
live repo state (`git log`, `git status`) before trusting them.

## 3. Stack

Next.js 15 (App Router, React 19) · TypeScript strict · Tailwind + shadcn/ui (owned primitives in
`src/components/ui`) · Supabase (Postgres + pgvector, Auth, Storage, Realtime) · Prisma ·
Anthropic Claude (generation) + OpenAI (embeddings/moderation only) · Vapi (voice) · Stripe ·
Resend · Upstash (Redis rate-limiting/cache, QStash background jobs) · next-intl (`fi`/`en`/`ar`,
RTL for Arabic).

## 4. Request-flow architecture

Business logic lives almost entirely in `src/server/services/*.ts` (one file per domain: crm,
calendar, billing, voice, workflows, ...). `src/actions/*.ts` (Server Actions, authenticated app
UI) and `src/app/api/v1/**/route.ts` (API routes: public/webhook/job/booking callers) are both
thin transport layers over the same service functions — put new business logic in a service, not
in an action or route handler.

Every Server Action / API handler independently calls `requirePermission(...)`
(`src/server/auth/guard.ts`), which calls `getTenantContext()` (`src/server/auth/session.ts`) to
do a real `supabase.auth.getUser()` validation and resolve `{orgId, userId, role}`.
`middleware.ts` only checks Supabase session _cookie presence_ for UX redirects and its matcher
excludes all `/api` routes — it is not a security boundary. Webhooks and QStash job routes verify
their own signatures instead of going through `requirePermission`.

Superadmin (`src/server/auth/superadmin.ts`) is a separate authorization axis from the RBAC role
matrix, gated on `auth.users.app_metadata.is_superadmin` (Supabase dashboard only, never app UI).

## 5. Tenant isolation

- `tenantDb(orgId)` (`src/server/db/tenant.ts`) is a Prisma Client Extension that auto-injects
  `organizationId` into every query for an allow-listed set of directly tenant-owned models.
  Models scoped only via a parent relation (`Message`, `PipelineStage`, `DocumentChunk`,
  `EventAttendee`, etc.) are deliberately excluded — access those through their parent or the
  owning service function.
- `unscopedPrisma` is the escape hatch for cross-tenant infrastructure code (webhooks, jobs);
  org filtering there is manual and must be added explicitly at each call site.
- Raw `@/server/db/prisma` imports are banned outside `src/server/db` by an ESLint
  `no-restricted-imports` rule (`eslint.config.mjs`) — always go through `tenantDb()` or
  `unscopedPrisma`.
- `DATABASE_URL`/`DIRECT_URL` connect as a role that bypasses Postgres RLS, so RLS protects only
  Supabase-native client paths (PostgREST/Realtime/Storage) — the actual tenant boundary for the
  Prisma/Next.js app is `tenantDb()`'s injection plus disciplined `unscopedPrisma` usage. See
  `docs/ARCHITECTURE.md` §5 and `docs/DATABASE-AUDIT.md` for the verified detail.

## 6. RBAC

`src/server/auth/permissions.ts` is the single source of truth: a `Permission` union, a
per-role (`OWNER`/`ADMIN`/`MANAGER`/`MEMBER`/`VIEWER`) permission set, and `can(role, permission)`.
API-key scopes (`SCOPE_PERMISSIONS`) map external scopes onto the same permissions. Add a new
permission here first, then gate the Server Action/route with `requirePermission(...)`.

## 7. Environment validation

`src/env.ts` validates env vars **per integration**, not with one monolithic schema — e.g.
`getRedisEnv()`, `getSupabaseServerEnv()`, `getQstashEnv()`, `getStripeEnv()`, `getVapiEnv()`,
`getOpenAIEnv()`, `getAnthropicEnv()`, `getResendEnv()` each `.pick()` only the fields that
integration needs from the full `serverSchema` and validate independently. This is deliberate
(see the comments above `getRedisEnv`/`getSupabaseServerEnv`/`getQstashEnv`): reading a narrow
integration's config through the merged `env` proxy previously made one team's unrelated
misconfigured field 500 every route touching a different integration. When adding a new
integration, add a new scoped getter rather than extending call sites to read from `env`
directly. `SKIP_ENV_VALIDATION=1` bypasses validation only for CI/build-time compilation without
real secrets — runtime always validates.

## 8. AI provider routing

`src/server/ai/router.ts` maps a small `AiTask` enum (`chat`, `deep`, `utility`, `title`,
`sentiment`, `summary`) to a pinned `{provider, model, maxTokens}` — model upgrades are a
one-line config change here, not a code change at call sites. `src/server/ai/retry.ts` wraps
provider calls with the shared retry policy (`AI_RETRY_MAX_ATTEMPTS`/`AI_RETRY_BASE_DELAY_MS`).
RAG retrieval (`src/server/ai/rag.ts`), chunking (`chunking.ts`), extraction (`extract.ts`), and
tool definitions (`src/server/ai/tools/`) are separate modules the chat route composes — see
`docs/ARCHITECTURE.md` §7 for the full moderate → retrieve → generate → moderate → persist flow.

## 9. i18n / RTL conventions

Routes are nested under `src/app/[locale]/...` (`next-intl`, locales `fi`/`en`/`ar`, `fi`
default). RTL is applied once globally via `<html dir>` in the root locale layout for `ar`.
Feature code must use logical Tailwind utilities (`ms-*`/`me-*`/`ps-*`/`pe-*`/`text-start`/
`text-end`/`start-*`/`end-*`) — physical-direction utilities (`ml-`, `mr-`, `pl-`, `pr-`,
`text-left`, `text-right`, `left-`, `right-`) are blocked by an ESLint `no-restricted-syntax`
rule. Every UI string needs matching keys in all three `messages/*.json` files —
`npm run i18n:check` enforces parity.

## 10. Windows / money / ID conventions

- This development environment is Windows with PowerShell as the primary shell. When running
  the commands in §1 directly (outside of tooling that already wraps them), use PowerShell
  syntax: `$env:VAR = 'value'` instead of `VAR=value cmd`, `;` instead of `&&` for unconditional
  chaining, and forward slashes or `Join-Path` rather than assuming a POSIX path separator.
  `npm run <script>` itself is shell-agnostic and works the same from either shell.
- Money is stored as integer cents; IDs are UUIDs.
- Zod schemas in `src/lib/validators/*.ts` are shared between forms (via
  `@hookform/resolvers`) and Server Actions/API handlers — add or extend a validator there rather
  than duplicating shape checks at the call site.
- Every sensitive mutation calls `audit()` (`src/server/services/audit.ts`), which writes an
  `AuditLog` row.

## 11. Tests and verification guidance

- `tests/unit/**/*.test.ts` — Vitest, `tests/setup/env.ts` seeds a fake env, `server-only` is
  aliased to a no-op mock (`tests/mocks/server-only.ts`) so server modules import in Node.
- `tests/rls/*.sql` and `tests/integration/*.sql` — RLS isolation and tenant-relationship
  invariants, run against a real `pgvector/pgvector:pg15` Postgres via
  `scripts/ci/run-rls-check.sh`; not runnable meaningfully without that harness.
- `tests/e2e/*.spec.ts` — Playwright smoke tests (`playwright.config.ts`); `desktop` + `mobile`
  (Pixel 7) projects, `fi-FI` locale by default.
- Release-time-only checks (`tests/staging/*.sql`, `tests/migrations/*.sql`) back the deploy
  pipeline in `docs/release-runbook.md` — don't run them as general-purpose test iteration.

## 12. Agent guardrails

Two repository-local Claude Code `PreToolUse` hooks (`.claude/hooks/block-no-verify.mjs`,
`.claude/hooks/config-protection.mjs`, wired in `.claude/settings.json`) give CLAUDE.md §9's
policy a technical backstop:

- **`block-no-verify`** unconditionally blocks any agent command that bypasses git verification
  hooks (`--no-verify`, `commit -n`, `-c core.hooksPath=`). There is no override — a genuinely
  approved bypass must be run by a human directly, not the agent.
- **`config-protection`** blocks agent `Edit`/`Write` access to security/quality-critical shared
  config (ESLint/Prettier/tsconfig, CI workflows, `.claude/settings.json` and hooks, `CLAUDE.md`,
  the CI verification scripts, and `package.json`'s required validation script entries).

To make an intentional, reviewed change to one of these protected files, a human starts the
session with:

```
SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1
```

set in their own shell environment before launching Claude Code. The agent cannot set this
itself. Only use it for a specific change you've already decided to make — it is not a general
opt-out, and it has no effect on `block-no-verify`: git verification-hook bypasses remain
unavailable to agents regardless of this variable.

## 13. DATABASE_URL-gated E2E specs

A handful of `tests/e2e/*.spec.ts` files (`rbac-boundary.spec.ts`, `tenant-isolation.spec.ts`,
one test in `booking.spec.ts`) need direct database access that a real browser session can't
provide — seeding a disposable second organization, or temporarily flipping the shared E2E
fixture user's role to observe a permission boundary. They import `tests/e2e/helpers/db.ts` and
call `hasDbAccess()` (true only when `DATABASE_URL` is set in the Playwright process's
environment) to `test.skip(...)` cleanly with a concrete reason when it's absent, rather than
failing.

**Wired into `staging-release.yml`** as of the explicitly human-authorized change adding
`DATABASE_URL: ${{ secrets.STAGING_DIRECT_URL }}` to its "Run essential staging smoke tests" step
— reusing the same existing secret `scripts/ensure-e2e-org-fixture.ts` already uses, not a new
one. `ci.yml` still never provides `DATABASE_URL`/`E2E_USER_EMAIL` to Playwright at all (it has no
staging/database secrets to give it — see §14), so these specs continue to skip cleanly there.

The same specs restore/delete everything they create in a `finally` block — the role-restore in
`rbac-boundary.spec.ts` re-throws on failure (a stuck role change corrupts the shared fixture for
every later run) rather than swallowing the error.

## 14. Two-tier Playwright execution

- **Tier A — `ci.yml`'s `e2e-smoke` job** (`pr-smoke` Playwright project): runs on every PR, no
  secrets, no staging. Spins up an ephemeral empty Postgres (the same `pgvector/pgvector:pg15`
  service container pattern the `rls` job uses), deploys migrations, builds and serves the app
  locally with placeholder `NEXT_PUBLIC_*`/`SKIP_ENV_VALIDATION=1` config, then runs the
  unauthenticated subset of `smoke.spec.ts` + `booking.spec.ts`'s 404 test. Deliberately excludes
  `smoke.spec.ts`'s "health endpoint is green" and the AI-API-auth-enforcement test: `/api/health`
  also checks Redis (`@upstash/redis`, an HTTP-protocol client with no local Postgres-style
  service-container equivalent already in use here), and the AI route goes through the same
  Redis-backed rate limiter — neither is safely reproducible without introducing a new,
  unvetted third-party dependency, so they're left to Tier B. **Not yet in `ci-required`'s
  `needs` list** — genuinely new infrastructure, kept in observe-only mode until proven reliable
  across several real runs, then promote it.
- **Tier B — `staging-release.yml`'s existing Playwright step**: authenticated, real-staging-deployment
  execution (`desktop`/`mobile`/`rbac-mutations` projects), unchanged in scope, now additionally
  `DATABASE_URL`-enabled (§13). Only runs from `main`, via manual `workflow_dispatch` — this gate is
  deliberate (job-level `if` plus an in-script re-check) and was not weakened.

A real per-branch Tier-B run (deploying an unmerged branch to shared staging, or relaxing the
main-only gate) was evaluated and rejected as something to do unilaterally: `staging-release.yml`'s
deploy+migrate step is a genuine deployment action against shared infrastructure, and CLAUDE.md §9
reserves "Deployment or workflow dispatch" as needing its own separate authorization beyond
workflow-file edits. Given an explicit, narrowly-scoped human authorization for one specific
verification run, a **`TEMPORARY-STAGING-EXCEPTION`** (grep for that marker) was added to both the
job-level `if` and the in-script re-check in `staging-release.yml`, allow-listing the exact branch
name `feat/e2e-production-readiness` alongside `main` — no patterns, no PR-controlled input, and
every other check (project-ref confirmation, staging≠production cross-checks, the `environment:
staging` required-reviewer gate) stays fully intact. **This must be removed once that verification
run succeeds** — see the PR #115 thread for status.

## 15. Connection-string sanitization gaps (staging run 33961238272)

That run failed at "Read-only legacy compatibility preflight" with
`FATAL: database "postgres\n" does not exist` — a trailing newline embedded in the
`STAGING_DIRECT_URL` secret's stored value, reaching `psql` unsanitized. This is the same
corruption class `src/server/db/connection-string-sanitizer.ts` was built to fix after a prior,
identical incident (2026-08-28) — but that fix only ever covered the deployed app's own Prisma
client (`src/server/db/prisma.ts`). Two other consumers of the same secret went through this
release, unnoticed until now, without it: `scripts/ensure-e2e-org-fixture.ts` and
`tests/e2e/helpers/db.ts` (both now call `sanitizeConnectionString()` before constructing their
`PrismaClient`). `staging-release.yml`'s raw `psql "$STAGING_DIRECT_URL"` invocations remain
unsanitized — psql/libpq has no equivalent hook to apply the same fix to, so:

- `scripts/validate-database-url-shape.mjs` was added: a dependency-free, redaction-safe shape
  validator (host/port/database/user/project-ref shape, pooler-vs-direct semantics, trailing
  whitespace detection) that would have caught this exact defect immediately, before any of the 17
  expensive steps that ran before the actual failure. It is a standalone script, not yet wired into
  any workflow — see the PR #115 thread for the exact recommended integration point (an early step
  in `staging-release.yml`, which is guardrail-protected and wasn't edited here beyond the
  explicitly authorized temporary branch exception above).
- `scripts/ensure-e2e-org-fixture.ts` also now repairs the shared E2E user's role back to `OWNER`
  if it's ever found to be anything else on a run's own no-op check — recovery for an
  `rbac-boundary.spec.ts` run interrupted between its role-flip and its `finally` restore.
- `tests/e2e/helpers/db.ts`'s `findE2EFixtureMembership()` now refuses to return a membership
  whose organization name isn't exactly `"Syveka E2E Fixture"` — a mutating E2E test can never act
  on a real organization even if `DATABASE_URL`/`E2E_USER_EMAIL` were ever misconfigured.
