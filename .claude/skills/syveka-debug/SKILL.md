---
name: syveka-debug
description: Systematic root-cause diagnosis for Syveka problems — Next.js/API errors, auth or organization-membership failures, routing, Prisma/Postgres/PgBouncer, Supabase, Redis, env/config drift, Vercel deployment issues. Use when something is broken, erroring, 500-ing, redirecting wrongly, or behaving differently between environments. Diagnoses and proposes; never changes staging or production.
argument-hint: "[symptom, error message, URL, or environment]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-debug

Symptom: `$ARGUMENTS`

Follow [guardrails](../syveka-context/references/guardrails.md). Orientation map:
[syveka-context](../syveka-context/SKILL.md). Fix only proven problems (CLAUDE.md §1).

## Workflow — do not skip or reorder

1. **REPRODUCE** — exact env (local / preview / staging / prod), URL, user role, org, time, build
   SHA (`curl -s <origin>/api/health` → `.build`). If you cannot reproduce, say so and collect
   evidence anyway.
2. **COLLECT EVIDENCE** (read-only, parallelize independent reads) — error text + stack, route
   file, service function, recent commits on touched paths (`git log -5 -- <path>`), Vercel logs
   (`vercel logs <deployment>` if the human has CLI access), `/api/health` checks.
3. **IDENTIFY LAYER** — pick one, with evidence:

   | Layer          | Tell-tale evidence                                              | Start at                                           |
   | -------------- | --------------------------------------------------------------- | -------------------------------------------------- |
   | Build / deploy | wrong `.build` SHA, missing route, stale alias                  | `syveka-staging-audit` / `syveka-production-audit` |
   | Env / config   | `ZodError`, "Missing required", works in one env only           | `src/env.ts` scoped getter for that integration    |
   | Auth           | 401, redirect loop, `getUser` failure                           | `src/server/auth/session.ts`, `middleware.ts`      |
   | Membership     | "Create your organization" after login, 403 with valid session  | `getTenantContext()`, `organization_members`       |
   | RBAC           | 403 for one role only                                           | `src/server/auth/permissions.ts`, `guard.ts`       |
   | Routing / i18n | 404 under one locale, RTL/label missing                         | `src/app/[locale]/…`, `messages/*.json`            |
   | Database       | `PrismaClient*Error`, `42P05`, `EMAXCONNSESSION`, timeouts      | `syveka-db-diagnostics`                            |
   | Redis / QStash | health `redis: fail`, rate-limit errors, job signature failures | `src/server/integrations/redis.ts`, `jobs/*`       |
   | Provider       | Anthropic/OpenAI/Stripe/Vapi/Resend/fal 4xx/5xx, timeouts       | `src/server/integrations/*`, `src/server/ai/*`     |
   | App logic      | reproducible with valid config and data                         | `src/server/services/<domain>.ts`                  |

4. **FORM HYPOTHESIS** — at most 3, each with the observation that would falsify it.
5. **VERIFY** — run the cheapest falsifying check (unit test, read-only query, local repro).
   Label result VERIFIED / INFERRED / UNKNOWN.
6. **PROPOSE FIX** — smallest correct change, the test that proves it, risk, rollback. Code fixes
   go on a feature branch via the CLAUDE.md §2 workflow. Anything touching staging/prod config,
   data, or deployments is a **HUMAN GATE** (see guardrails).

## Output

```
SYMPTOM · ENV · BUILD SHA
LAYER: <layer> (VERIFIED|INFERRED)
EVIDENCE: <bullets with file:line / command → output>
ROOT CAUSE: <one sentence> (VERIFIED|INFERRED|UNKNOWN)
FIX: <smallest change + test>    HUMAN GATES: <none | list>
```

Never mask a symptom (retry loops, catch-and-ignore, widened timeouts) in place of a root cause.
