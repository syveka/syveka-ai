---
name: syveka-staging-audit
description: Safe, read-only staging audit — deployment and served build SHA, stable alias, environment/Supabase/database identity, Redis, required env vars (names only), auth, organization membership, health and critical API endpoints, migration status, E2E readiness. Always verifies EXPECTED SHA vs SERVED SHA. Use after a staging release or before approving promotion.
argument-hint: "[expected 40-char SHA | (empty = origin/main tip)]"
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-staging-audit (read-only)

Expected SHA: `$ARGUMENTS` (empty → `git fetch origin main && git rev-parse origin/main`).
Follow [guardrails](../syveka-context/references/guardrails.md). Staging is **observe-only**:
no deploys, alias changes, env edits, migrations, fixture writes, or data changes.

A successful deploy does **not** prove the right build is served — Syveka has shipped a release
whose domains kept serving an older deployment. SHA comparison is mandatory.

## Checks (run independent probes in parallel)

| #   | Check                  | How (read-only)                                                                                                                                         |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | EXPECTED vs SERVED SHA | `node .claude/skills/syveka-context/scripts/check-served-sha.mjs <sha> https://syveka-ai-staging.vercel.app` (+ any per-deployment URL under review)    |
| 2   | Workflow evidence      | latest _Staging release validation_ run for that SHA: conclusion, "Prove the stable staging alias serves the candidate" step (`mcp__github__actions_*`) |
| 3   | Alias → deployment     | `vercel alias ls` / `vercel inspect <url>` if the human has CLI access; otherwise mark UNKNOWN                                                          |
| 4   | Environment identity   | workflow's project-ref guard passed (rejects prod ref / prod Vercel project); report ref as last 4 chars                                                |
| 5   | DB + Redis             | `/api/health` `checks.database` / `checks.redis`                                                                                                        |
| 6   | Required env vars      | names only, from `src/env.ts` getters vs `vercel env ls` (names) — never values, never `vercel env pull`                                                |
| 7   | Auth                   | unauthenticated `/api/v1/ai/chat` → 401; login page renders                                                                                             |
| 8   | Membership             | if login redirects to onboarding: `readonly-staging-auth-membership-diagnostic.yml` results (human dispatches it)                                       |
| 9   | Migrations             | CI `migrate status` step output for the SHA; `npm run migrations:check` locally                                                                         |
| 10  | E2E readiness          | smoke step result for the SHA; fixtures present; bypass secret configured (presence only)                                                               |

## Output

```
STAGING AUDIT  <UTC time>
EXPECTED SHA: <sha>     SERVED SHA: <sha per origin>     MATCH: yes/no
| # | Check | Result PASS/FAIL/UNKNOWN | Evidence |
MISMATCHES / RISKS:
READY FOR PRODUCTION AUTHORIZATION: yes | no (reasons)
HUMAN GATES REQUIRED: <list, with exact commands for the human>
```

UNKNOWN is a valid result; never upgrade it to PASS without evidence.
