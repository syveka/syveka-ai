---
name: syveka-security-review
description: Syveka security review of a diff or area touching Supabase Auth, RLS, organization isolation, RBAC, Prisma access, server actions, API routes, secrets, webhooks, Stripe, Vapi, Resend, OpenAI/Anthropic/OpenRouter, QStash jobs, or admin/superadmin features. Focus on cross-tenant data exposure. Use before merging security-sensitive changes or when asked for a security review/audit.
argument-hint: "[PR number | branch | path]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-security-review

Target: `$ARGUMENTS` (empty → `origin/main...HEAD`). Follow
[guardrails](../syveka-context/references/guardrails.md). Report only findings with a concrete
exploit or failure scenario. Prior audits for context (read only if needed):
`docs/SECURITY-AUDIT.md`, `docs/DATABASE-AUDIT.md`, `docs/TENANTDB-ARCHITECTURE-AUDIT.md`.

## Priority 1 — cross-tenant exposure

For every new/changed data access, answer: _where does `orgId` come from?_

- ✅ `getTenantContext()` / `requirePermission()` result, or a signature-verified webhook/job
  payload resolved server-side.
- ❌ request body, query string, route param, header, cookie, `app_metadata` claim used without
  membership re-check, or a client-supplied `organizationId`.
- `unscopedPrisma` queries must filter by the verified org explicitly. Parent-scoped models
  (`Message`, `PipelineStage`, `DocumentChunk`, `EventAttendee`, …) are not auto-scoped by
  `tenantDb` — check access goes through the owning parent.
- Lookups by id (`findUnique({ where: { id } })`) must also constrain org, or be via `tenantDb`.
- Raw SQL (`$queryRaw`, RAG `match_chunks`) must bind org as a parameter.
- Storage paths tenant-prefixed; `documents` bucket stays private.

## Priority 2 — surface-specific checks

| Surface                                  | Check                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server Actions / API                     | `requirePermission` before any read/write; correct permission for the verb; Zod-validated input                                                          |
| RBAC                                     | new permission in `src/server/auth/permissions.ts`; least-privilege role mapping; API-key scope mapping                                                  |
| Superadmin                               | gated by `src/server/auth/superadmin.ts` (`app_metadata.is_superadmin`), never by UI flag or role                                                        |
| RLS / grants (SQL)                       | new tables: RLS enabled, no broad `authenticated`/`anon` policies on server-only tables; `tests/rls` updated                                             |
| Webhooks (Stripe, Vapi, inbox, calendar) | signature verified on raw body before use; idempotency; replay window; no org from unverified input                                                      |
| QStash jobs (`api/v1/jobs`)              | `verifyJobRequest` first; job payload org re-validated                                                                                                   |
| Rate limiting                            | state-changing / cost-amplifying / public routes use `rateLimiters` / `limitAiChat` (`integrations/redis.ts`)                                            |
| Secrets / env                            | scoped getter in `src/env.ts`; fail closed; no fallback secret; nothing secret in `NEXT_PUBLIC_*`                                                        |
| Errors / logs                            | `sanitizeErrorMessage` (`src/server/security/error-sanitization.ts`); no stack/secret/PII in responses                                                   |
| AI providers                             | untrusted content wrapped (`src/server/ai/prompts/untrusted.ts`); tools re-check tenant + permission; no conversation/PII in logs; only needed data sent |
| Ingestion (URLs/files)                   | SSRF/parser guards in `src/server/security/*-ingestion.ts` used                                                                                          |
| Stripe / billing                         | amounts in cents server-side; plan/entitlements never from client                                                                                        |
| Audit                                    | sensitive mutation calls `audit()`                                                                                                                       |

## Output

```
SECURITY REVIEW — <target>
CRITICAL | HIGH | MEDIUM | LOW   (file:line — issue — exploit scenario — fix)
CROSS-TENANT ANALYSIS: <each data access → org source → verdict>
CONTROLS WEAKENED: none | list   (tenant, RLS, RBAC, auth, rate-limit, audit)
VERDICT: SAFE TO MERGE | FIX REQUIRED
```

Never test exploits against staging or production data.
