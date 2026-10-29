# SYVEKA overnight hardening report (2026-10-29 → 2026-10-30)

Continuation of the release-readiness sprint on PR #376
(`claude/syveka-release-readiness-69qo1r` → `main`). Repository-only work in a cloud session:
no deployment, no staging or production workflow, no migration applied, no Supabase, Vercel,
QStash, Stripe, Resend or Vapi change, no secret read or written, no merge. Every claim names
the file, command or test it comes from.

## Executive verdict

- **P0:** none found. **P1:** two, both job reliability (not security), both fixed in this
  branch: a platform-killed workflow run was never recovered; a Creator Studio post could be
  stranded in PUBLISHING forever (and an Instagram publish did not fit its 60 s budget).
- **PR #376 is materially safer and more reliable**: 15 commits added overnight, 61 files
  changed on the branch in all, with regression tests for every fix.
- **Recommendation from a CODE perspective: CODE REVIEW READY.** Deployment authorization is a
  separate decision (CLAUDE.md §2 step 14) and is not implied by this report.

## Ground truth

| Item                    | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Branch                  | `claude/syveka-release-readiness-69qo1r`                                                                 |
| Starting SHA (verified) | `2c4184647c203a7db9df9c525929bb7a37afb545` (local, origin and PR head agreed; tree clean)                |
| Ending SHA              | `cd949f3` (last code commit; this report is committed on top of it)                                      |
| `main` observed         | `d5d492c49236e92a48c4567a89f69b20991fd198` (unchanged all night)                                         |
| PR #376 at start        | open, 9 commits, no reviews or review comments, one Vercel bot comment                                   |
| Commits added overnight | 15 (24 on the branch in all); overnight diff 43 files, +1595 / −180; whole branch 61 files, +2531 / −218 |

## Findings

Severity: P0 catastrophic · P1 serious · P2 important · P3 hardening. "Action" names the commit
when fixed here.

