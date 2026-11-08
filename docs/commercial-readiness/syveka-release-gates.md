# Syveka — release gates for the first customer pilot (2026-11-08)

## Scope and status vocabulary

These gates are for a **controlled free pilot**: the FREE plan plus entitlement grants, no
payment, the package in `syveka-first-commercial-release.md`. A paid launch adds the gates in
§2.

Status words:

- **PASS**: verified evidence exists.
- **BLOCKED**: a known reason prevents it.
- **UNKNOWN**: no evidence either way.

A missing gate is never assumed to pass.

## 1. Pilot gates (all must PASS before the first pilot customer is onboarded)

| Gate                              | Pass criteria                                                                                                     | Evidence required                                                                                                                    | Current status                                                                                           | Owner          | Blocking | Next action                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------- | -------- | ---------------------------------------------------------------- |
| G-CI: Build and CI                | Required CI green on the commit to be released                                                                    | GitHub Actions run on that SHA                                                                                                       | **PASS** for `40f71ae` (run 41612655177); pending for this branch's head                                 | Owner/CI       | Yes      | CI on this PR                                                    |
| G-SEC: Security                   | No open P0/P1; production audit has 0 high/critical; RLS jobs green                                               | Review reports; `npm audit --omit=dev`; RLS CI jobs                                                                                  | **PASS** (no P0/P1 found; audit 0 high/critical; RLS jobs green at `40f71ae`)                            | Claude         | Yes      | Re-review after any further change                               |
| G-TEN: Tenant isolation           | Cross-tenant reads and writes refused on every pilot module, at both the app and DB layers                        | <ul><li>RLS suites (superuser and non-superuser)</li><li>App-layer review</li><li><code>tenant-models-coverage</code> test</li></ul> | **PASS** (automated and review). Live-environment policy diagnostics are owner-run                       | Claude / Owner | Yes      | Optional: run the read-only staging diagnostic workflows         |
| G-AUTH: Authentication            | Sign-up, login, recovery, invite and onboarding work on the pilot environment                                     | Staging E2E auth journeys plus an owner sign-up on a fresh email                                                                     | **UNKNOWN** for the release to be deployed (last proven on `19581f2`)                                    | Owner          | Yes      | Run staging release validation with the auth and invite journeys |
| G-DATA: Data integrity            | Booking, CRM and Business DNA writes are atomic, conflict-safe and audited                                        | Unit and PostgreSQL suites; fixes F1–F5                                                                                              | **BLOCKED** until `03685ac` is merged and deployed                                                       | Owner          | Yes      | Merge after review                                               |
| G-JOURNEY: Core journeys          | Journeys 1–4 and 6 in `syveka-first-customer-acceptance.md` pass on the pilot environment                         | Owner-observed checklist plus the staging E2E                                                                                        | **UNKNOWN**: there is no booking E2E, and chat confirm was never owner-observed (B4, B5)                 | Owner / Claude | Yes      | Add the booking E2E; owner runs the checklist                    |
| G-ENT: Entitlements               | FREE limits are enforced; grants apply and expire; voice, workflows and Creator Studio stay off                   | Unit tests; grants runbook; owner grant on the test org                                                                              | **PARTIAL**: enforcement is unit-tested and the storage gap is fixed here; superadmin is unverified (B7) | Owner          | Yes      | Verify superadmin; grant and revoke on the test org              |
| G-PAY: No accidental payment      | Pilot environment Stripe keys are test-mode or absent                                                             | Owner read-only check of the key prefix                                                                                              | **UNKNOWN** (B6)                                                                                         | Owner          | Yes      | Check the key prefix; never paste it                             |
| G-MON: Monitoring                 | An external uptime check on `/api/health` alerts on failure and build drift; Sentry receives errors               | Monitor configuration screenshot; a Sentry test event                                                                                | **BLOCKED**: not configured (B3)                                                                         | Owner          | Yes      | Configure                                                        |
| G-BAK: Backups and recovery       | Backup/PITR retention is known and one restore drill has succeeded on a non-production copy                       | Supabase plan page; drill record (`recovery-drill-checklist.md`)                                                                     | **BLOCKED**: no restore has been performed (B2)                                                          | Owner          | Yes      | Run the drill                                                    |
| G-ERR: Error handling             | Provider outages give a clear error, not a hang or corruption; limits give 402/429 with a message                 | Unit tests (fallback, retry, fail-closed limiters)                                                                                   | **PASS** (automated, mocked providers)                                                                   | Claude         | No       | —                                                                |
| G-SUP: Support procedures         | A named contact, response time, and data-request and incident runbooks are known to the pilot                     | `free-pilot-launch-runbook.md`, `pilot-data-requests-runbook.md`                                                                     | **PARTIAL**: runbooks exist; no named on-call or response time                                           | Owner          | Yes      | Name the support contact and hours in the pilot agreement        |
| G-PRIV: Privacy and customer data | The pilot customer accepts placeholder terms in writing (or the final texts exist); a sub-processor list is given | Signed pilot agreement                                                                                                               | **BLOCKED**: placeholder legal texts (B14)                                                               | Owner          | Yes      | A pilot agreement covering data processing                       |
| G-DEP: Deployment verification    | `/api/health` on the pilot host returns healthy, `database: ok`, `redis: ok`, and `build` = the released SHA      | Health response captured by the owner                                                                                                | **UNKNOWN**                                                                                              | Owner          | Yes      | After deploy                                                     |
| G-RB: Rollback readiness          | The previous good SHA is known; the redeploy procedure is written; the migrations in the release are additive     | `release-runbook.md`; the migration list in the release                                                                              | **PARTIAL**: the runbook exists; this branch has no migration                                            | Owner          | Yes      | Record the previous SHA at release time                          |

## 2. Additional gates for a paid launch

| Gate                        | Pass criteria                                                                                    | Current status    |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| G-BILL: Checkout            | One test-mode Checkout → webhook → entitlement round trip on staging; #394 reviewed and resolved | **BLOCKED** (B16) |
| G-DUN: Dunning              | `pastDueSince` implemented; customers are emailed about payment failure                          | **BLOCKED** (B17) |
| G-LEGAL: Legal texts        | Final privacy policy, terms and DPA from counsel, published in FI/EN (AR if marketed)            | **BLOCKED** (B14) |
| G-GDPR: Data subject rights | Export and deletion implemented and tested                                                       | **BLOCKED** (B15) |
| G-COST: Unit economics      | Measured AI cost per active organization, below the plan price with margin                       | **UNKNOWN** (B18) |

## 3. Decision rule

- **GO for the controlled pilot:** every gate in §1 is PASS.
- **Current state:** 4 PASS, 3 PARTIAL, 4 UNKNOWN, 4 BLOCKED, so the decision is
  **CONDITIONAL GO AFTER SPECIFIC CHECKS**. Every remaining item except the booking E2E needs
  owner access or a decision, not new product engineering.
