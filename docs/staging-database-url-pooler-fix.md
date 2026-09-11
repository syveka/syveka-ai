# Staging `DATABASE_URL` pooler-mode fix (prepared, not applied)

## Status: blocked on protected-file authorization

`scripts/validate-staging-config.mjs` is a CI-verification-critical config
file protected by this repo's local guardrail (`.claude/hooks/config-protection.mjs`).
Applying this fix requires a human to either:

1. Set `SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1` in their own shell before a
   Claude Code session and ask Claude to apply the diff below, or
2. Apply the diff below directly (paste into the file, or `git apply` the
   patch block).

Once applied, un-skip `tests/unit/validate-staging-config-runtime-pooler.test.ts`
(remove `.skip` from its `describe` block) — every case in that file was
independently verified against this exact diff before it was written here.

## Root cause this fixes

Live Vercel runtime logs (deployment `syveka-ai-staging-g8hefermc-syveka-ai.vercel.app`,
pulled via `vercel logs` — read-only, no secrets exposed) showed, under
concurrent Playwright desktop+mobile load:

```
FATAL: (EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
{"event":"get_tenant_context_or_null_unexpected_error","name":"PrismaClientInitializationError"}
```

Supabase's session-mode pooler (and a direct connection) hold one dedicated
connection per serverless invocation and are capped accordingly (15, in this
project's current configuration). Only the transaction-mode pooler (port
`6543`) is designed for many concurrent short-lived serverless connections —
which is exactly what a Next.js app on Vercel needs for `DATABASE_URL`. The
`identity` validation mode already asserts the _opposite_ convention for
`DIRECT_URL` (must NOT be `6543`, since migrations want the direct/session
connection) — this fix adds the missing, symmetric assertion for `DATABASE_URL`
in `runtime` mode.

This check only reads `new URL(DATABASE_URL).port` — a bare port number,
never the credentials, hostname, or database name — consistent with every
other check already in this file (see `parseUrl()`'s own docstring on why
raw connection strings must never be interpolated into error messages).

## Exact diff to apply to `scripts/validate-staging-config.mjs`

```diff
--- a/scripts/validate-staging-config.mjs
+++ b/scripts/validate-staging-config.mjs
@@ -135,6 +135,32 @@
     );
   }

+  // Live incident evidence (Vercel runtime logs, staging deployment
+  // syveka-ai-staging-g8hefermc-syveka-ai.vercel.app): concurrent Playwright
+  // desktop+mobile load against the deployed app threw
+  // PrismaClientInitializationError with "FATAL: (EMAXCONNSESSION) max
+  // clients reached in session mode - max clients are limited to
+  // pool_size: 15". Supabase's session-mode pooler (and a direct
+  // connection) hold one dedicated connection per serverless invocation and
+  // are capped accordingly; only the transaction-mode pooler (port 6543,
+  // same convention the "identity" mode above already asserts DIRECT_URL
+  // must NOT use) is designed for many concurrent short-lived serverless
+  // connections. This never reads the value itself beyond the port number,
+  // which reveals no credentials, hostname, or database name -- it fails
+  // closed here, before deploy, instead of surfacing as an intermittent,
+  // hard-to-diagnose "no organization membership" redirect under real
+  // traffic.
+  if (databaseUrl.port !== "6543") {
+    throw new Error(
+      `DATABASE_URL (from Vercel's pulled Preview environment) uses port ${databaseUrl.port || "5432"}, ` +
+        "not Supabase's transaction-mode pooler port 6543 -- the deployed serverless app needs " +
+        "the transaction pooler for concurrent request handling. Session mode / a direct " +
+        "connection has a low, fixed connection cap (pool_size 15 by default) that concurrent " +
+        "traffic exhausts, causing intermittent PrismaClientInitializationError failures. Use " +
+        "the direct connection for DIRECT_URL/migrations only, never for the app's own DATABASE_URL.",
+    );
+  }
+
   console.log(
     "Required staging runtime setting names are present, and the deployed Supabase project matches staging.",
   );
```

## Verification already performed (before writing this doc)

Run standalone against a temporary copy of the script (never against the
tracked file, per the guardrail):

- `DATABASE_URL` on port `5432` (explicit) → rejected, correct error message.
- `DATABASE_URL` with no explicit port (implicit `5432`) → rejected.
- `DATABASE_URL` on port `6543` → passes, unchanged success message.
- Existing `identity` mode (unrelated code path) → still passes, unaffected.
- Prettier (`--config .prettierrc`, this repo's actual config) confirms the
  diff above is the _only_ change — no incidental reformatting.
