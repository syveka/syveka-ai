# Syveka AI — CI/CD and Production-Readiness Audit

Snapshot date: **2026-07-23**. All checks below were either read directly from workflow/script
files or executed locally (read-only, non-destructive) during this audit.

## 1. GitHub Actions workflows

### `.github/workflows/ci.yml` — triggers on PR→`main` and push→`main`, 14 jobs

| Job | What it checks |
|---|---|
| `install` | `npm ci` |
| `prisma-generate` | `npx prisma generate` |
| `prisma-validate` | `npx prisma validate` (dummy DB URLs) |
| `migration-structure` | Every `prisma/migrations/*` dir matches `^[0-9]{14}_[A-Za-z0-9_]+$`, has non-empty `migration.sql`, requires `migration_lock.toml`; then runs `check-migration-history.mjs` |
| `lint` | ESLint + Prettier `format:check` |
| `typecheck` | `tsc --noEmit` |
| `tests` | `npm test` (vitest, mocked DB, no service container) |
| `rls` | Live `pgvector/pgvector:pg15` container, `prisma migrate deploy`, then raw-SQL RLS/tenant-isolation assertions (`tests/rls/*.sql`, `tests/integration/tenant-relationship-integrity.sql`) |
| `migration-upgrade` | Heaviest job — provisions multiple Postgres DBs and asserts the legacy-baseline migration **rejects** partial schemas, structural/column/type drift, wrong FKs, and weakened RLS policies |
| `build` | `npm run build` with placeholder env vars + `SKIP_ENV_VALIDATION=1` |
| `production-dependency-audit` | **Blocking**: `npm audit --omit=dev --audit-level=high` |
| `full-dependency-audit-report` | Non-blocking (`continue-on-error: true`), uploads JSON artifact |
| `i18n` | `node scripts/check-i18n-parity.mjs` |
| `secret-scan` | `gitleaks` v8.24.3 via Docker over the exact commit range |
| `ci-required` | Fan-in gate — fails unless every job above succeeded |

### `.github/workflows/deploy.yml` (Production release)

`workflow_dispatch` only, requires typing the 40-char SHA twice (`candidate_sha` +
`confirm_production_sha`). `verify-release-chain` runs only on `main` and calls
`scripts/verify-release-chain.ts`, which confirms via the GitHub API that the SHA is the exact
current `main` tip **and** has both a successful push-triggered CI run **and** a successful
staging `workflow_dispatch` run at that same SHA. Only then does `migrate-and-deploy`
(protected `production` Environment, 45-minute timeout) re-verify the SHA, run the read-only
legacy preflight, `prisma migrate deploy`, `prisma migrate status`, storage-compatibility SQL,
DB invariant checks, a pinned Vercel CLI (`56.3.2`) deploy, and poll `/api/health`.

### `.github/workflows/staging-release.yml`

`workflow_dispatch` only, `main`-only, requires typing the 20-char staging Supabase project ref
(cross-checked against a production deny-list). Re-runs the full local-quality suite plus
staging-specific steps: identity validation, real `prisma migrate deploy` against staging,
RLS/tenant SQL assertions, private-storage-bucket check, embedding-provider-key check, Vercel
preview deploy, health-check polling, and Playwright E2E smoke tests against the live URL.

## 2. Scripts (`scripts/*`)

| Script | Purpose | Wired into CI? |
|---|---|---|
| `check-i18n-parity.mjs` | Flags dotted-literal keys and missing/extra keys across `messages/{en,fi,ar}.json` | Yes (`i18n` job) |
| `check-migration-history.mjs` | Hardcoded expected migration order + pinned SHA-256 checksums for 8 published migrations; anti-tamper guard | Yes (`migration-structure` job, `npm run migrations:check`) |
| `validate-staging-config.mjs` | 3 modes (`identity`/`storage`/`embedding`) guarding staging never points at production | Yes (staging workflow only) |
| `verify-release-chain.ts` | Confirms exact SHA is `main` tip + has successful CI + staging runs | Yes (`deploy.yml`) |
| `check-dashboard-index-ownership.mjs` | Verifies 5 named dashboard indexes exist only in the Prisma migration, not duplicated in `prisma/sql/001` | **No — orphaned, not wired into any workflow or package.json script** |
| `generate-legacy-schema-contract.mjs` | Generates SQL fixtures/contracts for legacy-baseline compatibility tests | Indirectly used by `migration-upgrade` job fixtures |
| `ci/provision-legacy-database.sh` | Provisions the deterministic legacy-template DB for `migration-upgrade` | Yes (`migration-upgrade` job only) |

## 3. Local check results (run 2026-07-23, read-only, non-destructive)

| Command | Result |
|---|---|
| `npx prisma validate` | **PASS** |
| `npx prisma generate` | **PASS** (Prisma Client v6.19.3; a v7.9.0 update is available, not urgent) |
| `npm run i18n:check` | **PASS** — fi: 488/488, ar: 488/488, zero drift |
| `npm run migrations:check` | **PASS** — order correct, 8 published checksums match |
| `npm run format:check` | **PASS** |
| `npm run lint` | **PASS**, no warnings |
| `npm run typecheck` | **PASS** |
| `npm test` (vitest) | **PASS** — 34 files, 310 tests, all green, 4.13s |
| `npm run build` | **PASS** — 111/111 static pages generated across en/fi/ar, 9.2s |
| `npm audit --omit=dev --audit-level=high` (exact blocking CI command) | **FAIL** — see below |

### Dependency audit — the one currently-failing check

