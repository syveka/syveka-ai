---
name: syveka-db-diagnostics
description: Syveka database troubleshooting — Prisma errors, PostgreSQL 42P05 / "prepared statement" / "bind message supplies N parameters" collisions, PgBouncer/Supavisor pooling mode, EMAXCONNSESSION, DATABASE_URL vs DIRECT_URL, migration vs runtime connections, pgvector. Always masks credentials. Use for any DB connectivity, pooling, or Prisma runtime error.
argument-hint: "[error code/message | environment]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-db-diagnostics

Problem: `$ARGUMENTS`. Follow [guardrails](../syveka-context/references/guardrails.md).
**Never print a connection string.** Report shape only (host suffix, port, param names).
No writes, migrations, `db push`, or `migrate resolve` against shared databases.

## Expected configuration

| Var            | Used by                               | Must be                                                                          |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL` | runtime (`src/server/db/prisma.ts`)   | Supabase **transaction** pooler, port `6543`                                     |
| `DIRECT_URL`   | `prisma migrate`, release SQL scripts | direct or **session** connection — **not** `6543` (validated in `identity` mode) |

Runtime client: `PrismaPg` driver adapter (`@prisma/adapter-pg`) with `pg` pool `max: 1` per
instance. `ensurePgbouncerCompatibility()` adds `pgbouncer=true&connection_limit=1` on port 6543
— those params only affect Prisma's classic engine; under `PrismaPg` they are inert (documented
in `prisma.ts`). Tests: `tests/unit/connection-string-sanitizer.test.ts`.

Operator scripts (`scripts/diagnose-staging-auth-membership.ts`,
`enable-creator-studio-for-org.ts`, `ensure-e2e-org-fixture.ts`) build their own `PrismaPg`
client on purpose. Each fails fast unless `DATABASE_URL === DIRECT_URL` (a direct/session
connection, not the transaction pooler), and the workflow passes the direct secret for both. Not
routing through `sanitizeConnectionString`/`ensurePgbouncerCompatibility` is not a known defect
there. Only flag it with evidence (e.g. a failure traced to one of these scripts).

## Known failure signatures

| Signature                                                                                                                | Meaning / first checks                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `42P05` prepared statement "sN" already exists / `bind message supplies N parameters, but prepared statement requires M` | named prepared statements reused across multiplexed transaction-pooler backends. Check: which process produced it, and whether its connection is actually the 6543 transaction pooler. `pgbouncer=true` only matters for classic-engine paths. Confirm how that client handles prepared statements before blaming a URL parameter |
| `EMAXCONNSESSION max clients reached in session mode`                                                                    | runtime `DATABASE_URL` points at session pooler/5432 → must be 6543 (see `docs/staging-database-url-pooler-fix.md`)                                                                                                                                                                                                               |
| `P1001` / `ECONNREFUSED` / timeout                                                                                       | host/port/network; Supabase project paused; wrong region                                                                                                                                                                                                                                                                          |
| `P1000` / `28P01` auth failed                                                                                            | credentials rotated/mis-pasted; stray whitespace/newline (handled by `sanitizeConnectionString`)                                                                                                                                                                                                                                  |
| `P3009` / `P3018` migration failed                                                                                       | stop; follow runbook Rollback section; never edit `_prisma_migrations`                                                                                                                                                                                                                                                            |
| `PrismaClientInitializationError` in `getTenantContext`                                                                  | connection-level failure surfacing as auth/membership symptom — diagnose DB first                                                                                                                                                                                                                                                 |

## Workflow

1. Capture exact error code/message, environment, build SHA, and which process (runtime route,
   job, migration, script).
2. Inspect config shape safely, e.g.
   `node -e "const u=new URL(process.env.DATABASE_URL);console.log(u.hostname.replace(/^[^.]+/,'*'),u.port,[...u.searchParams.keys()])"`
   — hostname prefix masked, no user/password/db name. For staging/prod, rely on CI validation
   output (`scripts/validate-staging-config.mjs`) instead of local env.
3. Find every DB client: `grep -rn "new PrismaClient\|new PrismaPg\|new Pool(" src scripts`.
4. Correlate with health: `/api/health` `checks.database`.
5. Conclude layer (config / pooler mode / client / query / migration) with VERIFIED/INFERRED.
6. Propose fix. Env var changes in staging/prod are a **HUMAN GATE** (give the target _shape_,
   never a value). Code fixes follow CLAUDE.md §2 with a unit test.
