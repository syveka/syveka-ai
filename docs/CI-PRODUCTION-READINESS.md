# Syveka AI — CI/CD and Production-Readiness Audit

Snapshot date: **2026-07-23**. All checks below were either read directly from workflow/script
files or executed locally (read-only, non-destructive) during this audit.

> **Historical snapshot.** Sections 1–7 and "Summary classification" record the 2026-07-23 audit
> and are kept as evidence; several items have changed since. Current status is in the dated
> addenda below, newest first: **2026-10-06**, then 2026-10-04.

## 1. GitHub Actions workflows

### `.github/workflows/ci.yml` — triggers on PR→`main` and push→`main`, 14 jobs

| Job                            | What it checks                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`                      | `npm ci`                                                                                                                                                                                  |
| `prisma-generate`              | `npx prisma generate`                                                                                                                                                                     |
| `prisma-validate`              | `npx prisma validate` (dummy DB URLs)                                                                                                                                                     |
| `migration-structure`          | Every `prisma/migrations/*` dir matches `^[0-9]{14}_[A-Za-z0-9_]+$`, has non-empty `migration.sql`, requires `migration_lock.toml`; then runs `check-migration-history.mjs`               |
| `lint`                         | ESLint + Prettier `format:check`                                                                                                                                                          |
| `typecheck`                    | `tsc --noEmit`                                                                                                                                                                            |
| `tests`                        | `npm test` (vitest, mocked DB, no service container)                                                                                                                                      |
| `rls`                          | Live `pgvector/pgvector:pg15` container, `prisma migrate deploy`, then raw-SQL RLS/tenant-isolation assertions (`tests/rls/*.sql`, `tests/integration/tenant-relationship-integrity.sql`) |
| `migration-upgrade`            | Heaviest job — provisions multiple Postgres DBs and asserts the legacy-baseline migration **rejects** partial schemas, structural/column/type drift, wrong FKs, and weakened RLS policies |
| `build`                        | `npm run build` with placeholder env vars + `SKIP_ENV_VALIDATION=1`                                                                                                                       |
| `production-dependency-audit`  | **Blocking**: `npm audit --omit=dev --audit-level=high`                                                                                                                                   |
| `full-dependency-audit-report` | Non-blocking (`continue-on-error: true`), uploads JSON artifact                                                                                                                           |
| `i18n`                         | `node scripts/check-i18n-parity.mjs`                                                                                                                                                      |
| `secret-scan`                  | `gitleaks` v8.24.3 via Docker over the exact commit range                                                                                                                                 |
| `ci-required`                  | Fan-in gate — fails unless every job above succeeded                                                                                                                                      |

### `.github/workflows/deploy.yml` (Production release)

`workflow_dispatch` only, requires typing the 40-char SHA twice (`candidate_sha` +
`confirm_production_sha`). `verify-release-chain` runs only on `main` and calls
`scripts/verify-release-chain.ts`, which confirms via the GitHub API that the SHA is the exact
current `main` tip **and** has both a successful push-triggered CI run **and** a successful
staging `workflow_dispatch` run at that same SHA. Only then does `migrate-and-deploy`
(protected `production` Environment, 45-minute timeout) re-verify the SHA, run the read-only
legacy preflight, `prisma migrate deploy`, `prisma migrate status`, storage-compatibility SQL,
DB invariant checks, then a pinned Vercel CLI (`56.3.2`) credential-free build, a staged
(`--skip-domain`) deploy, a pre-promotion health/build-SHA check, an explicit `vercel
promote`, and a post-promotion proof that `https://syveka.com` and `PROD_URL` both point at
the candidate and serve its build SHA (enforced by
`tests/unit/production-workflow-release-hardening.test.ts`).

### `.github/workflows/staging-release.yml`

`workflow_dispatch` only, `main`-only, requires typing the 20-char staging Supabase project ref
(cross-checked against a production deny-list). Re-runs the full local-quality suite plus
staging-specific steps: identity validation, real `prisma migrate deploy` against staging,
RLS/tenant SQL assertions, private-storage-bucket check, embedding-provider-key check, Vercel
preview deploy, health-check polling, and Playwright E2E smoke tests against the live URL.

## 2. Scripts (`scripts/*`)

| Script                                | Purpose                                                                                                     | Wired into CI?                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `check-i18n-parity.mjs`               | Flags dotted-literal keys and missing/extra keys across `messages/{en,fi,ar}.json`                          | Yes (`i18n` job)                                                      |
| `check-migration-history.mjs`         | Hardcoded expected migration order + pinned SHA-256 checksums for 8 published migrations; anti-tamper guard | Yes (`migration-structure` job, `npm run migrations:check`)           |
| `validate-staging-config.mjs`         | 3 modes (`identity`/`storage`/`embedding`) guarding staging never points at production                      | Yes (staging workflow only)                                           |
| `verify-release-chain.ts`             | Confirms exact SHA is `main` tip + has successful CI + staging runs                                         | Yes (`deploy.yml`)                                                    |
| `check-dashboard-index-ownership.mjs` | Verifies 5 named dashboard indexes exist only in the Prisma migration, not duplicated in `prisma/sql/001`   | **No — orphaned, not wired into any workflow or package.json script** |
| `generate-legacy-schema-contract.mjs` | Generates SQL fixtures/contracts for legacy-baseline compatibility tests                                    | Indirectly used by `migration-upgrade` job fixtures                   |
| `ci/provision-legacy-database.sh`     | Provisions the deterministic legacy-template DB for `migration-upgrade`                                     | Yes (`migration-upgrade` job only)                                    |

## 3. Local check results (run 2026-07-23, read-only, non-destructive)

| Command                                                               | Result                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npx prisma validate`                                                 | **PASS**                                                                   |
| `npx prisma generate`                                                 | **PASS** (Prisma Client v6.19.3; a v7.9.0 update is available, not urgent) |
| `npm run i18n:check`                                                  | **PASS** — fi: 488/488, ar: 488/488, zero drift                            |
| `npm run migrations:check`                                            | **PASS** — order correct, 8 published checksums match                      |
| `npm run format:check`                                                | **PASS**                                                                   |
| `npm run lint`                                                        | **PASS**, no warnings                                                      |
| `npm run typecheck`                                                   | **PASS**                                                                   |
| `npm test` (vitest)                                                   | **PASS** — 34 files, 310 tests, all green, 4.13s                           |
| `npm run build`                                                       | **PASS** — 111/111 static pages generated across en/fi/ar, 9.2s            |
| `npm audit --omit=dev --audit-level=high` (exact blocking CI command) | **FAIL** — see below                                                       |

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

| Check                            | Status                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| Prisma validate / generate       | Passing                                                     |
| i18n parity                      | Passing                                                     |
| Migration history/checksum guard | Passing                                                     |
| Format / lint / typecheck        | Passing                                                     |
| Unit/integration tests           | Passing (310/310)                                           |
| Production build                 | Passing                                                     |
| RLS isolation tests              | Environment-dependent (covered in CI, not run locally)      |
| Migration-upgrade drift tests    | Environment-dependent (covered in CI, not run locally)      |
| Secret scan                      | Environment-dependent (covered in CI, not run locally)      |
| **Production dependency audit**  | **Failing right now** (passed 2026-07-20, fails 2026-07-23) |
| Full dependency audit report     | Non-blocking by design                                      |
| Dashboard index ownership check  | Missing from CI wiring                                      |
| Staging E2E smoke                | Environment-dependent, not yet exercised                    |
| Production/staging deploy        | Correctly gated, not yet exercised                          |

## Addendum (2026-10-06): current status

Fresh findings for this date. Evidence class is marked on each line: _repo_ (repository or CI
metadata), _staging_ (staging release), or _public endpoint_ (unauthenticated `/api/health`).
Nothing here was read from production secrets or databases.

**Release state**

- `main` = `d0deaa9` (_repo_): #232 (database connection diagnostic) and #239 (backup gate) merged.
  CI #656 passed on `d0deaa9`.
- Staging = `d0deaa9` (_staging_): release #126 passed every step, including smoke and auth journeys,
  with no pending migrations. The public endpoint confirms the build.
- Production serves `fc645727` (_public endpoint_, 2026-10-05 21:28 UTC). That's production run #23
  (2026-09-25), 92 commits behind `main`. The `main` → production delta has **no `prisma/` changes**.

**Backup gate** (`docs/release-runbook.md`, merged in #239): PITR (Option A) is the required default
and is **not met**. Option B is a narrow exception for releases with no database change and needs a
complete per-release record. **Its existence is not release approval.** Restore testing and Storage
backup coverage remain **unverified**. Supabase ticket SU-494644 was acknowledged; that is not
technical clearance.

**Expected-project configuration** (_repo_ metadata, names only): the GitHub `production`
environment defines only `PROD_URL`. `PRODUCTION_SUPABASE_PROJECT_REF` exists only on `staging`, so a
production build would inline an empty expected ref and the diagnostic would report
`expectedProjectMatch: "unknown"`. Adding the variable is an owner action. Variable presence would
still not prove the deployed value; the post-release diagnostic line does.

**Secret-scanning alert #1** (_repo_): the flagged `whsec_` literal (in
`tests/unit/inbox-resend-inbound.test.ts:155`, commit `1e16a50`, removed in `55ea7c7` the same day,
allowlisted in `.gitleaksignore`) is byte-identical to the example signing secret in svix's public
documentation. It's a synthetic test fixture, not a provider-issued Syveka secret. It remains visible
in public history; nothing needs revoking. Closing the alert is an owner action.

**Classification of open items**

| Item                                                                                                      | Class                                                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Backup gate: PITR off; Option B not yet applied to any release                                            | Release blocker (until A, or a complete B record)                                      |
| `PRODUCTION_SUPABASE_PROJECT_REF` missing in `production`                                                 | Release blocker for the DB-mode verification goal                                      |
| Seat limit not enforced at join (pending invitations can exceed the plan; concurrent joins unserialized)  | Fixed on `main` by #241 (`1e4a2cb`); not yet released                                  |
| Creator Studio mock media in production without FAL (#234)                                                | Fixed on `main` by #234 (`c6779d8`); not yet released                                  |
| AI allowance enforced org-wide against a per-user field; display and 80% warning multiply by seats (#237) | Limited-pilot blocker for paid plans                                                   |
| Error tracking inactive (no DSN)                                                                          | Release blocker per the 2026-10-04 addendum (P1-2)                                     |
| Data export and deletion: procedure documented, capability unverified (P1-10)                             | Release blocker for a commercial launch; limited-pilot acceptable with manual handling |
| No dunning emails; webhook marks `PAST_DUE` only                                                          | Post-launch improvement (commercial launch)                                            |
| Creator Studio monthly credits accumulate without expiry                                                  | Commercial-policy decision                                                             |
| Stripe checkout bills `members.length`; quantity never synced                                             | Commercial launch blocker; depends on unapproved commercial model                      |
| `usage-rollup` QStash schedule (retention purge, 80% warnings)                                            | Unknown, needs owner evidence                                                          |
| Production Vercel variable names (mock pins absent, required present)                                     | Unknown, needs owner evidence                                                          |

**Dependency findings after #242** (_repo_)

#242 (`1851f01`) bumped `source-map-js` to 1.2.2 (GHSA-68fv-2mgg-jv7q, high). Main CI passed on
`1851f01`. `npm audit --omit=dev` now reports 0 critical, 0 high, 3 moderate and 1 low. The blocking
gate (`--audit-level=high`) passes. The findings below are below that threshold but are recorded,
not dismissed. Reachability statements are conclusions from the call paths inspected on 2026-10-06
at `1851f01`. They are not guarantees about every possible use, and they must be re-checked when
these packages or their callers change.

- **`sprintf-js` GHSA-hp3w-g68c-fv3c** (moderate; `<= 1.1.3`, **no patched release**). An
  attacker-controlled format string with an unbounded precision specifier throws an uncaught
  `RangeError` (denial of service).
  - Path: `mammoth@1.12.0` (production) → `argparse@1.0.10` → `sprintf-js@1.0.3`. npm also counts
    `argparse` and `mammoth` as moderate; they are this same finding.
  - Inspected call path: the application's only `mammoth` call is `mammoth.extractRawText({ buffer })`
    in the parser worker (`src/server/security/parser-security.ts`). In `mammoth@1.12.0`, `argparse`
    is required only by the CLI entry (`bin/mammoth`), not by `lib/` (the package `main`). The
    `sprintf` calls inside `argparse` use literal format strings. On that path, no request input
    reaches `sprintf-js`.
  - Fix: none without a breaking change. `npm audit fix --force` would move `mammoth` to 0.3.29, a
    breaking downgrade, so it was not applied. Re-check when `sprintf-js` publishes a fix, or when
    `mammoth` drops `argparse@1`.
- **`@babel/core` GHSA-4x5r-pxfx-6jf8** (low; `<= 7.29.0`, patched 7.29.6). Compiling
  attacker-controlled source with a crafted `sourceMappingURL` comment can read a source-map file
  from the machine running Babel. This requires attacker-controlled input code, readable output, and
  a known target path.
  - Paths (installed 7.24.5): production `@sentry/nextjs@11.4.0` → `@sentry/bundler-plugins@11.4.0`
    → `@babel/core`; dev `react-email@3.0.7` → `@babel/core` (also via
    `@babel/helper-module-transforms`).
  - Inspected call path: Sentry's bundler plugin runs Babel at build time on repository source, and
    `react-email` is a devDependency used by the local `email dev` preview. No request handler was
    found that passes user-supplied code to Babel.
  - Fix: a within-range lockfile update to 7.29.6 or later is available (`npm audit fix`, not
    `--force`). It was not applied with #242. Proposed as its own small lockfile PR for owner review.
  - Constraint: `react-email@3.0.7` pins `@babel/core` and `@babel/parser` to exactly `7.24.5`. A fix
    therefore leaves the hoisted copy patched for Sentry's production path and nests 7.24.5 under
    `react-email` (dev only). The dev-only copy stays flagged until `react-email` moves to a major
    version that no longer pins it, which is out of scope for a lockfile-only change.

**Follow-ups recorded after merging #241 and #234** (_repo_; not blocking those merges)

- **Invitation status inside the acceptance transaction** (#241). `acceptInvitation` reads the
  invitation and checks `status === "PENDING"` before the seat transaction starts, then sets
  `ACCEPTED` inside it. An invitation revoked between those two points can still be accepted. `main`
  already behaved this way before #241. Proposed fix: inside the transaction, accept with a
  conditional update (`updateMany` where `id` and `status: "PENDING"`, then require `count === 1`),
  so a concurrent revocation or second acceptance fails cleanly.
- **Customer-visible errors from Creator Studio server actions.** `src/actions/creator-studio.ts`
  returns `e.message` for any thrown `Error`, so unexpected internal errors can reach the UI verbatim,
  contrary to the charter's rule against leaking internal errors. Known errors (for example
  `CreatorMediaProviderUnavailableError`) also reach the UI untranslated. Proposed fix: map known
  error classes to stable codes with translated messages, and return a generic code for everything
  else (log the detail server-side, sanitized).
- **External compatibility of #237's changed API error identifier.** `POST /api/v1/ai/chat`
  returns `402 { error: { code, limit } }`. #237 changes `limit` from `aiMessagesPerUserMonth` to
  `aiMessagesPerOrgMonth`. Before #237 merges, determine whether any external API consumer (public
  API keys, integrations, mobile or embedded clients) matches on that value. Then either keep the
  old identifier for compatibility or announce the change.
  - Assessed 2026-10-06 on #237's tree. These conclusions hold for the call paths inspected, not
    every possible client. `error.code` (`entitlement_exceeded`) is unchanged on every 402. The
    changed `limit` value appears only on the chat route's 402; transcribe and voice-turn return
    the code alone. The only caller of the chat route is the in-app `use-chat.ts`, which reads
    `error.code` only, and no code in the repository reads `error.limit`. The route authenticates
    with the session cookie. `resolveApiKey` has no callers, so there is no public API-key access
    yet, and there are no SDK, mobile or embedded clients in the repository. No compatibility shim
    is needed. When a public API ships, document `limit` as a plan-limit key (it can also be
    `maxSeats` for a read-only workspace).
- **Atomic AI usage reservation** (accepted for this release, follow-up for later). The chat route
  checks the organization's month total before generating a reply and records `AI_MESSAGES` only
  after the reply finishes. Requests in flight at the same moment can all pass at the boundary.
  Overshoot is bounded by concurrent in-flight requests; the rate limiters default to 30 per user
  and 300 per organization per minute. Transcribe and voice-turn check the same total. The owner
  accepted this bounded overshoot for #237 on 2026-10-06. Proposed future mechanism: atomically
  reserve one message against `aiMessagesPerOrgMonth` before calling the provider (a Redis counter
  or a database row under the organization's key). Commit the reservation on success. Release it
  when the request fails, is moderated out, or is aborted by the client, and expire it so a crashed
  request cannot hold it forever. Reconcile with `usage_records` so displayed usage and enforcement
  stay one number.

**Release-readiness review, evening of 2026-10-06** (_repo_ unless marked _owner_)

Release candidate: `main` = `1e510df`, which includes #244 (`sharp` 0.35.5, clearing
GHSA-wq5f-xc86-pv6w) and #243 (Sentry environment label). Main CI run 37510636165 passed. Staging
release #130 passed on `1e510df`. Production still serves `fc64572`. Each conclusion below comes
from the code paths inspected at `1e510df`; none is a guarantee about paths not inspected.

- **Supabase Phase 0 evidence** (_owner_, production, 2026-10-06):
  - **Vault:** 0 secrets.
  - **Auth Hooks:** none configured.
  - **Extensions:** `http`, `dblink`, `postgres_fdw`, `wrappers` and `pg_net` are all OFF.
  - None of these was changed.
- **Access-token hook: claim design (finding; plan only, not implemented).**
  - **What depends on it:** RLS helpers `auth_org_id()` and `auth_role()` read `org_id` and `role`
    from the JWT. Only `public.custom_access_token_hook` adds `org_id`, and production has no hook
    registered.
  - **Effect today:** under RLS, the Supabase-native path is deny-all for org-scoped rows. The only
    such path in the app is the browser Realtime subscription behind the topbar's live unread badge
    (`src/hooks/use-notifications.ts`; `notifications_select` requires
    `organization_id = auth_org_id()`). It fails closed: the badge updates only on reload, and
    nothing leaks.
  - **Unaffected:** application data and Storage access go through Prisma, which bypasses RLS,
    and server-side admin or signed URLs, with tenant isolation enforced in the application.
  - **Do not register the hook as written.** It overwrites the JWT `role` claim with the
    organization role (`OWNER`/`ADMIN`/…). Supabase uses `role` to choose the Postgres role for
    REST and Realtime, so registering it would most likely break every user-JWT request.
  - **Proposed fix (needs approval; touches auth, RLS and migrations):** a migration that writes
    the organization role to a separate claim (for example `org_role`), keeps `role` untouched, and
    redefines `auth_role()` to read it. Then register the hook on staging, verify, and only then on
    production.
- **Redis/QStash environment separation (finding; owner check before any database clone).** Redis
  keys carry no environment prefix: `ent:v2:{orgId}`, `idem:…`, `rl:*`, `vapi:tool:…`,
  `vapi:eocr:…`, `synced:…` and others.
  - **If staging and production share one Upstash database:** that's harmless while their database
    IDs differ. After a production-to-staging clone, IDs would collide. Staging would then read and
    write production's entitlement cache, idempotency keys, rate limits and Vapi state.
  - **Owner check:** compare the Upstash Redis REST URL host (host only, never the token) and the
    QStash project between the two Vercel projects. Confirm they are separate before any clone.
- **Clone target vs staging policy (decision).** This runbook requires staging to be "a dedicated
  Supabase project containing no production data". Cloning production into the staging project
  would contradict that. A clone needs its own isolated project, with outbound work disabled
  (`pg_cron`, webhooks, Edge Functions, provider callbacks), or an explicit policy change.
- **Edge Functions.** The repository defines only `gdpr-erasure`, and nothing in code, scripts or
  workflows invokes it. Whether it's deployed to production is unknown (_owner_ check).
- **Full dependency audit (development tooling only).** `npm ci` reports 23 vulnerabilities
  (1 low, 8 moderate, 11 high, 3 critical), identical in staging releases #128–#130.
  - **Sources:** `eslint-config-next`, `react-email` (with its own `next@15.1.2`), `vitest` /
    `tinypool`, `tailwindcss` → `chokidar`, `engine.io`, `undici`.
  - **Production:** the blocking production audit is clean.
  - **Fix:** mostly breaking major upgrades, which need a planned toolchain update and approval.
- **Open PRs.**
  - #193 and #144 are superseded by #234 (owner may close).
  - #209 (no abort check before a model-requested tool starts) is still relevant on `main`. Write
    tools are proposed rather than executed, so the impact is wasted read-only work and cost. It's
    stale and needs an update from `main`.
  - #145 (Creator Studio shown in every role's navigation without the feature flag) is still
    relevant; the page itself shows a "not available" message.
  - #238 stays deferred.
- **E2E coverage.** Staging runs smoke (28) and auth journeys (3) only. There's no end-to-end
  coverage for billing/checkout, invitations and seat limits, inbox, voice, calendar booking, or
  data export and deletion (#115 has proposed broader scenarios since 2026-09-06).
- **Dated snapshot docs.** `FEATURE-INVENTORY`, `PROJECT-CONTEXT`, `PROJECT-STATUS`, `DECISIONS`,
  `ROADMAP` and `NEXT-STEPS` still say Sentry has "no SDK integration". That was accurate on their
  2026-07-23 snapshot date and is superseded by #226; `docs/DEVELOPMENT.md` is current.

**Prepared plans, 2026-10-07** (_repo_; none implemented on `main`, nothing merged)

- **#209 (no tool after client disconnect).**
  - **Status:** updated from `main` to `37d70e2`; CI 17/17 green; still a Draft.
  - **Change:** the abort check is now the first statement in `onToolUse`, before the voice tool
    limit and the write-proposal path.
  - **Tests:** one covers proposals, one is a connected-client control. Removing the guard fails
    both abort tests.
  - **Ready for owner review.**
- **Access-token hook redesign (plan only; auth, RLS and migrations need approval).** Three
  defects make the current hook unsafe to register:
  1. It overwrites the JWT `role` claim, which Supabase uses to choose the Postgres role.
  2. It runs as `supabase_auth_admin` without `SECURITY DEFINER`, and that role has no grant or
     RLS policy on `organization_members`. The hook would most likely fail, and with it every
     token issuance, so nobody could log in.
  3. `EXECUTE` on the hook and on `auth_org_id()` / `auth_role()` was never revoked from
     `PUBLIC`, so PostgREST exposes the hook as an RPC. It runs as the invoker under RLS, so it
     reveals nothing today, but it shouldn't be callable.

  **Proposed single migration:**
  - The hook writes `org_role` instead of `role`.
  - Grant `supabase_auth_admin` `SELECT` on `organization_members`, plus an RLS policy
    `FOR SELECT TO supabase_auth_admin USING (true)` (Supabase's documented pattern), instead of
    `SECURITY DEFINER`.
  - `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` on the hook.
  - Redefine `auth_role()` to read `org_role`.
  - Policy text stays unchanged. The contract checks policy expressions by function name, not
    function bodies.

  **Tests:**
  - **RLS suites:** update the four isolation suites to claims `{role: "authenticated",
org_role: …}`.
  - **Hook as `supabase_auth_admin`:** returns `org_id`/`org_role` and leaves `role` untouched.
  - **Non-members:** gain no claims.
  - **API roles:** `authenticated` and `anon` can't call the hook.

  **Rollout:**
  1. Merge.
  2. Staging release.
  3. Register the hook on staging and verify login, the live unread badge, and REST under RLS.
  4. Only then, production.

- **#145 (Creator Studio navigation behind its flag).**
  - **Status:** 232 commits behind; conflicts only in `tests/unit/mobile-nav.test.tsx`.
  - **Plan:**
    1. Update from `main` and resolve the test conflict.
    2. Read the flag from the organization row the layout already loads, instead of
       `isFeatureEnabled()` (an extra query on every app page).
    3. Move the flag key to one shared, non-server-only constant used by `nav-items.ts`,
       `creator-profiles.ts` and the layout (today it's three hand-synced literals).
    4. Pass `string[]` rather than `Set` to the client components.
  - **Impact:** UI only; pages already handle a disabled flag.
- **E2E coverage, prioritized.** Each needs a disposable staging fixture, and any new fixture step
  in `staging-release.yml` is a protected workflow change.
  1. **Invitations and seat limit** (P1). A second test identity accepts an invitation; a full
     plan shows the error and creates no membership.
  2. **Billing page** (P1). Plan cards, the organization-level allowance copy, and usage meters.
     Checkout only up to the redirect, and only with Stripe test keys on staging.
  3. **Inbox** (P2). A seeded thread renders and a reply draft is saved, with no external send.
  4. **Calendar booking** (P2). The public booking page books a far-future slot and cancels it
     through the manage link.
  5. **Voice** (P3). Readiness UI only; never a paid call.
  6. **Export and deletion.** Blocked until the capability exists.
- **Development-only dependency advisories.**
  - **Safe, lockfile-only and in range:** `undici` 8.10.0 → 8.11.2 (`jsdom` `^8.9.0`) and
    `engine.io` 6.6.9 → 6.6.11 (`socket.io` `~6.6.0`, under `react-email`).
  - **Planned major upgrades:**
    - `vitest` 3.2.7 → 4.1.11, which is outside the flagged `vitest` range and should clear the
      `tinypool` critical;
    - `react-email` 3 → 6, which removes its nested `next@15.1.2` with critical advisories. It's
      used only by the `email dev` preview; runtime rendering uses `@react-email/components`.
  - **No fix exists:** `braces` (every version flagged), reached through build-time globbing in
    `tailwindcss` 3 and `eslint-config-next`. Patterns are repository-controlled; accept and track.
- **Production → isolated clone: what the code shows.**
  - **No database-scheduled outbound work in the repository:** no `pg_cron`, `pg_net`, `http` or
    function webhooks; the only trigger is `on_auth_user_created`. The owner's 2026-10-04
    production preflight found the same.
  - **Where the risk comes from:** cloned data plus shared keys, not the database.
    - Real customer emails and phone numbers could receive staging reminders, invitations or
      workflow messages.
    - Calendar and social tokens decrypt only if the clone environment shares
      `CALENDAR_TOKEN_ENCRYPTION_KEY` / `SOCIAL_TOKEN_ENCRYPTION_KEY` with production.
    - Stripe, Vapi and Meta IDs point at production resources if the provider accounts are shared.
    - Redis keys collide if the Upstash database is shared.
  - **Requirements for a clone:**
    - its own project and Vercel environment, with separate keys, Redis and QStash;
    - outbound email, SMS and voice disabled, or contact data scrubbed;
    - no production provider webhooks pointing at it.

## Addendum (2026-10-04): production preflight review

This addendum supersedes §7's 2026-07-23 status for the items below. It reuses existing release
records and reads the repository, the GitHub Actions run history, and the public `/api/health` endpoints
(read-only). No secret, connection string or Vercel environment value was read. Staging serves
`b0f3119` (release #122). Production serves `fc645727cc8f0932f90c793667d8cfe3de0b35d3` (production
run 36142165182, 2026-09-25), healthy.

**Separate evidence (not backup evidence):** staging release #124 deployed `7a1a8fe` (calendar,
booking and R2 fixes) on 2026-10-04. Migrations, RLS, storage policy, smoke, auth-journey and E2E
password-restoration steps passed, and production stayed at `fc645727`. This says nothing about
backups or recovery.

### Confirmed blockers (before production)

| Item                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | What closes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backup/PITR and restore evidence**          | Owner dashboard observation, 2026-10-04: daily PHYSICAL backups 2026-09-27 to 2026-10-03 (latest 22:15:37 UTC); **PITR not enabled**; Storage objects are excluded from the observed database backups; separate Storage backup coverage is **unverified**; **no restore tested**. Owner-run read-only preflight, 2026-10-04 18:18 UTC: no outbound-capable extensions, cron, `pg_net` or webhook objects, triggers, foreign servers or subscriptions. Its one function-pattern match is explained: Supabase's permission-only helper `extensions.grant_pg_net_access()` (owner `supabase_admin`), whose body hash exactly matches Supabase-authored source. Whether that definition is a hosted release is unverified. This describes production now, not the backup. Supabase support ticket SU-494644 (restore isolation) was submitted and acknowledged; the technical response is pending, so the physical restore drill stays **blocked**. The runbook's mandatory PITR gate is **not met**. See `docs/release-runbook.md`, "Backup and recovery evidence". | (1) A passing restore drill. Option A (a temporary project restored from the PHYSICAL backup) is **blocked**: a restored copy runs `pg_cron`/`pg_net` work as soon as it completes, and Supabase offers no outbound isolation. It needs Supabase's written confirmation or an owner risk acceptance on the read-only preflight. Its cost depends on the production compute size; $5 is an approval limit, not an enforced cap. (2) An owner decision: keep PITR mandatory (about $100/month or more) or adopt the proposed alternative gate. (3) Verify Storage backup coverage, or the owner's written acceptance of the Storage-loss risk. |
| **Data export and deletion process (P1-10)**  | **Documented procedure ≠ verified capability.** #228 documents a _manual_ procedure (`docs/release-runbook.md` § "Data export and deletion requests"). **Complete deletion is not verified:** no export or deletion tool exists, `gdpr-erasure` is incomplete (no nested storage files, two buckets skipped, errors ignored, no Stripe step, deployment unknown), and plain user-id columns need manual handling. The procedure has never been exercised end to end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | (a) Owner sign-off and legal review of the procedure. (b) **A dry run on a disposable non-production organization** (staging fixture data only): export, then soft delete, then hard delete, with evidence of zero remaining rows for `<ORG_ID>`, zero objects under `<ORG_ID>/` in all five buckets, and the provider-side steps listed. Until (b) passes, report deletion as "procedure documented, capability unverified"                                                                                                                                                                                                                 |
| **Error tracking active and verified (P1-2)** | #226 is merged and inactive. No DSN is configured; nothing has been received live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `docs/PROVIDER-ACTIVATION-CHECKLIST.md` § 11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Unverified conditions (owner verification required)

| Item                                                     | What is known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exact owner check                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Production runtime `DATABASE_URL` pooler mode** (#143) | The app adds `pgbouncer=true` itself when the port is `6543` (`ensurePgbouncerCompatibility`). The production workflow runs migrations and SQL gates only on `PROD_DIRECT_URL`, and `PROD_DATABASE_URL` only for `prisma migrate`. **The runtime value lives in the production Vercel project and isn't validated anywhere.** Owner observation, 2026-10-04: project `syveka-ai-production` has `DATABASE_URL` scoped to Production and stored as a Secret, which the dashboard can't reveal; the owner left without saving. That proves a Production-scoped variable exists, **not** which value the currently deployed build uses: a deployment keeps the values it was built and started with. Host, port and pooler mode are **UNVERIFIED**. The repository has no read-only way to establish them: `/api/health` reports only reachability, and `PROD_DATABASE_URL`/`DIRECT_URL` are different values. #143 (Draft, last updated 2026-09-12) adds a port check for `PROD_DATABASE_URL`, with its `deploy.yml` wiring left unapplied as a protected path. | In the production Vercel project (Production environment), confirm that `DATABASE_URL`'s host is the Supabase **transaction** pooler (`*.pooler.supabase.com`) on port `6543`. Answer yes or no; don't share the value. Then decide whether #143 should also check the Vercel runtime value, since it currently checks the GitHub secret only |
| **Stripe dunning**                                       | The webhook marks `PAST_DUE` on `invoice.payment_failed` and clears it on `invoice.paid`. Entitlements become read-only after 14 days `PAST_DUE`. **The app sends no dunning emails.** The comment "Dunning email sequence is triggered by the billing service (day 0/3/7)" in `src/app/api/v1/webhooks/stripe/route.ts` describes nothing that exists (no template, job or service).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | In the Stripe dashboard (live mode): Billing → Revenue recovery. Confirm Smart Retries are on, the retry schedule ends within the app's 14-day read-only window, failed-payment customer emails are on, and the end-of-retries action (cancel vs. leave unpaid) is set. Confirm a failed payment produces a customer email                    |
| **Vapi write tools in production**                       | A tool call is authenticated by HMAC Custom Credential (`753e582`, #95). The assistant must belong to a non-deleted org and be active, the tool must be in its per-assistant `enabled_tools` (set only with `voice:configure`), tool-call ids are replay-guarded, and the call runs as a MANAGER-level service identity. **Confirmation before a write is prompt-only for the phone assistant** (`docs/ai-tool-confirmation-followup.md`, an open product decision).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A read-only count on production, by the owner: `select count(*) from voice_assistants where is_active and enabled_tools ?\| array['createContact','logActivity','bookMeeting'];`. If the count is above zero, either accept prompt-only confirmation for phone calls in writing, or disable those tools before launch                         |
| **Retention purge schedule**                             | `jobs/usage-rollup` hard-deletes soft-deleted contacts, documents and conversations after 30 days, but no QStash schedule for it is documented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Confirm in QStash that a recurring schedule targets `/api/v1/jobs/usage-rollup` in production                                                                                                                                                                                                                                                 |
| **Test 8 (one contact after a reopened Confirm)**        | Not established on a phone (`docs/ai-tool-confirmation-followup.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Optional repeat, at the owner's discretion                                                                                                                                                                                                                                                                                                    |

### Requires pre-production assessment (not deferred by default)

These two #73 residuals are present on `main` at `63f8559`. Each needs an explicit owner decision
**before** production: fix it, or accept it in writing with its impact. They are not after-launch
items by default. Paths, protections and acceptance tests are in `docs/SECURITY-AUDIT.md`,
addendum 2026-10-04.

| Finding                                                                                                                                                                                                                                                                                               | Concrete impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Smallest proposed fix                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1. A removed member's calendar keeps flowing into the organization** (fixes proposed in Drafts #229 and #230 (booking links, stacked); open until merged and released; imported-event retention still an owner decision; members removed and rejoined before #230 deploys are not distinguishable) | `removeMember` deletes only the membership. The member's `calendar_connections` row (no FK on `user_id`) and encrypted tokens remain, and `jobs/calendar-sync` keeps importing their external events into the organization. That includes title, description, location and up to 50 attendees per event, visible in the organization's calendar. Public booking availability is computed from those events, so a former member's private schedule shapes the organization's bookable slots. The former member can't disconnect it, because that action requires membership. Separately, `completeConnection` checks membership only before the provider token exchange, so a member removed during OAuth still gets a connection persisted. No write-back to external calendars was found. | (1) In `removeMember`, delete or mark revoked the user's calendar connections for that organization, in the same transaction, with a best-effort provider token revoke. (2) In `completeConnection`, re-read the membership in the same transaction as the connection upsert, after `exchangeCode`. (3) Optionally, make sync skip connections whose user isn't a current member (defense in depth) |
| **R2. Jobs still act for a soft-deleted organization** (fix proposed in Draft #231; open until merged and released; `run-workflow` steps not covered)                                                                                                                                                 | During the 30-day grace period, `publish-creator-post` can **publish to Meta**, `send-reminder` can **email booking attendees** (third parties), and `embed-document` and `post-call` make **paid AI calls** and write contacts. That happens for an organization that asked to be deleted. How often it occurs depends on the manual soft-delete procedure, since no UI or action sets `deleted_at` today.                                                                                                                                                                                                                                                                                                                                                                                | A shared `isOrganizationActive(orgId)` guard at the start of those four jobs, returning `200 { skipped: "organization_deleted" }` (no QStash retry). Until then, the runbook's step 5.1 (stop scheduled side effects before soft deletion) is mandatory                                                                                                                                             |

### Optional improvements (after launch)

- **Pooler check:** wire #143 into `deploy.yml` (a protected path, so human review), or extend it to
  the Vercel runtime value.
- **Stale comment:** remove the misleading dunning comment, or implement app-side dunning email.
- **Server-enforced confirmation for Vapi write tools.**
