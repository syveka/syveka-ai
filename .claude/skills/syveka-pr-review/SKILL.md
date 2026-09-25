---
name: syveka-pr-review
description: Syveka-specific pull request review — correctness, regressions, security, auth, RBAC, RLS, multi-tenant isolation, Prisma schema/migrations, API compatibility, FI/EN/AR i18n and RTL, mobile, tests, observability, and AI cost impact. Outputs BLOCKERS / IMPORTANT ISSUES / OPTIONAL IMPROVEMENTS / VERDICT. Use when asked to review a PR, branch, or diff in this repo. Never merges.
argument-hint: "[PR number | branch | (empty = current branch vs origin/main)]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-pr-review

Target: `$ARGUMENTS` (empty → `git diff origin/main...HEAD`). Follow
[guardrails](../syveka-context/references/guardrails.md). Review the diff, not the whole repo.

## 1. Scope the diff

`git fetch origin main` then `git diff --stat origin/main...<head>`; read full hunks. For a PR
number use `mcp__github__pull_request_read` (diff, files, status). Classify touched areas, then
apply only the matching checks below. Security-heavy diffs → also run `syveka-security-review`.

## 2. Checks by area

| Touched                            | Must hold                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server Action / `api/v1/**` route  | `requirePermission(...)` first; logic lives in `src/server/services`; Zod validator from `src/lib/validators`; rate-limited if state-changing/public; errors sanitized |
| DB access                          | `tenantDb(orgId)` with orgId from `getTenantContext()`; any `unscopedPrisma` has explicit org filter + justification; no raw `@/server/db/prisma` import               |
| `prisma/schema.prisma`, migrations | additive + backward compatible; new tenant-owned model added to `tenantDb` allow-list; `npm run migrations:check`; RLS/grants SQL + `tests/rls` updated                |
| Webhook / QStash job               | signature verified before parsing; idempotent; org resolved from verified payload                                                                                      |
| Env / integration                  | new scoped getter in `src/env.ts`; fails closed; `.env.example` updated; no secret defaults                                                                            |
| Public API / response shape        | backward compatible or explicitly approved                                                                                                                             |
| UI                                 | strings in all of `messages/{fi,en,ar}.json`; logical Tailwind (`ms-/me-/ps-/pe-/text-start`); works at mobile width; no client import of server modules               |
| AI call sites                      | model chosen via `routeModel(task)` (no hardcoded model id); prompt in `src/server/ai/prompts`; untrusted input wrapped; usage/cost recorded; `maxTokens` bounded      |
| Tests                              | new behavior has a focused test; no test skipped/weakened; E2E impact noted                                                                                            |
| Observability                      | failures logged with sanitized context; `audit()` on sensitive mutations                                                                                               |
| Workflows / hooks / lint config    | protected (CLAUDE.md §9) — flag for explicit authorization                                                                                                             |

**AI cost impact:** estimate per-call tokens × expected volume using `src/server/ai/cost.ts`
prices; flag moves to a more expensive tier, unbounded loops/retries, or missing `maxTokens`.

## 3. Output (exact headings)

```
BLOCKERS            — must fix before merge (security, tenant leak, data loss, broken build, failing test)
IMPORTANT ISSUES    — should fix in this PR
OPTIONAL IMPROVEMENTS
VERDICT             — APPROVE-READY | CHANGES REQUESTED | NEEDS DISCUSSION  (+ CI status on head SHA)
```

Each finding: `file:line — problem — concrete failure scenario — suggested fix`. No finding
without a failure scenario. Say "none" for empty sections.

Do not merge, approve on GitHub, enable auto-merge, or post comments unless the user asks.
