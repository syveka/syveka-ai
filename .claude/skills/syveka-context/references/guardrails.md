# Shared guardrails for all `syveka-*` skills

These restate CLAUDE.md §1/§3/§9 as operating rules for the skills. CLAUDE.md wins on conflict.

## Environment tiers

| Tier                 | Default mode                                                       |
| -------------------- | ------------------------------------------------------------------ |
| Local / CI / preview | Read + local fixes on a feature branch                             |
| Staging              | **Read-only.** Observe, query health, read logs, run read-only SQL |
| Production           | **Strictly read-only** unless Ehab explicitly authorizes an action |

## Human gates (stop and ask; never infer approval)

Merge · production deploy/promote/rollback · any DB migration · env var / secret change ·
domain / alias change · workflow dispatch or GitHub Environment approval · user / org /
membership mutation · destructive or irreversible operation. Approval covers one named action on
one named target; it never carries over.

When a gate is hit, output:

```
HUMAN GATE: <action>
Target: <env / resource>   Reason: <why needed>   Evidence: <what proves it>
Exact command for the human to run: <command>   Rollback: <how to undo>
```

## Secrets

- Never print values of `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `*_API_KEY`,
  `*_SECRET*`, `*_TOKEN`, Stripe/Vapi/Resend/QStash/Vercel credentials, or `.env*` contents.
- Report **shape only**: presence (`set`/`missing`), length, host suffix, port, query-param
  _names_, project-ref last 4 chars. Example: `DATABASE_URL: set, host *.pooler.supabase.com,
port 6543, params [pgbouncer, connection_limit]`.
- Mask identifiers: emails `e***@domain`, UUIDs `abcd…wxyz`, deployment IDs first 8 chars.
- Never paste raw logs containing URLs with credentials; sanitize first.

## Partial technical backstop (defense in depth)

These rules are behavioral guidance, not an access-control boundary. Real protection comes from
credentials, permission rules, GitHub Environment approvals, and branch protection.

Skills that touch environments register `.claude/skills/syveka-context/scripts/prod-guard.mjs`
as a `PreToolUse` hook for the rest of the session. It pattern-matches direct command forms of
deploy/alias/env/migration/write-SQL/merge/dispatch/force-push and secret dumps. It does **not**
see indirect execution (`bash -c`, `node -e`, scripts), the Read tool, or every SQL/CLI form. So
a command it allows is not thereby safe, and the rules above still apply in full. It has **no
override**: if a blocked action is authorized, the human runs it. Execution by Claude requires an
explicitly approved execution policy and the normal permission/environment gates; changing
sessions is not authorization. A block is a signal to stop and report, never to find an
alternate command path. Limitations: `docs/claude-skills.md`.

## Parallelism

Parallelize only independent **read-only** work (code search, test/workflow inspection, log
reading, architecture mapping, per-domain health probes) via parallel tool calls or read-only
`Explore` subagents. Never parallelize git writes, migrations, deploys, env/alias changes, or
anything touching the same resource. Spawn subagents only when the user asks (repo harness rule).

## Evidence standard

- Claims cite a file:line, a command + its output, or a URL + response field.
- Say **VERIFIED**, **INFERRED**, or **UNKNOWN** for each conclusion. Never report a check as
  passed that did not run.
- "Deployment succeeded" ≠ "correct build served". Always compare SHAs.