| Severity | Area           | Finding                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                   | Action                                                                 |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P1       | Workflows      | A run killed by the platform was never recovered: the retry of that delivery found the run RUNNING inside the 6-min stale window and got 200, which ended the message's retries before the reclaim                                                                                                           | `jobs/run-workflow/route.ts` duplicate-trigger branch (200 for in-flight RUNNING); `STALE_RUNNING_MS`                      | Fixed `412e25e` (409 while in flight)                                  |
| P1       | Creator Studio | A publish run killed mid-provider-call left the post in PUBLISHING forever (claim accepts SCHEDULED/FAILED only, retry answered 200, no cancel/reschedule, no notice); route budget 60 s < Instagram's 120 s poll; no Graph fetch timeout                                                                    | `creator-publishing.ts` claim; `publish-creator-post/route.ts` `maxDuration`; `meta/client.ts` `CONTAINER_POLL_TIMEOUT_MS` | Fixed `87d7a85` (sweep, 409, 300 s, 30 s fetch)                        |
| P2       | Workflows      | Raw exception text (provider, Prisma) stored on the run, pushed into the creator's notification and the 500 body                                                                                                                                                                                             | `run-workflow/route.ts` `err.message.slice(0, 500)`                                                                        | Fixed `412e25e`                                                        |
| P2       | Workflows      | Creator notified on every failed attempt (up to 4 per run); same for publishing                                                                                                                                                                                                                              | notification writes before the 500                                                                                         | Fixed `412e25e`, `87d7a85` (final attempt only)                        |
| P2       | Workflows      | `wait.duration`: an enqueue failure left the step CLAIMED, so the reclaiming retry found it "in progress" forever                                                                                                                                                                                            | enqueue outside any try in the wait step                                                                                   | Fixed `412e25e`                                                        |
| P2       | Jobs           | Five job routes `JSON.parse`d the verified body unguarded: a malformed message cost 3 retries and a DLQ entry                                                                                                                                                                                                | `embed-document`, `post-call`, `send-reminder`, `run-workflow`, `publish-creator-post`                                     | Fixed `9f592c4` (`jobPayloadJson`, static test)                        |
| P2       | Jobs           | A QStash failure left a Reminder row SCHEDULED with no job (dedupe key then blocked every retry) and a post "Scheduled" with no job                                                                                                                                                                          | `reminders.ts` single catch; `creator-posts.ts` SCHEDULED before enqueue                                                   | Fixed `66fe446`                                                        |
| P2       | Jobs           | `usage-rollup` unpaginated: at scale killed at `maxDuration`, tail never warned, schedule retry restarts from the first org                                                                                                                                                                                  | `usage-rollup/route.ts` org loop                                                                                           | Fixed `27375df` (cursor pages, purge on page 1)                        |
| P2       | AI             | Anthropic client had the SDK's 10-min default timeout, longer than every caller's budget                                                                                                                                                                                                                     | `integrations/anthropic.ts`                                                                                                | Fixed `c6580fb` (60 s)                                                 |
| P2       | Billing        | Creator credit reservation ignored the read-only lockout: a locked org kept spending real provider cost                                                                                                                                                                                                      | `creator-credits.ts` `reserveCreatorCredits`                                                                               | Fixed `9516e18`                                                        |
| P2       | Billing        | PAST_DUE grace measured from `updatedAt`, which every dunning retry rewrites (both `invoice.payment_failed` and `customer.subscription.updated`)                                                                                                                                                             | `entitlements.ts`; webhook writes                                                                                          | **Needs schema change**: plan in `docs/billing-past-due-since-plan.md` |
| P2       | Billing        | A price outside `STRIPE_PRICE_*` mapped silently (new sub → FREE, existing keeps old plan)                                                                                                                                                                                                                   | `webhooks/stripe/route.ts` `planForPriceId` null path                                                                      | Alert added `f9b5f9b`; mapping unchanged                               |
| P2       | Voice/privacy  | Recording URL is a raw Vapi-hosted link rendered to every role incl. VIEWER; no retention path for transcripts/recordings; contact deletion leaves call PII                                                                                                                                                  | `voice/calls/[callId]/page.tsx`; `usage-rollup` purge scope; `VoiceCall` has no Contact FK                                 | **Needs product decision** (inventory below)                           |
| P3       | KB             | `GET /kb/documents/{id}` returned the full row (storage path, uploader); delete of unknown/other-org id was a 500; a deleted doc could be deleted again; create returned the full row                                                                                                                        | `kb/documents/[id]/route.ts`, `documents.ts`                                                                               | Fixed `0c6723a`, `6507987`                                             |
| P3       | Booking        | Reschedule validated the slot for the type's default duration but ended the booking after the withdrawn old length                                                                                                                                                                                           | `booking.ts` `rescheduleBookingViaToken`                                                                                   | Fixed `011f2af`                                                        |
| P3       | Creator Studio | `assetIds` stored unverified at create/update (publishing re-verified; no leak)                                                                                                                                                                                                                              | `creator-posts.ts`                                                                                                         | Fixed `636fa50`                                                        |
| P3       | Disclosure     | `createApiKeyAction` returned exception text; calendar connection/sync stored raw provider messages shown to managers; publishing logged whole error objects                                                                                                                                                 | `actions/api-keys.ts`; `calendar-sync.ts`, `calendar-connections.ts`; `creator-publishing.ts`, publish route               | Fixed `6507987`, `33b7a49`, `87d7a85`                                  |
| P3       | Tests          | Guard coverage test checked files, not handlers; could not see guards in local helpers; alternate export shapes could hide a handler                                                                                                                                                                         | `handler-guard-coverage.test.ts`                                                                                           | Strengthened `a43930f`                                                 |
| P3       | Billing        | `pause_collection` not read (org keeps limits while nothing is billed); `unpaid` treated as paying; `Subscription.seats` never read; `customer.deleted` leaves a dangling customer id (next plan change 500s); `WORKFLOW_RUNS`/`EMBEDDINGS` usage double-counts on a lost-200 retry (neither gates anything) | `webhooks/stripe/route.ts`, `entitlements.ts`, `plan-change.ts`                                                            | Documented; product/billing decisions                                  |
| P3       | RBAC           | Intent not pinned by tests or docs: MEMBER may delete any prompt; VIEWER sees recordings/transcripts; MEMBER may confirm likeness consent for a profile they don't own; member emails visible to all roles                                                                                                   | `permissions.ts`; `actions/prompts.ts`; `profiles/[id]/consent/route.ts`                                                   | Documented; product decisions                                          |
| P3       | Webhooks       | No body-size cap of our own on signed endpoints (platform limit applies); no IP limit on calendar/Vapi webhooks; Vapi tool-call replay possible after 24 h for a call with no row (bounded by write caps)                                                                                                    | `stripe`, `voice/webhook`, `calendar/[provider]` routes                                                                    | Documented                                                             |
| P3       | Rate limits    | Write limiter absent on inbox, prompts, workflows save/toggle, api-keys, settings, members role/remove, creator confirmations                                                                                                                                                                                | `src/actions/*.ts` vs. `rate-limit-write-actions.test.ts` drift guard                                                      | Not changed (see below)                                                |
| P3       | Tenant         | `tenantDb(ctx.orgId).organization.findFirst` on a non-allow-listed model in two pages (safe today; `where` is server-derived)                                                                                                                                                                                | `inbox/[threadId]/page.tsx`, `calendar/booking-types/page.tsx`                                                             | Documented                                                             |
| P3       | Deps           | Dev-only critical/high advisories (`vitest` 3.2.7 → 5.0.5, `react-email` 3.0.7 → 6.11.6 pins `next@15.1.2`); production audit clean at high                                                                                                                                                                  | `npm audit`                                                                                                                | Recommendation below                                                   |

