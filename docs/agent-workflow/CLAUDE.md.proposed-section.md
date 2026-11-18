# Proposed addition to `CLAUDE.md` (requires human authorization, CLAUDE.md §9)

Insert the two sections below into the root `CLAUDE.md`: "§0 Repository Overview" before
"§1 Safety & Approval Rules", and "§12 Agent Workflow" after "§11 Development Reference". Nothing
in the existing charter is removed or weakened. Both sections describe durable facts about the
repository, not status, and are kept consistent with `docs/DEVELOPMENT.md`.

---

## 0. Repository Overview

**Product.** Syveka AI is a multi-tenant SaaS for Finnish SMBs: AI voice phone assistants (Vapi,
Finnish numbers), an AI chat assistant with RAG over uploaded knowledge, CRM, calendar and
booking, workflows, creator studio and billing.

**Stack.** Next.js 15 App Router with React 19 and TypeScript strict · Tailwind + shadcn/ui
(owned primitives in `src/components/ui`) · Supabase (Postgres + pgvector, Auth, Storage,
Realtime) · Prisma 6 · Anthropic Claude for generation, OpenAI for embeddings and moderation ·
Vapi for voice · Stripe · Resend · Upstash Redis (rate limiting, cache) and QStash (jobs) ·
next-intl with `fi` (default), `en`, `ar` (RTL) · Sentry with an allowlist scrubber · Vercel.
Node 22.x only.

**Structure.**

```
src/app/[locale]/        localized App Router pages
src/app/api/v1/**        API routes (public, webhook, job and booking callers)
src/actions/             Server Actions (thin transport over services)
src/server/services/     business logic, one file per domain
src/server/auth/         session, requirePermission, RBAC matrix, superadmin
src/server/db/           prisma client, tenantDb() extension, unscopedPrisma
src/server/ai/           provider router, retry, RAG, chunking, tools
src/server/voice|jobs|integrations|security|channels|...
src/lib/                 shared client-safe code, validators (Zod), observability
src/components/          feature components by domain + ui primitives
src/i18n/ · messages/    next-intl config and fi/en/ar message catalogs
src/env.ts               per-integration environment validation
prisma/                  schema, tracked migrations, legacy sql, seed
supabase/                Supabase project config
tests/unit               Vitest (the `npm test` suite)
tests/e2e · tests/browser  Playwright smoke and browser harness
tests/rls · tests/integration · tests/migrations · tests/staging  CI/release SQL and scripts
scripts/                 i18n parity, migration history, route templates, CI and release helpers
syveka-skills/           the governed "master skill" orchestration engine (separate package)
docs/                    ARCHITECTURE.md (source of truth), DEVELOPMENT.md, audits, runbooks
.claude/                 guardrail hooks, settings, skills, agents
.github/workflows/       CI (16 required jobs), preview E2E, staging and deploy workflows
```

**Commands.** `npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck` ·
`npm run format:check` · `npm test` · `npm run i18n:check` · `npm run migrations:check` ·
`npm run test:e2e` · `npm run test:browser` · `npm run db:*` (protected, see §9). Details and
single-test invocations: `docs/DEVELOPMENT.md` §1.

---

## 12. Agent Workflow

Engineering sessions are run by an **orchestrator** sub-agent that delegates to specialised
sub-agents defined in `.claude/agents/`. The orchestrator follows §2 step by step and stops at
every §9 protected action. Sub-agents are least-privilege: reviewers are read-only, only
`implementer` edits source, only `test-runner` runs the validation suite, and none of them may
touch protected configuration, run migrations, deploy, merge or read secrets.

| Agent                   | Role                                                                 | Tools                               |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `orchestrator`          | Inspect state, confirm scope, delegate, verify, commit, push, report | Read, Grep, Glob, Bash, Agent       |
| `implementer`           | Smallest correct change plus a focused Vitest test                   | Read, Edit, Write, Grep, Glob, Bash |
| `code-reviewer`         | Correctness and repository conventions                               | read-only + git diff                |
| `security-reviewer`     | Tenant isolation, authz, webhooks, secrets, rate limits, leakage     | read-only                           |
| `test-runner`           | §3 suite via `/verify`, PASS / FAIL / NOT APPLICABLE                 | Bash, Read, Grep, Glob              |
| `db-migration-reviewer` | Prisma schema, migrations, RLS parity, tenantDb coverage             | read-only + `migrations:check`      |
| `i18n-rtl-reviewer`     | fi/en/ar key parity, hardcoded strings, logical Tailwind utilities   | read-only + `i18n:check`            |
| `voice-flow-reviewer`   | Vapi sync, webhook HMAC, tenant binding, cost controls, disclosure   | read-only                           |

Start a task with `@orchestrator <task>` or by asking Claude Code to "use the orchestrator".
Reviews run in parallel; validation runs after implementation; the orchestrator reports and waits
for a human before any merge or deployment. Sub-agent instructions are configuration: changing
them is a §9 protected action and goes through a reviewed pull request.
