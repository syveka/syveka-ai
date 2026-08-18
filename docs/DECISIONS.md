# Syveka AI — Decisions

Permanent decision log. Entries here must not be reversed without explicit owner approval.
Add new entries at the bottom with a date; never delete a prior entry (mark superseded instead).

## Process / roles

- **2026 (ongoing)** — Syveka is the primary long-term startup effort for the owner.
- **2026 (ongoing)** — ChatGPT manages product strategy, architecture decisions, PRDs, and
  technical planning.
- **2026 (ongoing)** — Codex handles coding, debugging, refactoring, and implementation.
- **2026 (ongoing)** — Claude is used only where it provides exceptional value (deep audits,
  cross-cutting documentation, large-context synthesis — this document set is an example).
- **2026 (ongoing)** — UX review and PRD come before major implementation.
- **2026 (ongoing)** — Database and AI-agent design come before feature coding.
- **2026 (ongoing)** — Core Syveka platform launch takes priority over secondary products
  (Marketing Suite, Website Builder, mobile app, Syveka Secure, Portfolio).
- **2026 (ongoing)** — Lowest reasonable monthly cost is a design principle; do not add a new
  paid service before checking whether an existing one already covers the need.
- **2026 (ongoing)** — English, Finnish, and Arabic support must remain consistent (enforced by
  `npm run i18n:check` in CI, currently at 488/488/488 key parity).
- **2026 (ongoing)** — Tenant isolation is mandatory.
- **2026 (ongoing)** — Production quality is required before launch.
- **2026 (ongoing)** — Completed items must not be removed from the roadmap without recording
  why.
- **2026 (ongoing)** — Previous architecture must not be restarted without evidence of a
  confirmed critical problem and explicit approval.

## Architecture decisions confirmed by repository evidence (this audit, 2026-07-23)

- **Tenant isolation is enforced at the application layer** via `tenantDb(orgId)` (a Prisma
  Client Extension auto-injecting `organizationId` for 32 allow-listed models) plus manual
  discipline at `unscopedPrisma` call sites, **not** by Postgres RLS — the app's Prisma
  connection uses a role that bypasses RLS. RLS remains fully enabled (43/43 tables) as a real
  backstop for the Supabase-native client surface (Storage, Realtime, PostgREST) only. **Do not
  change the database connection role to a non-bypassing role without an explicit architecture
  review** — RLS policies expect JWT claims the current connection doesn't carry, so switching
  roles would break functionality rather than freely add security. See `DATABASE-AUDIT.md` §6.
- **Anthropic Claude is the sole AI generation provider.** OpenAI is used only for embeddings
  and moderation. A model-router/fallback abstraction exists in code but is unwired dead code —
  do not assume multi-provider failover works until it is explicitly finished and tested.
- **AI chat streaming is intentionally buffered** (full generation + output moderation before
  any client flush, then replayed in fixed-size chunks) — a deliberate safety trade, not a bug.
  Any change here must preserve the moderation-before-flush guarantee.
- **RLS/SQL and Prisma migrations are two systems that must stay manually synchronized.**
  Supabase Storage bucket provisioning (`prisma/sql/004_storage.sql`) has no tracked-migration
  equivalent — document this as a required manual step in any fresh-environment runbook rather
  than assuming `prisma migrate deploy` alone provisions a working environment.
- **Money is stored in integer cents; IDs are UUIDs; every sensitive mutation calls `audit()`.**
  Repo-wide convention, confirmed in force across all audited services.
- **RBAC is a fixed 5-role matrix** (OWNER/ADMIN/MANAGER/MEMBER/VIEWER), defined once and
  enforced via `requirePermission()`. **Superadmin is a separate axis** gated on
  `app_metadata.is_superadmin`, not a role value — do not conflate the two systems in future
  design.
- **Corrective migrations are shipped as separate, clearly-commented additive migrations**, not
  folded into the migration they fix (established by
  `20260715230000_security_invariant_corrections`). Continue this convention.