Running the exact command from the blocking `production-dependency-audit` job today
(2026-07-23) returns exit code 1 with **3 high + 1 moderate** vulnerabilities that were **not
present** when this same job last ran green in CI on 2026-07-20:

- `next` (≈15.5.20 range, declared `^15.2.0`) — multiple new advisories: DoS in Server Actions,
  SSRF in Server Actions on custom servers, response-body cache confusion (×2), unbounded
  Server Action payload on Edge runtime, SSRF via rewrites, DoS in Image Optimization SVG
  handling, unauthenticated disclosure of internal Server Function endpoints. Fix available via
  `npm audit fix`.
- `postcss` ≤8.5.11 (nested under `next`) — XSS via unescaped `</style>`, arbitrary file read
  via `sourceMappingURL`. Fix available via `npm audit fix`.
- `sharp` <0.35.0 (nested under `next`, currently 0.34.5) — libvips CVEs. Fix available via
  `npm audit fix`.
- `next-intl` ≤4.9.1 (currently 3.26.5, declared `^3.26.0`) — open redirect + prototype
  pollution. Fix requires `npm audit fix --force` (**breaking**, 3.x→4.x major).

**This is a time-sensitive, not a stable, finding**: classify as "Passing as of last CI run
(2026-07-20), Failing as of now (2026-07-23)" — the next push or CI re-run on PR #9 will fail
this gate until dependencies are bumped. See `SECURITY-AUDIT.md` H1 and `NEXT-STEPS.md` for the
exact fix task.

### Environment-dependent checks (not run locally, covered by CI's service containers)

- `rls` job (live Postgres + RLS/tenant SQL assertions) — needs a live Postgres instance.
- `migration-upgrade` job (drift/policy-rejection tests across multiple provisioned DBs) — needs
  live Postgres.
- `secret-scan` (gitleaks via Docker over a real commit-range) — needs Docker + real SHAs.
- Staging E2E smoke tests (Playwright) — needs a deployed staging URL and credentials.
- Production/staging deploy workflows — need real secrets, Vercel tokens, live databases;
  correctly gated behind `workflow_dispatch` with manual SHA confirmation, not exercised in this
  audit (out of scope — deploys were explicitly not performed).

## 4. `src/env.ts` vs `.env.example`

No drift found — every required and optional variable in `src/env.ts`'s Zod schemas has a
matching placeholder in `.env.example`, and vice versa. `env.ts` has a build-time escape hatch
(`SKIP_ENV_VALIDATION=1` or `NEXT_PHASE=phase-production-build`) that bypasses validation for
CI builds only — real runtime validation is untouched.

## 5. Deployment configuration

`vercel.json`: region pinned to `fra1` (EU), per-route `maxDuration` overrides for long-running
routes (`ai/chat` 120s, `jobs/embed-document` 300s, `jobs/run-workflow` 300s, `jobs/post-call`
120s, `jobs/usage-rollup` 300s). No redirects/rewrites configured.

`next.config.ts`: `reactStrictMode: true`, `poweredByHeader: false`, restricted image
`remotePatterns` (Supabase Storage + Google avatars only, no open wildcard), and a solid
security-header baseline (`nosniff`, `X-Frame-Options: DENY`, HSTS with `preload`,
`Permissions-Policy`). **Contains a stale/false comment claiming CSP is set in
`src/middleware.ts` — it is not** (see `SECURITY-AUDIT.md` M2).

## 6. Missing CI gates worth adding

- No automated test enforcing that every `src/app/api/v1/**/route.ts` file self-enforces auth
  (see `SECURITY-AUDIT.md` L2).
- `check-dashboard-index-ownership.mjs` exists but is orphaned from CI — either wire it in or
  document why it's manual-only.
- No accessibility (axe/Lighthouse) check in CI.
- No bundle-size budget check in CI.
- No dead-link check in CI.

## 7. Release readiness

The three-stage release pipeline itself (CI → staging → production) is well-built: manual
`workflow_dispatch`-only gating, exact-SHA cross-verification between CI and staging runs before
production approval is even requested, a protected `production` GitHub Environment requiring
reviewer approval, and a documented rollback procedure (`docs/release-runbook.md`, verified
accurate against the actual workflow files during this audit). **It has not yet been exercised
end-to-end** (no staging or production dispatch has occurred per repository evidence).

**Recommended release sequence from this point**:
1. Fix the dependency-audit failure (§3) — this blocks any further CI-gated progress.
2. Re-run `ci-required` on PR #9 to confirm green.
3. Resolve the Medium security findings (`SECURITY-AUDIT.md` M1–M3) — not hard CI blockers today
   but should land before a production dispatch.
4. Dispatch `staging-release.yml` from `main` for the first time, verify the full smoke checklist
   in `docs/release-runbook.md`.
5. Only then consider a `deploy.yml` (production) dispatch, following the documented approval
   chain.

## Summary classification

| Check | Status |
|---|---|
| Prisma validate / generate | Passing |
| i18n parity | Passing |
| Migration history/checksum guard | Passing |
| Format / lint / typecheck | Passing |
| Unit/integration tests | Passing (310/310) |
| Production build | Passing |
| RLS isolation tests | Environment-dependent (covered in CI, not run locally) |
| Migration-upgrade drift tests | Environment-dependent (covered in CI, not run locally) |
| Secret scan | Environment-dependent (covered in CI, not run locally) |
| **Production dependency audit** | **Failing right now** (passed 2026-07-20, fails 2026-07-23) |
| Full dependency audit report | Non-blocking by design |
| Dashboard index ownership check | Missing from CI wiring |
| Staging E2E smoke | Environment-dependent, not yet exercised |
| Production/staging deploy | Correctly gated, not yet exercised |
