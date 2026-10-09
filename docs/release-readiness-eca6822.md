# Release readiness: candidate `eca6822` (as of 2026-10-10)

Evidence for promoting the current staging build to production. Nothing here
was deployed or changed in production. Every claim cites the run, file or
command it comes from; anything not exercised is marked **UNVERIFIED**.

|                        | SHA                                        | Evidence                                                                                                |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `main`                 | `eca68222f0efea31a85c1353f45f33ffb7478a57` | `git ls-remote origin refs/heads/main`                                                                  |
| Staging (stable alias) | `eca68222f0efea31a85c1353f45f33ffb7478a57` | `https://syveka-ai-staging.vercel.app/api/health` reports `build: eca68222…`, database `ok`, Redis `ok` |
| Production             | `fc645727cc8f0932f90c793667d8cfe3de0b35d3` | production `/api/health` reports `build: fc645727…`; last `deploy.yml` run #23 (2026-09-25)             |

## 1. Staging evidence for `eca6822`

[Staging release #133](https://github.com/syveka/syveka-ai/actions/runs/37998253161), success,
approved for `staging` only:

- Staging identity valid; read-only legacy preflight passed.
- Migrations: 31 found, none pending, schema up to date.
- RLS and tenant invariants: release invariants, RLS isolation, tenant-update hardening,
  calendar/booking and inbox/Business DNA assertions all passed; ephemeral fixtures confirmed
  removed. Storage invariants passed; the documents bucket is private.
- Preview healthy on attempt 1 with `build == eca6822`. Stable alias deployed from a
  credential-free build and proven to serve `eca6822`.
- E2E: Preview smoke 29 passed / 0 failed / 12 skipped; alias smoke 29 / 0 / 12; auth journeys
  3 / 0. No flaky or retried tests. Skips are by design (mobile copies of desktop-only mutating
  tests; opt-in Creator Studio live and paid specs).
- `main` CI for `eca6822` ([run 37990515461](https://github.com/syveka/syveka-ai/actions/runs/37990515461)):
  17/17 on attempt 3. Attempts 1–2 failed only at "Initialize containers" with Docker Hub
  `toomanyrequests` (unauthenticated pull of `pgvector/pgvector:pg15`); no repository code ran
  in the failed jobs. See §8.

## 2. #274 (Business DNA from chat) verification

| Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                                      | Evidence                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Settings save persists (fresh reload)                                                                                                                                                                                                                                                                                                                                                                                                                                         | **PASS, live staging**                      | `business-dna.spec.ts` "saving persists the change…" (desktop) in #133               |
| Stale form refused, typed edits kept                                                                                                                                                                                                                                                                                                                                                                                                                                          | **PASS, live staging**                      | "a form loaded before another save can't overwrite it…" in #133                      |
| Business DNA page loads (desktop + Pixel 7)                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PASS, live staging**                      | "page loads without a client-side exception"                                         |
| Proposal card renders (heading, card, Before/After, Confirm/Cancel, no wrench icon)                                                                                                                                                                                                                                                                                                                                                                                           | **PASS, owner manual QA on the PR Preview** | Owner QA, 2026-10-09; nothing confirmed                                              |
| No write before Confirm; Cancel writes nothing; single use; replay; expired/unknown/malformed action ids; other org/user/conversation refused (404 for another org); role re-checked at execution; settings-only fields refused (incl. legacy stored actions); per-day opening-hours merge; unrelated fields kept; stale detection (incl. profile created elsewhere); audit attribution; voice never offered the tool; setup prompt only in typed chat and only with the tool | **PASS, automated**                         | 294 passed / 6 skipped across 20 suites at `eca6822`; 15/15 guard mutations killed   |
| FI/EN/AR keys and plural forms; `dir="auto"` and `<bdi>`                                                                                                                                                                                                                                                                                                                                                                                                                      | **PASS, automated**                         | All 35 dynamic keys present in every locale                                          |
| Live chat Confirm and Cancel on staging; Arabic and mobile **visual** layout of the card                                                                                                                                                                                                                                                                                                                                                                                      | **UNVERIFIED**                              | Needs a signed-in browser; see the checklist below                                   |
| Action-store Lua scripts against real Redis                                                                                                                                                                                                                                                                                                                                                                                                                                   | **UNVERIFIED**                              | `ai-tool-actions-redis.test.ts` is opt-in (`VOICE_REDIS_TEST_URL`) and skipped in CI |

### Manual QA checklist (owner, staging alias, a test organization's OWNER)

1. Typed chat: "We are a car repair shop in Helsinki, open Mon–Fri 8–17." Expect one
   "Update Business DNA" card listing each change with Before/After. **Cancel**. Reload the
   Business DNA settings page: nothing changed.
2. Repeat, **Confirm**. The card shows done with a "Review Business DNA" link; the settings page
   shows exactly the confirmed fields; other days' hours and unrelated fields are unchanged.
3. Open the settings form in a second tab, then confirm another chat change; saving the stale
   tab shows the localized conflict message and keeps the typed text.
4. Ask chat to change the response instructions: it must refuse and point to settings.
5. Switch to Arabic: the card reads right-to-left, values keep their own direction, times read
   left-to-right.
6. On a phone (or 375 px wide): the card wraps without horizontal scrolling; Confirm and Cancel
   are reachable.
7. As a MEMBER or VIEWER of the same org: chat never proposes a Business DNA change, and the
   settings form is read-only.

## 3. Production delta (`fc64572` → `eca6822`)

65 merged PRs, 135 commits, 327 files (+45,664 / −1,774). By area:

| Area              | Changes                                                                                                                                                                                                                                     | Risk                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Auth/security     | Removed members lose calendar access and booking links (R1); jobs skip missing/soft-deleted orgs (R2); workflow recipients rechecked; OAuth callbacks require the starting user's session (#264); anonymous callers can't search CRM (#255) | Medium (behavior tightens)                       |
| Tenant/RBAC       | Client-supplied Creator Studio ids resolved within the org (#263); seat limit at invitation acceptance (#241)                                                                                                                               | Medium                                           |
| Business DNA      | Chat proposals with confirmation; version-checked saves; **`PUT /api/v1/business-dna` now requires `expectedUpdatedAt`** (#274)                                                                                                             | Medium (API contract)                            |
| Chat              | Server-enforced confirmation for write tools; restored outcomes; voice input, spoken replies, live voice (env-gated, off by default)                                                                                                        | Medium                                           |
| CRM               | Booking meetings in a contact's Meetings (#249); localized pipeline stages                                                                                                                                                                  | Low                                              |
| Booking/Calendar  | Editor times in the event's timezone (#246); booked events and bookings kept in sync (#268); manage links valid until the meeting ends (#248); visible, retryable confirmation-email failures (#247); widget hydration fix (#245)           | Medium                                           |
| Voice             | Phone booking only in offered slots (#272); full call results; sentiment in workflow events; no CRM search for anonymous callers                                                                                                            | Medium                                           |
| Creator Studio    | Fail closed without a real media provider (#234); no double or early publishing (#259); credits never released unreserved (#257); generation rate limits (#271); secure image previews                                                      | Medium                                           |
| Billing           | Single plan catalog (#236); pooled org AI allowance (#237); AI features outside chat quota-checked (#266); workflows plan + per-org test-run limit (#256)                                                                                   | **High** (entitlements change for existing orgs) |
| Infrastructure/CI | Health checks shared for 10 s (#269); agent guardrail hooks; dependency security bumps (#242, #244)                                                                                                                                         | Low                                              |
| Localization      | Onboarding localized; ICU brace escaping (#260); Arabic usage ratios                                                                                                                                                                        | Low                                              |
| Observability     | DSN-gated Sentry with scrubbing; explicit Sentry environment (#243); sanitized Prisma connection diagnostic                                                                                                                                 | Low                                              |

**Database/schema:** none. `git diff fc64572 eca6822 -- prisma` is empty; both have the same 31
migrations. No backfill, no lock-heavy operation, nothing rollback-sensitive in the database.

**Environment:** all new variables are optional and default off: `AI_TRANSCRIPTION_*`,
`AI_VOICE_CONVERSATION_*` (enabled only by `"1"`), `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`,
`NEXT_PUBLIC_SENTRY_ENVIRONMENT`. Production needs no new variable to run this release.

**Rollback-sensitive:** only application behavior: the billing catalog and pooled allowance (#236/#237)
change what existing orgs may do, and the Business DNA `PUT` contract (#274). With no schema
change, `vercel rollback` to the recorded previous deployment fully restores the previous behavior.

## 4. Production configuration gap matrix

Values were never read. "Present" means verified by a named check; runtime variables live in
Vercel and were not accessible to this review.

| Requirement                                                                | Staging                                              | Production                                                     | Evidence                                           | Blocker?                                                                      | Owner action                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL` on the transaction pooler (6543)                            | Present, port 6543, staging project                  | **UNVERIFIED**                                                 | Staging: read-only env audit 2026-09-24            | No                                                                            | Confirm in Vercel production env (name, host shape and port only)                          |
| Supabase custom access token hook                                          | —                                                    | **Not registered** (owner, 2026-10-06)                         | Memory/owner dashboard check                       | No (app path uses `last_active_org` + membership; JWT-claim RLS fails closed) | Decide whether to register; it changes JWT claims                                          |
| RLS and storage invariants                                                 | Pass (#133)                                          | Pass at last release (deploy #23)                              | `release-invariants.sql`, `storage-invariants.sql` | No                                                                            | — (re-run by `deploy.yml`)                                                                 |
| QStash schedule: usage-rollup (retention purge, quota notices)             | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | `docs/release-runbook.md` (#270)                   | **Yes for GDPR retention**                                                    | QStash console → Schedules: `/api/v1/jobs/usage-rollup`, `0 2 * * *`, last delivery < 24 h |
| QStash schedule: calendar-sync                                             | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | release runbook                                    | Only if calendar sync is in the pilot                                         | Same check                                                                                 |
| QStash schedule: reconcile-creator-generations                             | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | release runbook                                    | Only if Creator Studio generation is in the pilot                             | Same check                                                                                 |
| Sentry DSN                                                                 | **UNVERIFIED**                                       | **UNVERIFIED** (not a GitHub variable)                         | `src/instrumentation.ts` is DSN-gated              | No, but see §7                                                                | Set `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` and environment label                            |
| Vapi (`VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_WEBHOOK_CREDENTIAL_ID`) | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | `docs/PROVIDER-ACTIVATION-CHECKLIST.md`            | Only for phone voice (after voice safety)                                     | Custom HMAC credential + one real call reaching `COMPLETED`                                |
| Resend                                                                     | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | provider checklist                                 | Yes for booking confirmations                                                 | Domain verified, `RESEND_API_KEY` present                                                  |
| FAL                                                                        | Present (staging workflow checks the name)           | **UNVERIFIED**                                                 | `staging-release.yml` Creator Studio check         | Creator Studio generation fails closed without it (#234)                      | Decide whether generation is in the pilot                                                  |
| Meta                                                                       | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | `src/server/social/index.ts`                       | No (publishing out of first pilot; fails closed in production without it)     | Keep unset for the pilot                                                                   |
| Stripe prices and webhook secret                                           | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | `src/env.ts`, plan catalog (#236)                  | Yes if billing is live                                                        | Check price ids match the catalog; webhook endpoint enabled                                |
| GitHub `production` environment                                            | —                                                    | Required reviewer `syveka`, branch policy, admins can't bypass | GitHub API                                         | No                                                                            | —                                                                                          |
| Vercel environment mapping                                                 | Staging project, Preview + Production scopes audited | Separate project; candidate deployed staged, then promoted     | `deploy.yml`                                       | No                                                                            | —                                                                                          |
| OAuth callback URLs (Google/Microsoft calendar, Meta)                      | **UNVERIFIED**                                       | **UNVERIFIED**                                                 | callback routes                                    | Only for calendar connect                                                     | Provider consoles list the production domain                                               |

## 5. Billing findings (read-only)

| Finding                                                                                                                                                                                                                                                                                       | Type                                                                                                                                                                                | Severity |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| The 14-day read-only grace for `PAST_DUE` is measured from `subscription.updatedAt` (`entitlements.ts`). Every `invoice.payment_failed` writes `status: "PAST_DUE"` again, which bumps `updatedAt`, so each Stripe retry restarts the grace. Lockout lands ~14 days after the **last** retry. | **CODE FIX** (store a past-due-since timestamp, or only write when the status changes). Overlaps the Stripe webhook route that open billing PRs touch; coordinate with their owner. | P2       |
| No dunning email sequence exists; the "day 0/3/7" comment in the webhook route refers to nothing.                                                                                                                                                                                             | **OWNER STRIPE CONFIGURATION** (Stripe's failed-payment emails, Smart Retries schedule, and final action after retries)                                                             | P2       |
| `unpaid` maps to `PAST_DUE`; the final retry outcome (cancel vs. mark unpaid) is a Stripe setting.                                                                                                                                                                                            | **COMMERCIAL DECISION** + Stripe configuration                                                                                                                                      | P3       |
| Signature verification, durable idempotency ledger, out-of-order protection (retrieve current state before applying)                                                                                                                                                                          | In place                                                                                                                                                                            | —        |

## 6. Observability (what production can answer today)

| Question                            | Today                                                        | Gap                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Is Syveka up? DB/Redis healthy?     | `/api/health` (DB + Redis, 10 s shared check, reports build) | **No external uptime alerting** is configured in the repository (P2, owner: add a monitor on `/api/health`)              |
| Unhandled server errors             | Sentry via `instrumentation.ts` when a DSN is set            | DSN presence unverified (P2)                                                                                             |
| Background jobs failing             | QStash retries 3×, then its dead-letter queue                | 6 of 8 job routes log nothing on failure; the DLQ is visible only in the QStash console. **No alert on DLQ growth** (P2) |
| Retention purge running             | Nothing records a run                                        | Schedule unverified (see §4)                                                                                             |
| Booking confirmation email failures | Visible and retryable (#247)                                 | —                                                                                                                        |
| AI cost                             | Per-request cost estimate in chat usage                      | No anomaly alert (P3)                                                                                                    |

## 7. Release and rollback runbook (not executed)

`deploy.yml` at `eca6822` already implements the deployment mechanics; this is the operator
sequence around it. See `docs/release-runbook.md` for the backup gate.

**Pre-flight (all must hold):**

1. Candidate is `main` HEAD; main-push CI succeeded on it; a staging release succeeded on it
   (the release chain verifier refuses otherwise).
2. Backup gate satisfied and recorded: Option A (PITR) or Option B with every record and the
   owner's written risk acceptance (`docs/release-runbook.md`). Option B's "no database change"
   condition holds for `eca6822` (no `prisma/` diff from production).
3. Operator preflight: `006_legacy_baseline_preflight.sql` passes; `npx prisma migrate status`
   reports up to date.
4. §4 items marked as blockers for the chosen pilot scope are resolved.
5. Rollback owner named and available.

**Deploy:** dispatch `deploy.yml` with the candidate SHA twice; approve `production`. The workflow
reruns the preflight, applies migrations (none pending), verifies invariants, builds without
credentials, records the current production deployment as the rollback target, deploys staged,
verifies the staged deployment serves the SHA, promotes, then proves both domains serve it.

**Post-deploy smoke (owner, within 30 minutes):** sign in; dashboard; open a contact; open
Calendar and a public booking page (no booking); typed chat reply; Business DNA page; billing
page shows the expected plan and limits for a known org.

**Rollback:** application-only. `vercel rollback <recorded previous deployment> --timeout 5m --yes`
(printed by the workflow). No database rollback is needed for this release.

**Abort (stop, do not promote, or roll back if promoted):**

- the release-chain verifier or the checkout-SHA check fails;
- `migrate status` reports anything pending or failed;
- any invariant check fails;
- the staged deployment is not healthy or reports another build;
- after promotion, `/api/health` is not 200 with the candidate build within 5 minutes;
- sign-in fails, any page shows another organization's data, or existing paying orgs lose
  access they should have (billing catalog change).

## 8. CI: Docker Hub rate limiting

Four CI jobs pull `pgvector/pgvector:pg15` from Docker Hub unauthenticated and unpinned. On
2026-10-09 (~20:55–21:45 UTC) this failed every run's database jobs; the last 40 runs are green.
Recommended (owner-reviewed workflow change): pin the image by digest, and either add read-only
Docker Hub credentials to the four service containers or mirror the image to `ghcr.io/syveka`.

## 9. Recommended Limited Pilot package

**In** (verified on staging): CRM, Calendar, public Booking, AI Chat (typed), Business DNA.
**In, scoped:** Creator Studio safe paths (per-org flag `creator_studio_v1`; generation needs
FAL, which fails closed without it). **After voice safety:** phone Voice.
**Out:** inbound email (leave `INBOX_EMAIL_WEBHOOK_SECRET` unset), Instagram/Facebook publishing
(leave `META_APP_ID`/`META_APP_SECRET` unset; production refuses the mock), live voice
conversation and transcription (leave the env flags unset), autopilot (`creator_studio_autopilot` off).

Required before a pilot customer: §4 blockers for this scope (usage-rollup schedule, Resend,
Stripe if billing is live), an uptime monitor, Sentry DSN, and the §2 manual QA. Pilot limits:
a small number of named orgs, owner as support contact, rollback per §7.