- **Each major feature ships with a companion doc in `docs/`** describing architecture, RBAC,
  and known limitations at ship time (`ai-chat-production-hardening.md`,
  `calendar-booking-v1.md`, etc.). Continue this convention for future features.
- **Financial webhook idempotency must be a durable, database-backed state machine, not a
  Redis-only claim-before-confirm marker.** The Stripe webhook previously set its dedupe key
  before processing completed, so a transient failure after the claim permanently suppressed
  Stripe's own retry for that event. See `docs/stripe-webhook-reliability.md` for the
  RECEIVED/PROCESSING/COMPLETED/FAILED ledger (`stripe_webhook_events`) that replaced it —
  completion is recorded only inside the same transaction as the business mutation it depends
  on. Apply the same pattern (not necessarily the same table) to any future inbound webhook
  whose retries must never be silently dropped.
- **`tenantDb(orgId)` must override `organizationId` in every write payload it touches, not just
  `where`.** A 2026-08-17 audit found `update`/`upsert`/`updateMany` injected `organizationId`
  into `where` but left the `data`/`create`/`update` payload unguarded — unlike `create()`, which
  already spread-then-overrode it. No live call site was exploitable (all confirmed either
  `unscopedPrisma` with a server-derived `organizationId`, or built from named fields), but the
  asymmetry was a standing trap for a future caller. Fixed defensively in
  `security/p1-tenantdb-upsert-payload-injection`; see `docs/SECURITY-AUDIT.md`'s 2026-08-17
  addendum. Any future operation added to `tenantDb()`'s interceptor that carries a write payload
  must override `organizationId` in that payload, not only in `where`.
- **A "re-check inside `$transaction`" is not, by itself, concurrency-safe under Postgres's
  default READ COMMITTED isolation.** A 2026-08-17 audit found `createPublicBooking`/
  `rescheduleBookingViaToken` (`src/server/services/booking.ts`) documented as having
  "transactional double-booking protection," but the re-check was a plain `SELECT` with no lock —
  two concurrent transactions each see the other's write as absent until commit, so both can pass
  the check and both insert, producing two bookings for one slot. Proven against a real Postgres
  instance (not just a mocked unit test) via `tests/integration/booking-concurrency.sh`. Fixed by
  taking a transaction-scoped `pg_advisory_xact_lock` keyed on `(organizationId, ownerId)` before
  the check, so the second transaction blocks until the first commits/rolls back instead of
  racing it — see `lockOwnerCalendar()`'s comment (`src/server/calendar/locks.ts`). **Apply the same scrutiny to any
  future check-then-write inside a `$transaction`**: only a `SELECT ... FOR UPDATE`, an advisory
  lock, a unique/exclusion constraint, or `SERIALIZABLE` isolation with retry actually closes this
  class of race — re-running the same query inside the transaction does not.
