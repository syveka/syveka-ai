# Syveka — commercial readiness report (2026-11-08)

**Repository:** `syveka/syveka-ai`

**Base:** `main` = `40f71ae` (merge of #393; CI run 41612655177 green, 18/18 jobs).

**Branch:** `ccr-f069ae60-b2t5pw`

- Code fixes: `03685ac` and `042ebba`
- Documentation: later commits

**What this review did not do:** nothing was merged, deployed or run against staging or
production. No real payment, email, call or paid AI request was made.

**Companion documents (this folder):**

- `syveka-module-readiness-matrix.md`
- `syveka-first-commercial-release.md`
- `syveka-launch-blockers.md`
- `syveka-release-gates.md`
- `syveka-test-evidence.md`
- `syveka-first-customer-acceptance.md`
- `syveka-commercial-cost-assumptions.md`

These documents complement, and do not replace:

- `docs/free-pilot-launch-runbook.md`
- `docs/pilot-entitlement-grants-runbook.md`
- `docs/release-runbook.md`

## A. Executive verdict

**Is Syveka ready to sell today?** **No**, not as a paid product.

- **Payment:** no Checkout session has ever been completed, even in test mode. A known billing
  defect is still open in #394: an unpaid upgrade can grant Pro.
- **Legal:** the legal texts are placeholders, and GDPR export and deletion are not
  implemented.
- **Deployment:** production runs `fc64572` from 2026-09-25, 156 commits behind `main`.
- **Operations:** backups and restore, and monitoring, are unverified.

**What can be piloted safely?** A **controlled free pilot** on the FREE plan, with
admin-granted limits, for 3–5 appointment-based Finnish small businesses. It covers:

- onboarding and team
- Business DNA
- CRM
- booking and calendar
- the AI assistant and knowledge base

It can start once the owner-only checks in `syveka-release-gates.md` §1 pass. The code for this
package is complete, and the defects found here were fixed in this branch.

**Smallest viable commercial product:** "Syveka Business Starter". The core is online booking
that fills the CRM. On top of it sits an assistant that knows the business and changes its
profile only with confirmation. A safer, smaller variant is Booking + CRM with the AI kept at
the FREE quota.

**Decision:** **CONDITIONAL GO FOR A CONTROLLED FREE PILOT AFTER SPECIFIC CHECKS**, and
**NO-GO for a paid launch** (§J).

## B. Verified modules

These modules meet the pilot classification "READY FOR CONTROLLED PILOT", subject to the owner
gates. None is verified in production.

**Authentication, organizations, onboarding and roles.**

- Evidence: about 44 unit files and the seat-limit PostgreSQL suite in CI.
- RLS: green as superuser and as a non-superuser role (CI run 41612655177).
- Review: found no escalation path.
- Owner-run staging journeys exist; last full validation was run 160 on `19581f2`.

**CRM.**

- Every foreign key on the write paths is tenancy-checked (review).
- Smoke E2E: contact create → list, and the deals board.
- Owner-observed CRM checks are in `android-ar-acceptance-2026-11-01.md`.

**Business DNA.**

- The independent review found no defects: three-layer allowlist, compare-and-set,
  single-use confirm, audit in the same transaction, and VIEWER refused at confirm.
- The form E2E passes on staging.
- Still to do: one owner-observed chat-confirm run (B4).

**AI chat (typed).**

- The quota is checked before the model call; tools are confirm-first.
- Smoke "chat streams a reply" runs on staging with the real provider.
- Unit tests use mocked providers.

## C. Near-ready modules

**Booking and calendar (READY AFTER MINOR FIXES).**

Defects found and fixed in this branch:

- **F1:** a guest could reschedule a booking that had already been attended.
- **F2:** a guest email in a different letter case created a duplicate CRM contact.
- **F3:** DST and overlapping-override slots were duplicated or unsorted.

Remaining work:

- merge and deploy the fixes;
- add a Playwright booking journey (B5; none exists today);
- three P3s (B13);
- the documented AI-versus-guest booking lock gap (B9).

**Knowledge base (READY AFTER MINOR FIXES).**

- Fixed here: the FREE-plan storage limit could be bypassed (F4), and was off by one (F5).
- The review then caught a connection-pool hang in my first fix (F7), also fixed.
- Remaining: merge, plus the P3 residuals (B20).

## D. Not ready

| Module                                    | Classification                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing / Stripe                          | BLOCKED BY EXTERNAL VERIFICATION and #394                                                                                                                                                                     |
| Background-job schedules (QStash)         | BLOCKED BY EXTERNAL VERIFICATION                                                                                                                                                                              |
| Voice AI                                  | BLOCKED BY EXTERNAL VERIFICATION. The work is spread across unmerged draft PRs #404–#411 and the "DO NOT MERGE YET" candidate #415. It needs live paid calls, number-purchase control (#380) and legal review |
| Legal / GDPR                              | PARTIAL IMPLEMENTATION                                                                                                                                                                                        |
| Unified inbox / email                     | DEFER: no code path creates the mailbox                                                                                                                                                                       |
| Workflows                                 | DEFER                                                                                                                                                                                                         |
| Creator Studio, social publishing         | DEFER: flag off, variable cost, TikTok/YouTube mocked or blocked                                                                                                                                              |
| HyperFrames (#400)                        | EXPERIMENTAL                                                                                                                                                                                                  |
| External calendar sync (Google/Microsoft) | DEFER: not configured or tested                                                                                                                                                                               |

## E. Engineering work completed

**Commits**

- `03685ac` fix(booking, kb): launch-blocking booking and storage-limit defects
- `042ebba` fix(kb): run the storage check before the transaction, not inside it

**Files changed (code):**

- `src/server/services/booking.ts`
- `src/server/calendar/locks.ts`
- `src/server/calendar/slots.ts`
- `src/server/services/documents.ts`
- `src/server/services/billing/entitlements.ts`
- `src/app/api/v1/kb/documents/route.ts`
- `src/app/api/v1/ai/files/route.ts`
- `src/components/knowledge/upload-dropzone.tsx`

**Defects fixed:** F1–F7 in `syveka-launch-blockers.md`.

**Regression tests:** 23 new tests.

- One new file: `tests/unit/kb-storage-entitlement.test.ts`.
- Additions to `booking-service`, `calendar-slots` and `ingestion-endpoint-rate-limits`.
- Every new test fails on the previous code (except the allowed-path controls) and passes
  with the fix.
- Four fixtures gained mock methods; no assertion was weakened.

**Test results at `042ebba`:**

- format, lint, typecheck, i18n, migrations-check and build all PASS;
- Vitest: 4924 passed, 55 skipped (the env-gated PostgreSQL/Redis suites), 0 failed;
- Playwright: NOT RUN (it needs a deployed environment).

**Reviews:** five independent reviews; see `syveka-test-evidence.md` §6. The final code commit
`042ebba` was re-reviewed and no blocking issues remain.

**Draft PR:** see the PR linked from this branch.

## F. Security and reliability

**No P0 or P1 was found** in the launch modules.

- **Tenant isolation:**
  - app layer: `tenantDb` plus explicit foreign-key tenancy checks on every write path
    reviewed;
  - database layer: the RLS suites (superuser and non-superuser).
- **Public endpoints:** rate-limited and fail closed. Webhooks and job routes verify their
  signatures.
- **Dependencies:** production has 0 critical/high. The 3 critical and 5 high are dev-only;
  the critical `next` is a dev-only copy inside `react-email`, while production `next` is
  15.5.28.

**Unresolved risks:**

- backups and restore are unproven (B2);
- no monitoring or alerting (B3);
- an AI booking and a guest booking can race for the same slot (B9);
- AI quota overshoot and unmetered aborted turns (B11);
- a VIEWER can spend AI quota (B12);
- the dunning clock restarts (B17);
- placeholder legal texts and no GDPR tooling (B14, B15).

## G. First commercial product

**Include:**

- onboarding, organizations and roles
- Business DNA (form and chat-confirm)
- CRM
- booking and calendar (public booking, manage link, reminders)
- AI assistant (typed)
- knowledge base
- audit log
- FI/EN/AR

**Exclude:**

- paid billing
- voice
- inbox/email
- workflows
- Creator Studio and social publishing
- external calendar sync
- API keys

Reasons and pilot limits are in `syveka-first-commercial-release.md`.

## H. Owner actions

These need a human with credentials or authority:

1. Review this draft PR and authorize its merge. Separately, authorize a staging release with
   full validation (E2E).
2. Choose the pilot environment and deploy to it (a separate authorization).
3. Confirm Supabase backup/PITR retention, and run one restore drill on a non-production copy
   (`recovery-drill-checklist.md`).
4. Configure an uptime monitor on `/api/health` (alert on failure and on build-SHA drift), and
   confirm Sentry receives a test event.
5. Confirm the pilot environment's Stripe keys are test-mode or absent (read-only check of the
   prefix).
6. Verify the superadmin account; grant and revoke on the test org.
7. List the QStash schedules (`usage-rollup`, reminders, reconciliation).
8. Run the manual acceptance checklist (`syveka-first-customer-acceptance.md` §B), including
   Business DNA chat-confirm on a phone in FI, EN and AR.
9. Make product decisions on:
   - contacts created by public bookings beyond the limit (B10);
   - the VIEWER meeting-summary permission (B12);
   - the AI-versus-guest booking lock (B9).
10. A pilot agreement covering data processing, plus final legal texts from counsel (B14).
11. Review and decide #394 (billing) before any paid plan.
12. Read cost measurements after 2–4 weeks of pilot usage
    (`syveka-commercial-cost-assumptions.md` §3).

**Claude can finish independently, in follow-up PRs:**

- the booking Playwright journey (B5)
- booking P3s (B13)
- the AI quota reservation and partial-usage recording (B11)
- the members write limiter (B12)
- KB storage residuals (B20)
- GDPR export and deletion, given schema approval (B15)
- `pastDueSince`, given migration approval (B17)

## I. Launch timeline (estimate)

**Assumptions:**

- the owner is available to act on §H;
- no new blocking defect appears on staging;
- engineering effort is single-person.

| Step                                                                                  | Estimate                                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Owner checks H1–H8                                                                    | About 2–4 working days of owner time; the restore drill and monitoring are the long poles |
| Booking E2E plus booking P3s (Claude), in parallel                                    | About 1–2 days                                                                            |
| First pilot customer onboarded                                                        | Once §1 gates are PASS; no date is claimed                                                |
| Paid-launch work (#394, test Checkout, dunning, GDPR tooling, legal texts, cost data) | Weeks, not days; it depends on counsel and on pilot cost measurements                     |

## J. Final go/no-go

**CONDITIONAL GO FOR A CONTROLLED FREE PILOT AFTER SPECIFIC CHECKS.**

**Why not NO-GO:**

- The pilot package is complete in code, with automated coverage.
- Tenant isolation is verified at both the app and DB layers.
- No P0 or P1 is open.
- The defects this review found in booking and KB were fixed and independently re-reviewed.

**Why not GO:** of the 15 pilot gates, 4 PASS, 3 PARTIAL, 4 UNKNOWN and 4 BLOCKED. Except for
the booking E2E, every remaining gate is an owner action:

- deployment and verification of the fixed code;
- backups and a restore drill;
- monitoring;
- Stripe key mode;
- superadmin;
- an owner-observed acceptance run;
- a pilot data-processing agreement.

**Paid launch: NO-GO** until gates G-BILL, G-DUN, G-LEGAL, G-GDPR and G-COST pass.
