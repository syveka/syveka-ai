# Production `DATABASE_URL` pooler-mode guardrail (prepared, not applied)

## Status: blocked on protected-file authorization

`.github/workflows/deploy.yml` is a workflow file protected by this repo's
local guardrail (`.claude/hooks/config-protection.mjs` — every
`.github/workflows/*.yml` file is `ALWAYS_PROTECTED`, independent of any
specific filename). Wiring the check below into the production release
workflow requires a human to either:

1. Set `SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1` in their own shell before a
   Claude Code session and ask Claude to apply the diff below, or
2. Apply the diff below directly (paste into the file, or `git apply` the
   patch block).

The validation script itself (`scripts/validate-production-database-pooler.mjs`)
is **not** protected — it's a new file, not one of the explicitly-named
protected scripts — so it is already committed on this branch, fully
implemented and tested. Only the workflow wiring below is pending.

## Why this exists

Mirrors the exact staging incident documented in
`docs/staging-database-url-pooler-fix.md` and the fix already merged in
`src/server/db/connection-string-sanitizer.ts`'s `ensurePgbouncerCompatibility()`:
a Next.js app on Vercel opens one Postgres connection per concurrent
serverless invocation. Supabase's session-mode pooler (and a direct
connection) hold a low, fixed connection cap; only the transaction-mode
pooler (port `6543`) is designed for many concurrent short-lived
connections. Without this guard, a production deploy pointed at the wrong
pooler mode would only fail once real concurrent customer traffic exhausts
the connection cap — an intermittent, hard-to-diagnose outage instead of a
clear, immediate, pre-deploy failure.

`deploy.yml` currently has **zero** pooler-mode assertions of any kind —
confirmed by reading the file directly. This adds exactly one.

## Exact diff to apply to `.github/workflows/deploy.yml`

Insert immediately after the existing "Verify checkout SHA" step and
before "Read-only legacy compatibility preflight" — before any step that
touches the database, so a misconfigured `DATABASE_URL` fails before any
migration or write is attempted:

```diff
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -90,6 +90,12 @@ jobs:
         env:
           EXPECTED_CANDIDATE_SHA: ${{ needs.verify-release-chain.outputs.candidate_sha }}

+      - name: Verify production DATABASE_URL uses the transaction-mode pooler
+        run: node scripts/validate-production-database-pooler.mjs
+        env:
+          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
+
       - name: Read-only legacy compatibility preflight
         run: psql "$PROD_DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/006_legacy_baseline_preflight.sql
         env:
```

This step never receives or logs `PROD_DIRECT_URL`, only `PROD_DATABASE_URL`
(mapped to the generic `DATABASE_URL` env var, matching every other step in
this workflow's own convention) — and the script itself never prints the
connection string, only its port number, on both the pass and fail paths.

## Verification already performed (before writing this doc)

- `scripts/validate-production-database-pooler.mjs` (already committed on
  this branch) has full unit coverage in
  `tests/unit/validate-production-database-pooler.test.ts`: passes on port
  `6543`, fails on `5432` (explicit or implicit/no-port), fails on unset
  `DATABASE_URL`, and never leaks credentials/hostname on any failure path
  — 7/7 tests pass.
- `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm run build` all pass with the new script present.
- The diff above was checked against the current `deploy.yml` content and
  inserts cleanly at the stated anchor with no other change.

## After this is applied

No test needs to be un-skipped (unlike the staging fix) — this script's own
test file already runs unconditionally as part of `npm test`. Once the
workflow diff above is applied, the only remaining step is confirming (per
the launch plan's gate H2) that the real `PROD_DATABASE_URL` secret is
actually on port `6543` before it's ever exercised by a real deploy.