- **`deepmerge-ts` is pinned to `8.0.1` via `package.json`'s `overrides`** (same mechanism already
  used for `next`'s `postcss`/`sharp` and `nanoid`). `@prisma/config` — a transitive dependency of
  the `prisma` CLI, itself pulled into the production `npm audit --omit=dev` closure because
  `@prisma/client` declares `"prisma": "*"` as a peer dependency — pins `deepmerge-ts` to an exact
  `7.1.5`, vulnerable to [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
  (stack exhaustion merging recursive object graphs). As of this fix, every published `prisma`
  version from `6.13.0-dev.1` through the current `latest` (`7.9.1`) still depends on the same
  vulnerable pin — there is no available Prisma release that resolves this yet, so an override was
  the only viable fix. `deepmerge-ts` has zero dependencies of its own; `@prisma/config` only
  imports its basic `deepmerge` function (not `deepmergeInto` or the advanced type/metadata APIs
  `8.0.0`'s changelog documents as breaking), and `@prisma/config` is tooling-only (used by CLI
  commands like `prisma generate`/`validate`/`migrate`, never by `@prisma/client`'s runtime query
  execution) — bounding the blast radius of a mismatch to Prisma tooling, not the deployed app.
  Verified via the full local suite (tests, typecheck, lint, format, i18n, build, `prisma
validate`/`generate`, migration history check) after the override, all passing. **Revisit this
  override once Prisma ships a release with a patched `@prisma/config`** — remove it rather than
  leaving it to drift once the upstream fix lands.
- **The AI `bookMeeting`/`getCalendarAvailability` tools (`src/server/ai/tools/index.ts`)
  intentionally treat "the company calendar" as one shared, organization-wide bookable resource,
  not per-staff-member scheduling** — confirmed by both tools' conflict/busy queries having no
  owner filter, `CalendarEvent.ownerId` being left `null` on AI-created events, and the tool's own
  description ("Book a meeting into the company calendar"). A 2026-08-17 review found `bookMeeting`
  had no concurrency protection at all (not even a bare `$transaction` re-check) — two concurrent
  tool executions for the same slot could both create a conflicting event. Fixed with
  `lockOrgCalendar()` (`src/server/calendar/locks.ts`), an organization-scoped
  `pg_advisory_xact_lock` — **not** the owner-scoped `lockOwnerCalendar()` used by the guest
  booking flow, because a per-owner lock would not serialize between two different users'
  concurrent `bookMeeting` calls, which is exactly the scope this tool's own conflict check
  evaluates. **Known, deliberately deferred limitation:** `lockOrgCalendar()` and
  `lockOwnerCalendar()` intentionally do not serialize against each other, so a concurrent AI-tool
  booking and guest-flow booking for the same underlying time slot are not currently reconciled —
  closing that gap requires unifying both paths under one lock domain, a larger change than this
  fix's scope.
- **A model-supplied tool argument referencing another record (e.g. `bookMeeting`'s optional
  `contactId`) must be tenancy-checked before use if the referenced column has no DB-level foreign
  key.** Found during the same review: `CalendarEvent.contactId` has no `@relation` in
  `prisma/schema.prisma`, so nothing at the database layer would have caught a cross-tenant or
  nonexistent id — `bookMeeting` now verifies it the same way `logActivity` already did
  (`tx.contact.findFirstOrThrow({ where: { id, organizationId } })`) before attaching it.
- **Workflow triggers now enforce at-most-one-accepted-run-per-source-event, not "exactly-once
  side effects."** A 2026-08-18 review found `emitWorkflowEvent()`
  (`src/server/services/workflow-events.ts`) enqueued `run-workflow` jobs with no event identity
  at all — a redelivered/retried/duplicated trigger (QStash's own 3x retry-on-failure included)
  unconditionally created a second `WorkflowRun` and re-ran every step, repeating side effects
  (email, CRM activity, notifications, AI usage). `enqueue()` already supported a
  `deduplicationId` option (used by `voice/webhook`'s post-call job and `calendar-sync`'s
  pagination continuation) but this call site never used it. Fixed with a persistent,
  tenant-scoped claim: `WorkflowRun.sourceEventKey` (nullable, additive) is now
  `@@unique([organizationId, workflowId, sourceEventKey])`, and the `run-workflow` job route
  claims it with a create-first-catch-conflict pattern (unique constraint, not
  check-then-create) modeled directly on the Stripe webhook ledger
  (`src/app/api/v1/webhooks/stripe/route.ts`): SUCCEEDED/WAITING or non-stale RUNNING is a no-op
  duplicate; FAILED or RUNNING past `STALE_RUNNING_MS` (6 min, past this route's own 300s
  `maxDuration` so a still-RUNNING row past it cannot be legitimately in-progress) is reclaimed
  via a guarded `updateMany`, preserving QStash's existing retry-on-failure behavior instead of
  permanently poisoning a transiently-failed event. `emitWorkflowEvent()`'s `sourceEventId` param
  is required (not optional) precisely so a future call site can't silently skip this the way the
  original one did. Canonical identity per trigger: booking lifecycle events use the specific
  lifecycle row's own id (a reschedule creates a fresh successor booking, so this is naturally
  distinct per occurrence); `call.completed` uses the `VoiceCall` row id; deal transitions
  (`deal.stage_changed`/`deal.won`) have no external event id, so the key is derived from the
  deal's own pre-mutation `updatedAt` plus the target stage — concurrent/duplicate calls for the
  _same_ transition read the same pre-update timestamp and collide, while a later, genuinely
  distinct transition always has a newer one. **Known, deliberately out-of-scope gap:** this
  closes trigger-level duplication (the same source event creating >1 accepted run), not
  step-level exactly-once — a worker crash mid-run after some steps already executed and before
  QStash's own redelivery still resumes the _same_ run rather than a fresh one, so already-run
  non-idempotent steps are not re-protected; that is a separate, larger workflow-engine change.
  `contact.created` and `schedule.cron` are defined trigger types in the workflow builder UI with
  no corresponding `emitWorkflowEvent()` call anywhere — pre-existing, unimplemented, unrelated
  to this fix.
- **Step-level replay safety: at most one durable completion of each workflow step identity per
  `WorkflowRun`, not universal exactly-once execution.** A 2026-08-18 review found the exact gap
  the previous entry flagged as deferred: a reclaimed FAILED or stale-RUNNING run (PR #84) always
  restarts its step loop from index 0 with `stepResults` reset to `[]`, so any step whose side
  effect already durably succeeded before a crash — an email already sent, an Activity already
  created, a billed AI generation — ran again on the retry. Reproduced against the pre-fix route:
  a two-step `crm.create_activity` workflow crashed after step 1 re-created its Activity on
  reclaim. Fixed with a new durable claim, `WorkflowStepExecution`
  (`@@unique([workflowRunId, stepId])`), keyed by the step's own stable `id` from the workflow
  definition JSON (already the identity `stepResults`/`ctx.vars` used, so no new instability
  introduced). `claimStep()`/`completeStep()`/`failStep()`
  (`src/app/api/v1/jobs/run-workflow/route.ts`) mirror PR #84's own create-first-catch-P2002 claim
  exactly, at step granularity: SUCCEEDED is skipped and its cached `output` reused (so a later
  step that consumes an earlier step's output, e.g. an `email.send` reading an `ai.generate`
  result, still works on replay); FAILED or CLAIMED past `STALE_STEP_CLAIM_MS` (reuses PR #84's
  6-minute `STALE_RUNNING_MS`) is reclaimed via a guarded `updateMany`; CLAIMED and not yet stale
  backs off (`{skipped: "step_in_progress"}`) instead of racing a possibly-still-alive worker —
  this is what actually closes the gap PR #84's run-level reclaim alone left open: a run whose
  `startedAt` is never bumped by each step's own checkpoint can be reclaimed as "stale" by a
  second worker while the first is still legitimately mid-step, and it is the _step_-level claim,
  not the run-level one, that prevents both from executing the same step. Guarantees are
  step-type-specific, not one blanket claim. A follow-up adversarial review the same day found
  that the claim/reclaim mechanism above, on its own, was **not** sufficient for the DB-local step
  types: `claimStep()`'s reclaim is purely time-based, and `completeStep()`/`failStep()` originally
  wrote by `stepExecutionId` alone with no check that the completing worker's claim was still
  current. Reproduced against real Postgres: a worker that claims a step, stalls past
  `STALE_STEP_CLAIM_MS` while still alive (not crashed), gets reclaimed by a second worker, then
  resumes and completes its own (superseded) attempt — this created a second, genuinely duplicate
  `Activity` row, because nothing rejected the first worker's belated write. Fixed by making
  `claimStep()`'s returned `startedAt` a fencing token: `completeStep()`/`failStep()`, and the
  crm.create_activity/notify.member transactions directly, now require an `updateMany` guarded on
  `{ id, startedAt }` to match before writing; a worker whose claim was reclaimed in the meantime
  has a stale `startedAt`, matches zero rows, and (for the DB-local, transactional steps) has its
  side-effect insert rolled back with it in the same transaction — see
  `tests/integration/run-workflow-step-fencing.mjs` for the real-Postgres proof of both the
  pre-fix double-Activity outcome and the post-fix single-Activity outcome.
  - `crm.create_activity`/`notify.member` (DB-local): the side effect and the step's SUCCEEDED
    marker commit in one `$transaction`, guarded by the fencing token above — genuinely
    exactly-once against both a plain crash-and-retry and a stale-but-still-alive worker's belated
    completion.
  - `email.send`: the claim's id is passed as Resend's own `Idempotency-Key`
    (`resend`@4.8.0's `CreateEmailRequestOptions`/`IdempotentRequest`, confirmed directly from the
    installed SDK's types) — a retry after an ambiguous outcome (Resend accepted the send but the
    response never arrived) reuses the same key, so Resend itself, not just our own records,
    dedupes the actual send. Retention window of Resend's own idempotency store was not
    independently verified beyond what the SDK types confirm exists.
  - `ai.generate`: the Anthropic SDK's own `idempotencyKey` request option is also passed (same
    stable key), and a SUCCEEDED claim's cached output is reused directly on replay without
    calling the provider again — bounds duplicate billing to the single case where the process
    dies between the provider call returning and `completeStep()` persisting it, which provider
    idempotency also covers when honored. For both `email.send` and `ai.generate`, the fencing
    token above guards `completeStep()`'s own ledger write, but the actual double-send/double-bill
    protection in the stale-worker scenario comes from a different property: a step's
    `stepExecutionId` (the idempotency key) never changes across a reclaim, only `startedAt` does
    — so a reclaimed worker and the stale worker it superseded still share the exact same provider
    idempotency key, and it is the provider's own dedup, not this fencing guard, that prevents two
    real sends/generations. The fencing guard's role for these two step types is narrower: it
    stops a belated `completeStep()` from overwriting a fresher ledger row, not from causing a
    duplicate external side effect (which the shared key already rules out).
  - `wait.duration`: also claimed — an already-SUCCEEDED claim (the WAITING persist + resume
    enqueue already happened) makes a later duplicate delivery stop immediately
    (`{skipped: "duplicate_wait_resume"}`) rather than fall through and run subsequent steps
    immediately, which would race the legitimately scheduled resume.
  - `condition`: intentionally unclaimed — pure/deterministic given `ctx`, no side effect, so
    replay is harmless.
    **Not claimed and not achievable here:** if a provider genuinely accepts a side effect but the
    response is lost before `completeStep()` runs, and that provider has no idempotency support (or
    the key's retention window has lapsed), the outcome is truly ambiguous — this is an inherent
    limit of distributed side effects, not something this fix papers over.

## Standing engineering conventions (from `README.md`, verified still enforced)

- Never import `@/server/db/prisma` outside `src/server/db` (ESLint-enforced) — business code
  uses `tenantDb(ctx.orgId)`. Note: this does **not** restrict the `unscopedPrisma` escape hatch
  — see the RLS/tenant-isolation decision above.
- Every Server Action / API handler starts with `requirePermission("...")`.
- RTL: logical Tailwind utilities only (`ms-* me-* ps-* pe-* text-start`).
- Zod schemas in `src/lib/validators` are shared by forms and server actions.

## Open decisions requiring owner input (not yet resolved — see `NEXT-STEPS.md`)

- Whether to remove or finish `zustand` and `@tanstack/react-query` (currently installed, both
  unused beyond scaffolding).
- Whether to finish the OpenAI generation-failover path (`fallbackModel()`) or remove the
  aspirational comments/dead code referencing it.
- Whether to accept `next-intl`'s breaking 3.x→4.x upgrade now (required to clear a moderate
  CVE) or pin/patch around it short-term.
- Whether Sentry/Langfuse should actually be integrated (env vars exist, no SDK wired) or the
  optional vars should be removed until there's a concrete plan.
