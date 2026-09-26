---
name: syveka-production-audit
description: STRICTLY READ-ONLY production audit tracing DOMAIN → VERCEL ALIAS → DEPLOYMENT → BUILD SHA → RUNTIME → DATABASE → SUPABASE → REDIS and reporting every mismatch. Never redeploys, reassigns aliases, changes env vars, migrates, or modifies users or memberships. User-invoked only.
argument-hint: "[expected 40-char production SHA]"
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-production-audit (STRICTLY READ-ONLY)

Expected SHA: `$ARGUMENTS`. Follow [guardrails](../syveka-context/references/guardrails.md).

**Hard rules — no exceptions without Ehab's explicit, action-specific authorization, and even
then the human runs the command:** no redeploy, promote, rollback, alias/domain change, env var
or secret change, migration, SQL write, user/org/membership change, cache purge, or workflow
dispatch. Only GETs to public endpoints and read-only listing/inspect commands.

## Chain to verify (in order; parallelize independent probes)

| Link           | Evidence (read-only)                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| DOMAIN         | `https://syveka.com` and `PROD_URL` (ask the human for its value; it is a GitHub Environment variable, not a secret) |
| → VERCEL ALIAS | `vercel alias ls` / `vercel inspect https://syveka.com` (human CLI) → deployment id (report first 8 chars)           |
| → DEPLOYMENT   | last _Production release_ run: "verify promotion" step shows both domains → candidate deployment id                  |
| → BUILD SHA    | `node .claude/skills/syveka-context/scripts/check-served-sha.mjs <sha> https://syveka.com <PROD_URL>`                |
| → RUNTIME      | `/api/health` `status: healthy`; unauthenticated `/api/v1/ai/chat` → 401; login page renders                         |
| → DATABASE     | `/api/health` `checks.database: ok`; migration status from the release run log (no local connection to prod)         |
| → SUPABASE     | project ref from the release run (last 4 chars) ≠ `STAGING_SUPABASE_PROJECT_REF`; auth reachable via login page      |
| → REDIS        | `/api/health` `checks.redis: ok`                                                                                     |

Also compare: expected SHA = current `origin/main` tip? = SHA of the last successful staging run?

## Output

```
PRODUCTION AUDIT  <UTC time>   MODE: READ-ONLY
DOMAIN → ALIAS → DEPLOYMENT → SHA → RUNTIME → DB → SUPABASE → REDIS
<one line per link: value (masked) · PASS/FAIL/UNKNOWN · evidence>
MISMATCHES: <none | list with impact>
RECOMMENDED ACTIONS (for the human, each a HUMAN GATE): <exact command + rollback>
```

If any link mismatches, stop and report. Do not attempt remediation.