## Fixes completed (15 commits)

| Commit    | Root cause → implementation                                                                                                                                                                                                                                                                                                                 | Regression tests                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `9f592c4` | Bare `JSON.parse` of the verified body → `jobPayloadJson()` returns `undefined`, which every payload schema refuses (400, no retry)                                                                                                                                                                                                         | `jobs-payload.test.ts` (helper + static check that every job route guards its parse), `jobs-organization-guard.test.ts` (+4 routes × 3 bodies) |
| `0c6723a` | Select-less `findFirst`/`findFirstOrThrow` → shared `DOCUMENT_VIEW_SELECT`, `getDocument`, `DocumentNotFoundError` → 404; no second delete                                                                                                                                                                                                  | `kb-document-route.test.ts` (new, 8)                                                                                                           |
| `011f2af` | Two durations in one reschedule → one `durationMinutes` for slot check and booking                                                                                                                                                                                                                                                          | `booking-service.test.ts` (+2)                                                                                                                 |
| `412e25e` | 200 for in-flight RUNNING / step CLAIMED → 409; `failureText()` with `WorkflowStepError` for code-authored messages; notify on final attempt (`Upstash-Retried` vs `JOB_MAX_RETRIES`) or refusal; `failStep` on resume-enqueue failure; structured `workflow_run_failed` log                                                                | `run-workflow-ai-quota.test.ts` (+3), `run-workflow-idempotency.test.ts` (3 rewritten/added), `run-workflow-step-idempotency.test.ts`          |
| `87d7a85` | No recovery for stale PUBLISHING → `failStalePublishingPosts()` in the reconcile job (FAILED + `publish_interrupted`, audit, one notice; never auto-republished because the provider offers no dedupe); `in_progress` → 409; route `maxDuration` 300; Graph fetch `AbortSignal.timeout(30 s)`; guard refusal → 200; notify on final attempt | `creator-publishing.test.ts` (+8), `reconcile-creator-generations-job.test.ts`, `jobs-organization-guard.test.ts`                              |
| `66fe446` | Enqueue failure swallowed as a dedupe hit → reminder row removed + logged; post → FAILED `schedule_failed` + rethrow                                                                                                                                                                                                                        | `calendar-event-reminders.test.ts` (+1), `creator-posts-workflow.test.ts` (+1)                                                                 |
| `27375df` | Unbounded org loop → cursor pages of 50, chained with `deduplicationId`, purge on first page, 400 on malformed body                                                                                                                                                                                                                         | `usage-rollup-job.test.ts` (new, 8)                                                                                                            |
| `c6580fb` | SDK default 10-min timeout → `timeout: 60_000` (headers only; streams unaffected)                                                                                                                                                                                                                                                           | `integration-client-env-isolation.test.ts`                                                                                                     |
| `636fa50` | Unverified `assetIds` → `assertAssetsInTenant` at create and update (`media_missing`)                                                                                                                                                                                                                                                       | `creator-posts-workflow.test.ts` (+2)                                                                                                          |
| `f9b5f9b` | Silent unknown price → `stripe_unknown_price` warn with org, subscription, price, status                                                                                                                                                                                                                                                    | `stripe-webhook.test.ts` (+2)                                                                                                                  |
| `6507987` | `e.message` to client → `EntitlementError` code / `failed` + name-only log; create-document answers in the view shape (`toDocumentView`)                                                                                                                                                                                                    | `api-keys-action-scopes.test.ts` (+2), `kb-document-route.test.ts` (+1)                                                                        |
| `a43930f` | File-level guard scan → per-handler scan with helper awareness; refuses hidden export shapes, non-route files under `src/app/api`, `"use server"` outside `src/actions`                                                                                                                                                                     | `handler-guard-coverage.test.ts` (95 checks)                                                                                                   |
| `33b7a49` | Raw provider messages stored on connection/sync state → `sanitizeErrorMessage(e, 300)`                                                                                                                                                                                                                                                      | existing calendar suites (no text assertions changed)                                                                                          |
| `9516e18` | Reservation ignored `readOnly` → `EntitlementError` before any balance write                                                                                                                                                                                                                                                                | `creator-credits.test.ts` (+1)                                                                                                                 |
| `3747eed` | Documentation only: `pastDueSince` plan                                                                                                                                                                                                                                                                                                     | —                                                                                                                                              |

