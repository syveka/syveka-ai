# Syveka — test evidence (commercial readiness review, 2026-11-08)

Every result below was observed in this review or read from GitHub Actions run records. A
mocked test is a mocked test. Nothing here was run against staging or production.

**Environment for local runs.** A cloud container (Linux, Node 22.23.4, `npm ci` from the
lockfile).

- Base: `main` = `40f71ae` (merge of #393).
- Branch: `ccr-f069ae60-b2t5pw`. Fix commits `03685ac` and `042ebba` (review fix), followed by documentation commits.

**Local restrictions.** A repository guardrail hook (`.claude/hooks/command-guard.mjs`)
refuses any agent command that reads `DATABASE_URL`/`DIRECT_URL`, and it asks before
`prisma migrate`. I respected it and did not work around it. As a result, the following were
**not run locally**, and their evidence below comes from CI:

- migration deploy
- the psql RLS/invariant jobs
- the opt-in PostgreSQL suites
- the shell concurrency races in `tests/integration/*.sh`

## 1. Local runs

### Baseline at `40f71ae` (before any change)

| Command                    | Result   | Detail                                                                      |
| -------------------------- | -------- | --------------------------------------------------------------------------- |
| `npm ci`                   | PASS     | lockfile install                                                            |
| `npx prisma generate`      | PASS     |                                                                             |
| `npm run typecheck`        | PASS     |                                                                             |
| `npm run lint`             | PASS     |                                                                             |
| `npm run format:check`     | PASS     |                                                                             |
| `npm run i18n:check`       | PASS     | EN/FI/AR key parity                                                         |
| `npm run migrations:check` | PASS     | order and published checksums                                               |
| `npx prisma validate`      | PASS\*   | \*CI sets placeholder `DATABASE_URL`; with no URL it fails on config only   |
| `npx vitest run`           | PASS     | 344 files passed, 9 skipped; **4901 passed, 55 skipped, 0 failed**; 107.7 s |
| `npm audit --omit=dev`     | 12 found | 0 critical, 0 high, 6 moderate, 6 low (see §4)                              |
| `npm audit` (incl. dev)    | 27 found | 3 critical, 5 high (all dev-only, see §4)                                   |

The 55 skipped tests are the env-gated real-PostgreSQL/Redis suites:

- `SEAT_LIMIT_PG_URL`
- `ORG_SETTINGS_PG_URL`
- `ENTITY_EVENTS_PG_URL`
- `VOICE_PG_URL`
- `VOICE_REDIS_TEST_URL`
- the tool-gated recovery-drill tests

**They are skipped, not passed.** CI runs two of them, the seat limit and post-call
concurrency, in a job that fails if they skip (§2).

### After the fix commits (final code at `042ebba`)

| Command                    | Result     | Detail                                                                                                |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `npm run format:check`     | PASS       |                                                                                                       |
| `npm run lint`             | PASS       | the first run flagged an `import()` type in the new test; fixed                                       |
| `npm run typecheck`        | PASS       |                                                                                                       |
| `npm run i18n:check`       | PASS       | no strings added                                                                                      |
| `npm run migrations:check` | PASS / N/A | no schema or migration change                                                                         |
| `npx vitest run`           | PASS       | 345 files passed, 9 skipped; **4924 passed, 55 skipped, 0 failed**; 105.2 s (4921 at `03685ac`)       |
| `npm run build`            | PASS       | `SKIP_ENV_VALIDATION=1` plus the non-secret `NEXT_PUBLIC_*` placeholders that CI uses                 |
| `npm run test:e2e`         | NOT RUN    | Needs a deployed app plus Supabase credentials. It belongs to the owner-dispatched staging validation |

**Fail-first evidence** (each new test was run against the previous code before the fix):

| Test file                                           | New tests | Failed before fix                                                                     | Pass after |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------- | ---------- |
| `tests/unit/calendar-slots.test.ts`                 | 4         | 4                                                                                     | 4          |
| `tests/unit/booking-service.test.ts`                | 6         | 5 (1 guards the fix against a false match)                                            | 6          |
| `tests/unit/kb-storage-entitlement.test.ts` (new)   | 11        | 6 of 8 on `40f71ae` (2 are allowed-path controls); 3 ordering tests fail on `03685ac` | 11         |
| `tests/unit/ingestion-endpoint-rate-limits.test.ts` | 2         | 2 (routes reverted)                                                                   | 2          |

**Changed fixtures**, with no assertion weakened:

- `booking-owner-removal.test.ts` and `booking-type-pause.test.ts`: added
  `contact.findMany` to the fake transaction.
- `document-tenant-integrity.test.ts`: added `aggregate` to the fake transaction.
- `booking-token-superseded.test.ts`: the exact guarded-claim assertion now also lists
  `COMPLETED`. It is stricter, not looser.

Focused runs after the fix:

- booking and calendar: 36 files, 526 tests passed
- KB, document and ingestion: 7 files, 81 tests passed

## 2. CI evidence

**Run [41612655177](https://github.com/syveka/syveka-ai/actions/runs/41612655177)** (CI on
`main` at `40f71ae`, 2026-11-03): **18 of 18 jobs succeeded.** The jobs were:

- Secret scan
- i18n key parity
- Migration structure validation
- Install dependencies
- Full dependency audit report
- Prisma validate and generate
- Production dependency security audit
- Initial baseline idempotency and failure-clarity
- Unit and integration tests
- Opt-in PostgreSQL suites (seat limit, post-call concurrency; "they must run, not skip")
- TypeScript typecheck
- Production build
- RLS isolation tests (superuser)
- RLS isolation tests (non-superuser, Supabase-like role)
- Legacy, drift and policy migration tests
- Lint
- CI required

The "Full dependency audit report" job passes as a **report**. It does not block, and it does
not mean zero vulnerabilities (§4).

**Staging:**

- Staging release validation ([run 160](https://github.com/syveka/syveka-ai/actions/runs/41324509644),
  2026-11-01) succeeded on `19581f2`. That workflow includes the Playwright E2E against staging.
  The pass/skip counts per spec are in that run's logs and were not re-read here.
  `docs/release-readiness-eca6822.md` records an earlier run: 29 passed, 0 failed, 12 skipped.
- Staging deploy-only ([run 41615232238](https://github.com/syveka/syveka-ai/actions/runs/41615232238),
  2026-11-03) succeeded. It deployed the pinned `b129d41`. **Deploy-only runs no E2E.**
- `b129d41..40f71ae` changes only two CI pin files.

**Production:** the last production release was
[run 36142165182](https://github.com/syveka/syveka-ai/actions/runs/36142165182) on
2026-09-25 at `fc64572`. That is **156 commits behind `main`**.

The fix commit in this branch is **not** on staging or production.

## 3. What the automated suites do and don't prove

| Area                  | Automated evidence                                                                                                                                                                                                                            | Not proven by it                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation      | <ul><li>RLS SQL suites: two CI jobs, including the non-superuser role</li><li><code>tenant-models-coverage</code> and app-layer unit tests</li><li>a read-only review of every launch-module write path (no exploitable path found)</li></ul> | live Supabase policies on staging/prod (separate owner-run diagnostics exist)                                             |
| Booking               | <ul><li>526 unit tests (mocked DB, real slot/timezone code, DST cases)</li><li>advisory-lock design</li><li>the shell races, run in CI only via the RLS job's DB</li></ul>                                                                    | <ul><li>real concurrent POSTs against PostgreSQL in this review</li><li>email delivery</li></ul>                          |
| Business DNA via chat | <ul><li>unit tests of propose / preview / confirm, single-use Redis decide, allowlists, compare-and-set, audit in the same transaction</li><li>staging E2E for the form path</li></ul>                                                        | live chat Confirm/Cancel on staging; Arabic/mobile visual layout (marked UNVERIFIED in `release-readiness-2026-10-29.md`) |
| AI chat / KB          | route and service unit tests with **mocked providers**                                                                                                                                                                                        | retrieval quality with real embeddings; real provider failures                                                            |
| Billing               | webhook and plan-change unit tests over a **fake Stripe**                                                                                                                                                                                     | any real Checkout session, even in test mode (`PROVIDER-ACTIVATION-CHECKLIST.md`)                                         |
| E2E (Playwright)      | <ul><li>smoke: public pages, locale switch, auth redirect, health, chat streams, CRM contact create, deals board</li><li>Business DNA form</li><li>invites and auth journeys (opt-in)</li></ul>                                               | **no public booking journey** (book, calendar, CRM, cancel/reschedule); no KB upload journey                              |

## 4. Dependency vulnerability inventory (`npm audit`, 2026-11-08, lockfile at `40f71ae`)

**Production dependencies (`--omit=dev`): 0 critical, 0 high, 6 moderate, 6 low.**

| Package (via)                                                        | Severity | Exposure                                                                          | Blocking           |
| -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- | ------------------ |
| `qs` (transitive)                                                    | moderate | `stringify` DoS with `arrayFormat: 'comma'` on odd input; reachability not traced | No (track)         |
| `glob`, `minimatch` via `@sentry/nextjs` → `@sentry/bundler-plugins` | moderate | build-time source-map upload tooling, not request handling                        | No                 |
| `@sentry/node`                                                       | moderate | through the same advisory chain                                                   | No (track upgrade) |
| `deepmerge` → `html-to-text` → `@react-email/render`, `resend`       | low      | email rendering with server-built input                                           | No                 |
| `@babel/core` (transitive)                                           | low      | file read via a `sourceMappingURL` comment; build-time                            | No                 |

**Dev-only: 3 critical, 5 high.**

| Package                            | Exposure                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `next@15.1.2` inside `react-email` | Local email preview tool only. Production `next` is **15.5.28**, outside the vulnerable range `9.5.0 – 15.5.27`; `npm ls next` confirms this |
| `vitest`, `tinypool`, `vite`       | test runner; local or CI only                                                                                                                |
| `engine.io`, `undici`, `glob`      | dev tooling                                                                                                                                  |

None of these ships in the production bundle. They should still be upgraded in a separately
authorized dependency change (CLAUDE.md §9).

## 5. Unresolved failures

None. No test, lint, type, format or build check fails at `042ebba`.

## 6. Independent reviews (2026-11-08)

Each review ran as a separate, read-only agent that read the code itself.

| Review                                              | Scope                                                                 | Result                                                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Security: tenant isolation and RBAC                 | CRM, Business DNA, booking/calendar, chat/KB, members (`40f71ae`)     | **No P0, P1 or P2.** Two P3s: a VIEWER can spend AI quota through meeting summaries; member role change and removal have no write limiter (blockers B12)                                                     |
| QA: booking correctness                             | Slots and DST, conflicts, tokens, validation, CRM sync (`40f71ae`)    | D1–D2 (P2) and D3 (P3) **fixed here**. Open P3s: D4, retry idempotency, schedule-save atomicity (B13)                                                                                                        |
| Product/reliability: Business DNA, entitlements, KB | Propose / confirm / apply / audit; FREE limits; ingestion (`40f71ae`) | Business DNA: **no defects**. KB storage bypass (P2) and off-by-one (P3) **fixed here**. Open P3s: contact limit on public booking, AI quota race and unmetered aborted turns, dunning clock (B10, B11, B17) |
| Code and security review of `03685ac`               | The fix commit                                                        | **1 blocking**: the storage check inside the transaction could hang the single-connection pool. Fixed in `042ebba`. 3 should-fix items were documented (B20)                                                 |
| Re-review of `042ebba`                              | The follow-up commit plus a recheck of `03685ac`                      | **No blocking issues remain.** Non-blocking residuals recorded (B20)                                                                                                                                         |

Commits after `042ebba` change documentation only and were not code-reviewed.

## 7. Second engineering round (draft PRs #418–#424)

Local runs used the same container and Node 22.23.4, with each branch in a scratch worktree.
CI is GitHub Actions `ci.yml`, which runs only on PRs whose base is `main`. The stacked PRs
were therefore retargeted to `main`, and their diffs include #417's commits until #417 merges.

### Per-PR results

| PR                 | Head      | Local full Vitest                                                                             | Browser tests                               | CI                                                                                                                                                         |
| ------------------ | --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #418 booking       | `c653940` | 346 files passed, 9 skipped; **4930 passed, 55 skipped, 0 failed**                            | 32/32 (`--repeat-each=2`)                   | pending at writing                                                                                                                                         |
| #419 KB            | `ccc388b` | earlier head `8ec7d48`: 4932 passed, 55 skipped, 0 failed; related suites on `ccc388b`: 88/88 | n/a                                         | **green** (run 42484052838)                                                                                                                                |
| #420 RBAC          | `6d9fec7` | 345 files passed, 9 skipped; **4919 passed, 55 skipped, 0 failed**                            | n/a                                         | **green** (run 42484782838)                                                                                                                                |
| #421 billing raise | `7c661aa` | earlier head `02d255d`: 4907 passed, 0 failed; billing suites on `7c661aa`: 161/161           | n/a                                         | **green** (run 42484874659)                                                                                                                                |
| #422 acceptance    | `7c25cdc` | (test-only)                                                                                   | 30/30; 52/52 earlier with `--repeat-each=2` | `a3608c1` **green** (run 42485615879); merge head pending                                                                                                  |
| #423 AI quota      | `8ce285b` | author's run on `3a55e13`: 4912 passed, 0 failed; chat suites on `8ce285b`: 225/225           | n/a                                         | **green** (run 42485435660)                                                                                                                                |
| #424 pastDueSince  | `977d921` | **1 failed** (expected: legacy-schema contract), 4916 passed, 55 skipped                      | n/a                                         | **fails only** "Migration structure validation" and that unit test; the RLS jobs, which apply the full migration history including the new migration, pass |

Typecheck, lint, format (tracked files) and i18n parity passed on every branch head listed.
`npm run build` was not re-run for round 2; CI's "Production build" job covers it on every
green run above.

### Fail-first evidence

Every new regression test was run against the code before its fix. In each case the failure
was observed, or a mutation was used to prove the test can fail. Examples:

- booking-service lock order (3 tests);
- the `saveSchedule` rollback;
- browser "slot taken" (the bug it found);
- the reschedule "slot taken" message and clearing the error on a new choice;
- the KB parallel-link, discard and root-in-transaction checks (mutation);
- composer 402 mapping;
- VIEWER refused; member write limits and inline refusals;
- held plan raise; canceled-row basis;
- the `pastDueSince` clock (13 tests, plus 2 for the backdating fix);
- the quota reservation (10 of 11 fail on `main`) and the slow release;
- harness isolation (`ERR_NAME_NOT_RESOLVED` before, `ERR_FAILED` after).

### Independent reviews (round 2)

| Scope                              | Result                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #418 booking                       | No blocking issue. Should-fixes (full schedule atomicity, reschedule message, stale error, fake fidelity, DECISIONS note) addressed in `c653940`                                   |
| #419 KB                            | **1 blocking issue:** the discard could delete a just-created document's file. Fixed in `ccc388b` with a test. Should-fixes (root-in-tx detection, 402 mapping, comment) addressed |
| #420 RBAC                          | No blocking issue. Should-fixes (inline refusals instead of an error page or silent failure) addressed in `6d9fec7`                                                                |
| #421 billing                       | No blocking issue. Partial-fix wording and the effective-plan comparison addressed in `7c661aa`                                                                                    |
| #424 pastDueSince                  | Blocked only on owner registration (3 protected files, verified). Event-time backdating addressed in `977d921`                                                                     |
| #423 quota                         | No blocking issue. Slow-release stream close addressed in `8ce285b`. Other AI_MESSAGES callers are a recorded follow-up                                                            |
| #422 acceptance                    | No blocking issue. Harness isolation fixed in `a3608c1`                                                                                                                            |
| Re-review of all follow-up commits | in progress at writing; see the PR descriptions for the outcome                                                                                                                    |

### PR #394 analysis

This was a read-only analysis of #394's head `ccb7578`; its tests pass (271/271). All four claimed defects are real on `main`:

1. The portal drops the chosen plan.
2. The scheduled cancellation is never shown.
3. Monthly↔annual switching is impossible.
4. A failed upgrade payment can grant PRO unpaid.

Defect 4 is unreachable in a free pilot. For a paid launch it is a medium revenue leak.

**Recommendation: split it.**

- The security part as a small fail-closed PR: #421, which is partial.
- The portal, cancellation and interval UX as a separate PR.

**Reasons:** `planRaiseHold` is about 250 lines; it depends on Stripe invoice shapes and
`retrieveUpcoming`; it makes up to about 100 Stripe reads per event; and with
`create_prorations` an upgrader can stay on Starter until the next renewal.

Owner decision required. Any merge needs explicit authorization.