Each fix was validated with its focused suite, Prettier, ESLint and `tsc` before its commit;
the whole-repository commands below ran on the final HEAD.

## Security review (overnight sweeps, each re-verified in code before any change)

- **Tenant isolation**: a second, entry-point-first red team (malicious MEMBER of org A with
  org B's ids, every relation id and nested write traced) found no cross-tenant read, write,
  delete, link or trigger path. Only `assetIds` (fixed) and a hygiene note on `tenantDb` over a
  non-allow-listed model.
- **RBAC**: no inconsistency against `permissions.ts`, the RBAC suites and docs; four
  intent-ambiguous placements listed above for decision.
- **Business DNA**: unchanged from the daytime verification (allowlist, settings-only fields,
  basis + advisory lock + `FOR UPDATE`, single-use digest-bound confirmation, audit); mutation
  check killed all three weakened guards. Nothing new found.
- **RAG / knowledge**: `match_chunks` and the `documentIds` path both filter org and require
  `deleted_at IS NULL`/`READY`; the deleted-mid-embed gap was closed in the daytime sprint;
  document GET/create/delete disclosure fixed tonight.
- **Jobs**: all 8 routes verify the QStash signature (with URL); org from the payload is joined
  to the resource; idempotency per job verified; the recovery and notification gaps above fixed.
- **Webhooks**: Stripe (durable ledger, ordering, ownership by customer id), calendar
  (per-subscription hashed secret, timing-safe), inbox (timing-safe shared secret, svix for
  Resend), Vapi (timing-safe HMAC, org via globally unique assistant id, tool caps before
  execution, Redis fail-closed) verified; residuals are P3 (no own body cap, no IP limit).
- **SSRF**: every listed vector (loopback, 0.0.0.0, metadata, RFC1918, link-local, IPv6
  local/mapped/6to4/Teredo, decimal/octal/hex IPv4, userinfo, trailing dot, `file:`/`gopher:`/
  `data:`, redirects re-pinned, 10 MB cap, 20 s timeout, content-type allowlist) is blocked in
  `url-ingestion.ts`; reachable only by MANAGER+ with 5/h/org. No bypass found; nothing changed.
- **Voice**: ownership, call binding, webhook integrity, tool scoping and log hygiene verified.
  Data inventory for the retention decision: `VoiceCall.callerNumber/transcript/summary/
sentiment/recordingUrl/actionsTaken`; written by `voice/webhook/route.ts` and `post-call`;
  read by the calls list/detail pages (`voice:view-calls`, down to VIEWER), analytics
  (sentiment only), post-call AI (transcript to Anthropic), workflow events (ids/duration/
  sentiment); deleted only by org erasure (cascade); never deleted at Vapi. Files to touch once
  a policy exists: `prisma/schema.prisma` (+migration), `usage-rollup/route.ts`,
  `services/contacts.ts`, `integrations/vapi.ts` (DELETE /call), `voice/calls/[callId]/page.tsx`
  - `services/voice.ts` (proxy/sign the recording), `supabase/functions/gdpr-erasure`.
- **Billing**: code-only deep review verified statuses, cache invalidation, checkout/portal
  authorization, credit ledger atomicity; findings above (two fixed, the rest decisions).

## Remaining P2/P3 by what they need

- **Product decision**: voice recording exposure and retention; `unpaid`/`pause_collection`
  semantics; per-seat billing enforcement; the four RBAC placements; inbox write limits
  (the void-returning inbox actions have no error channel for a limit, so adding one is a UX
  change, not a drop-in).
- **Schema migration (authorization)**: `Subscription.pastDueSince`
  (`docs/billing-past-due-since-plan.md`).
- **External configuration**: unchanged from `docs/release-readiness-2026-10-29.md` §7
  (QStash schedule, Sentry DSN, uptime monitor, Resend, Stripe, backups, CI image pin).
- **Repository follow-up**: IP limits on calendar/Vapi webhooks and a Microsoft batch cap;
  own body-size cap on signed endpoints; `customer.deleted` handling; `tenantDb` hygiene on the
  two pages; usage double-count on lost-200 retries (non-gating); dev dependency bumps.

## Tests

- `npm test` on the final HEAD: 306 files passed, 8 skipped (opt-in Postgres/Redis suites); 4350 tests passed, 49 skipped; 0 failed. Daytime baseline on `main` was 300 files / 4177 tests.
- Overnight additions: 4 new suites (`jobs-payload`, `kb-document-route`, `usage-rollup-job`,
  plus the rewritten guard coverage), about 45 new or rewritten cases across 14 suites.
- Not runnable here (unchanged): RLS/integration SQL suites and the opt-in Postgres/Redis
  suites (run in CI), Playwright (needs a deployed URL).

## Validation (final HEAD)

| Command                                   | Result                                   |
| ----------------------------------------- | ---------------------------------------- |
| `npm run lint`                            | PASS (0 errors, 2 pre-existing warnings) |
| `npm run format:check`                    | PASS                                     |
| `npm run typecheck`                       | PASS                                     |
| `npm test`                                | PASS (306 files, 4350 tests, 49 skipped) |
| `npm run i18n:check`                      | PASS (1152 keys)                         |
| `npm run migrations:check`                | PASS (8 published checksums)             |
| `npx prisma validate`                     | PASS                                     |
| `npm run build`                           | PASS (`SKIP_ENV_VALIDATION=1`, 68 s)     |
| `npm audit --omit=dev --audit-level=high` | PASS                                     |
| Secret pattern scan of tracked files      | Clean                                    |

## CI

Automatic CI on the push of this branch: see the final session message for the run id, head SHA and the "CI required" result (read only; not rerun). The previous head `2c41846` had all 19 checks green on run 40933474640.

## Dependencies (recommendation, nothing upgraded)

The critical/high advisories are dev-only: `vitest@3.2.7` (`@vitest/mocker` path traversal,
`tinypool` prototype pollution, `vite` launch-editor) and `react-email@3.0.7` (pins a nested
`next@15.1.2`, `glob`, `engine.io`). None of that code runs in production; exposure is a
developer running the test runner or the email preview server against hostile input. Path:
`vitest` 3 → 5 in its own PR (API-compatible for this suite's usage; `vi.mock`, `vi.hoisted`,
`vi.stubEnv` unchanged; expect a config touch), `react-email` 3 → 6 separately (it is only the
preview tool; `@react-email/components` stays). Not an overnight change: both are tooling
majors and `vitest` 5 pins its `vite` peer range.

## Human decisions required

1. Voice recordings and transcripts: retention window, and whether the raw Vapi URL may be shown
   (versus proxied/signed). Blocks phone voice, not the pilot.
2. Authorize the `pastDueSince` migration (`docs/billing-past-due-since-plan.md`).
3. Billing semantics: `unpaid` as non-paying; `pause_collection`; per-seat enforcement.
4. RBAC placements: prompt deletion (MEMBER), recordings/transcripts (VIEWER), likeness consent
   (MEMBER, any profile).

## PR #376 recommendation

**CODE REVIEW READY.** No P0; both P1s are fixed with tests; every validation command passes on
the final HEAD; the remaining items need decisions or a schema change, not more repository
work before review. Merge and deployment remain separate, explicit authorizations.

## Explicit safety confirmation

No merge. No deployment. No staging workflow dispatch. No production workflow dispatch. No
migration applied. No Supabase mutation. No Vercel configuration mutation (a route's own
`maxDuration` export changed in code; `vercel.json` untouched). No secret mutation or read. No
external-service mutation. Automatic CI and Vercel previews ran on the push, as they do for any
PR branch update; nothing about them was triggered, rerun or inspected beyond reading results.
