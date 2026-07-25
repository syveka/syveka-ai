# TenantDb Architecture Audit

Snapshot date: **2026-07-25**. Produced by tracing `tenantDb()` across the full dependency
graph (graphify: 1,797 nodes / 4,418 edges / 145 communities over 336 files), cross-checked
against `prisma/schema.prisma`, `eslint.config.mjs`, `docs/DATABASE-AUDIT.md`,
`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and `docs/ROADMAP.md`. This document is
analysis only — no application code, schema, dependencies, or migrations were changed to
produce it.

## Executive summary

`tenantDb(orgId)` (`src/server/db/tenant.ts:54-102`) is the single highest-centrality node in
the codebase graph (betweenness 0.154 — the top score of any node), ahead of
`requirePermission()` (0.097) and `audit()`. It is a Prisma Client Extension that
auto-injects `organizationId` into every query for a hardcoded 33-model allowlist
(`TENANT_MODELS`). Every tenant-facing feature — CRM, Calendar/Booking, AI Chat, Voice,
Workflows, Org/Settings — imports it directly, because it is not one option among several:
per `docs/DECISIONS.md:31-38`, tenant isolation is enforced at the **application layer** via
`tenantDb()`, not by Postgres RLS (the app's Prisma connection uses a role that bypasses
RLS). RLS stays fully enabled as a backstop for the Supabase-native client surface only.

That makes `tenantDb()` correctly central, not accidentally central — but it also means the
function and its escape hatch (`unscopedPrisma`, exported from the same file) are the entire
cross-tenant defense for 33 models, with no database-level backstop if application code gets
it wrong. This audit found one **new** structural risk (the `TENANT_MODELS` allowlist has no
automated test guarding it against silent drift), confirms two **already-documented and
already-tracked** risks (`getFreshTokens()` unscoped-by-construction; the
`DocumentUploadIntent`↔`Document` missing FK), and surfaces coupling/testing/performance
observations that are lower severity. No cross-tenant exploit path is known to exist today
in any of these; every item below is defense-in-depth or process hardening, not an active
breach.

## Exact modules and file paths depending on TenantDb

`tenantDb` is defined at `src/server/db/tenant.ts:54` and re-exports its escape hatch
(`unscopedPrisma`) at `src/server/db/tenant.ts:105`. 126 graph edges connect it to 24 code
files plus 4 docs, grouped by feature domain:

| Feature domain | Files (edge count) | Total edges |
|---|---|---|
| CRM (Deals/Companies/Contacts) | `src/server/services/deals.ts` (16), `src/server/services/companies.ts` (10), `src/server/services/contacts.ts` (9), `src/server/services/analytics.ts` (4) | 39 |
| Calendar & Booking | `src/server/services/calendar.ts` (11), `src/server/services/booking.ts` (6), `src/server/services/availability.ts` (5), `src/server/services/booking-assistant.ts` (5), `src/server/services/calendar-connections.ts` (5) | 32 |
| AI Chat / Knowledge Base | `src/server/services/conversations.ts` (5), `src/server/services/documents.ts` (4), `src/server/services/prompts.ts` (3) | 12 |
| Voice Assistant | `src/server/services/voice.ts` (5) | 5 |
| Org / Settings / Ops | `src/server/services/api-keys.ts` (4), `src/server/services/members.ts` (4), `src/server/services/notifications.ts` (4), `src/server/services/workflows.ts` (4), `src/server/services/dashboard.ts` (2) | 18 |
| AI Tools | `src/server/ai/tools/index.ts` (1) | 1 |
| Server-rendered pages | `src/app/[locale]/(app)/calendar/page.tsx`, `src/app/[locale]/(app)/calendar/booking-types/page.tsx`, `src/app/[locale]/(app)/settings/audit-log/page.tsx`, `src/app/[locale]/(app)/settings/members/page.tsx`, `src/app/[locale]/(app)/voice/[assistantId]/page.tsx`, `src/app/[locale]/(app)/voice/calls/[callId]/page.tsx`, `src/app/[locale]/(app)/workflows/[workflowId]/page.tsx` | 12 |
| Docs referencing the pattern | `docs/ARCHITECTURE.md`, `docs/DATABASE-AUDIT.md`, `docs/DECISIONS.md`, `README.md` | 4 |

In short: every multi-tenant feature in the product routes its Prisma access through this
one file.

### The escape hatch: `unscopedPrisma`

`unscopedPrisma` (same file, line 105) is imported in **58 files**, hundreds of call sites.
Most are legitimate cross-tenant infrastructure code — webhooks (`src/app/api/v1/webhooks/stripe/route.ts`,
`src/app/api/v1/voice/webhook/route.ts`), background jobs (`src/app/api/v1/jobs/*`),
superadmin pages (`src/app/[locale]/(superadmin)/admin/organizations/page.tsx`) — but it is
also imported **side-by-side with `tenantDb`** in the same module in these tenant-facing
services, meaning both a scoped and an unscoped path exist in one file:

- `src/server/services/calendar-connections.ts`
- `src/server/services/booking.ts`
- `src/server/services/conversations.ts`
- `src/server/services/documents.ts`
- `src/server/services/availability.ts`
- `src/server/services/calendar.ts`
- `src/server/services/members.ts`
- `src/server/services/voice.ts`
- `src/server/services/prompts.ts`

## Why it became a central hub

1. **It is structurally the only sanctioned path to tenant data.** `eslint.config.mjs:37-51`
   blocks importing `@/server/db/prisma` from anywhere outside `src/server/db`
   (`no-restricted-imports`), forcing all business code through `tenantDb()`.
2. **It travels paired with `requirePermission()` and `audit()`.** These are the #1, #2, and
   #3 highest-degree nodes in the whole graph. `docs/DECISIONS.md:67` states every Server
   Action / API handler starts with `requirePermission("...")`, so most functions that need
   `tenantDb` need `requirePermission` too, compounding the fan-in.
3. **It is genuinely load-bearing, not just convention.** `docs/ARCHITECTURE.md:268` and
   `docs/DECISIONS.md:31-38` both confirm RLS is not load-bearing for product queries — the
   app's Prisma connection uses a role that bypasses RLS by design, so `tenantDb()` is the
   real tenant boundary.

## Security and tenant-isolation risks

- **RLS is not a backstop for product queries.** This is a deliberate, already-approved
  architecture decision (`docs/DECISIONS.md:31-38`), not a defect — but it means `tenantDb()`
  plus caller discipline at `unscopedPrisma` sites is the *entire* cross-tenant defense for
  the 33 allow-listed models. There is no database-level fallback if application code gets
  this wrong.
- **`unscopedPrisma` is unguarded by tooling.** The ESLint rule at `eslint.config.mjs:37-51`
  restricts only the raw `@/server/db/prisma` import, not `unscopedPrisma`
  (`docs/DECISIONS.md:64-66` confirms this is intentional). Nine tenant-facing service files
  import both from the same line, so a future edit can call the wrong one with no compiler
  error.
- **Confirmed, already-documented latent risk — `getFreshTokens()`.**
  `src/server/services/calendar-connections.ts` — `getFreshTokens(connectionId)` calls
  `unscopedPrisma.calendarConnection.findUnique({ where: { id: connectionId } })` with no
  org/user filter, and returns decrypted OAuth access/refresh tokens
  (`docs/DATABASE-AUDIT.md:148-156`). Every current caller (`disconnectConnection`,
  `checkConnectionHealth`, `syncExternalCalendar`, `ensureWebhookSubscription`) passes a
  `connectionId` already validated against `ctx.orgId` earlier in the same call chain — safe
  today by caller discipline, not by construction. Already tracked as P1
  (`docs/ROADMAP.md:59-61`).
- **New finding — `TENANT_MODELS` allowlist has no automated guard.** The scoping check at
  `src/server/db/tenant.ts:61` is `if (!model || !TENANT_MODELS.has(model)) return
  query(args);` — if a Prisma model is added to the schema and someone forgets to add it to
  this 33-entry allowlist, `tenantDb()` becomes a **silent, unscoped passthrough** for that
  model: no error, no warning, just unfiltered cross-tenant access on every query. I diffed
  the current schema (43 models) against the allowlist: the 10 excluded models are all
  correctly and intentionally parent-scoped or non-tenant (`Message`, `PipelineStage`,
  `DocumentChunk`, `TagsOnContacts`, `EventAttendee`, `AvailabilityRule`,
  `AvailabilityOverride`, `BookingToken`, `User`, `Organization`). **The list is in sync
  today.** But `TENANT_MODELS` is referenced nowhere else in the repo — no test enforces
  this stays true after the next schema change.
- **Already-tracked, lower-severity gaps** (both same-tenant consistency issues, not
  cross-tenant leaks): `DocumentUploadIntent` → `Document` has no FK, correlated only by
  matching `storagePath` strings in application code (`docs/DATABASE-AUDIT.md:161-162`); the
  RAG general-search retrieval path is missing a `deleted_at`/`status='READY'` filter that
  the documentId-scoped path already has (`docs/ROADMAP.md:62-63`).

## Performance, testing, and maintainability risks

**Performance.** `tenantDb(orgId)` is invoked fresh inside nearly every exported service
function (e.g. `const db = tenantDb(ctx.orgId)` at `src/server/services/deals.ts:49`) rather
than once per request, each call re-running `prisma.$extends(...)`. Prisma extensions are
lightweight wrapper objects, so this is unlikely to be a measurable bottleneck — flagged for
awareness, not as a confirmed problem. No profiling data exists either way.

**Testing.** 11 unit test files individually mock the Prisma-extension shape
(`tenantDbMock`): `tests/unit/deals-service.test.ts`, `tests/unit/contacts-service.test.ts`,
`tests/unit/companies-service.test.ts`, `tests/unit/calendar-service.test.ts`,
`tests/unit/calendar-sync.test.ts`, `tests/unit/booking-service.test.ts`,
`tests/unit/booking-tokens.test.ts`, `tests/unit/dashboard.test.ts`,
`tests/unit/document-tenant-integrity.test.ts`,
`tests/unit/conversation-document-integrity.test.ts`,
`tests/unit/ai-chat-integration.test.ts`. Any change to `tenantDb()`'s call signature or
returned-extension shape has a blast radius across all 11.

**Maintainability.** `tenantDb` and `unscopedPrisma` are exported from the same module with
no naming convention that signals trust level at the call site — an import line alone
doesn't tell a reviewer whether a new call is tenant-safe or not.

## Circular dependencies or excessive coupling

- **No import cycles.** The graph's cycle detector reports none globally. Structurally,
  `src/server/db/tenant.ts` imports only `server-only` and `./prisma`
  (`tenant.ts:1-4`) — it has no outgoing dependency that could cycle back to it.
- **Hub-and-spoke over-coupling, not a cycle.** ~24 service/page files import directly from
  this one file, and it is the #1 highest-degree node in the 1,797-node graph, with
  `requirePermission()` (#2) and `audit()` (#3) forming a tightly coupled trio. Any signature
  change to `tenantDb()` has a blast radius touching most of the service layer in a single
  commit.

## Findings classified by severity

**Critical**
1. RLS is not load-bearing for product queries — `tenantDb()`/caller discipline is the sole
   cross-tenant defense for 33 models. Deliberate, already-approved design
   (`docs/DECISIONS.md:31-38`); listed here because it is the premise the rest of this audit
   depends on, not because it needs a code change.
2. `getFreshTokens()` unscoped-by-construction; returns decrypted OAuth tokens; safe only by
   caller discipline. Already tracked, no known exploit path
   (`docs/DATABASE-AUDIT.md:148-156`, `docs/ROADMAP.md:59-61`).
3. `TENANT_MODELS` allowlist has no automated guard against silent drift on schema changes.
   Currently in sync; this is a process gap, not an active bug. **(New finding.)**

**Important**
4. `unscopedPrisma` and `tenantDb` imported side-by-side in 9 tenant-facing service files
   with no lint boundary between them. No current known misuse found.
5. `DocumentUploadIntent` → `Document` missing FK, app-layer-only correlation. Already
   tracked (`docs/DATABASE-AUDIT.md:161-162`).
6. RAG general-search retrieval path missing `deleted_at`/`status='READY'` filter. Same-tenant
   consistency gap, not cross-tenant. Already tracked (`docs/ROADMAP.md:62-63`).

**Optional**
7. Per-call `tenantDb(orgId)` re-instantiation instead of once-per-request reuse — no
   measured impact.
8. 11 test files individually mock the Prisma-extension shape — friction only if the
   interface changes.
9. `tenantDb`/`unscopedPrisma` co-exported from one module with no trust-level naming signal
   — a readability improvement, not a defect.

## Recommended implementation order

None of the following has been executed. Sequenced smallest-and-lowest-risk first; each
stage is independently shippable and reversible by reverting its own commit.

1. **Confirm `TENANT_MODELS` is still complete (audit only, no code change).** Already done
   manually in this report — the allowlist matches the schema today. Re-run before every
   future schema change until stage 2 lands.
2. **Add a regression test for `TENANT_MODELS` coverage** — new test file only, no
   production code touched.
3. **Harden `getFreshTokens()`** to accept and filter by `orgId` directly, per the fix
   already specified in `docs/DATABASE-AUDIT.md:160` and `docs/ROADMAP.md:59-61`. Isolated to
   one function in `src/server/services/calendar-connections.ts` and its ~4 existing callers,
   all of which already have `orgId` available.
4. **Fix the RAG general-search filter gap** (`deleted_at`/`status='READY'`) in the
   `match_chunks()` path in `src/server/ai/rag.ts`, matching the already-correct
   documentId-scoped path. Already specified in `docs/AI-RAG-AUDIT.md` §6.
5. **Mechanical rename for clarity:** re-export `unscopedPrisma` from a distinctly named
   module (e.g. `src/server/db/unscoped.ts`) while `tenant.ts` keeps only `tenantDb`. Pure
   find/replace across ~58 import lines, no behavior change. Ship as its own PR so the diff
   stays reviewable in isolation from any logic change.
6. **Add the missing FK** from `Document` to `DocumentUploadIntent` as a separate additive
   Prisma migration, following the project's existing convention of shipping correction
   migrations separately rather than folded into other changes (`docs/DECISIONS.md`). The
   only stage requiring a schema migration; sequence it last.
7. **Explicitly postponed / not recommended without separate review:** switching the Prisma
   connection to a non-RLS-bypassing role to make RLS load-bearing for product queries. See
   "Items that should be postponed" below.

## Required tests and acceptance criteria per stage

**Stage 1 — TENANT_MODELS audit (no code change)**
- No new test. Acceptance: this document's manual diff (43 schema models vs. 33-entry
  allowlist, 10 correctly excluded) is the record of completion. Re-verify manually before
  stage 2 ships, and after any `prisma/schema.prisma` change until stage 2 is live.

**Stage 2 — TENANT_MODELS coverage test**
- New test: assert every Prisma DMMF model name is either present in `TENANT_MODELS` or in a
  hardcoded, documented exclusion list (`Message`, `PipelineStage`, `DocumentChunk`,
  `TagsOnContacts`, `EventAttendee`, `AvailabilityRule`, `AvailabilityOverride`,
  `BookingToken`, `User`, `Organization`).
- Acceptance criteria: test fails if a new model is added to the schema without being
  classified into one of the two lists; test passes against the current schema with zero
  production code changes; `npm run typecheck && npm test` both green; no existing test
  behavior altered.

**Stage 3 — `getFreshTokens()` hardening**
- Update existing/add unit test coverage in whichever test file covers
  `calendar-connections.ts` (currently `tests/unit/calendar-sync.test.ts` and related) to
  assert: (a) `getFreshTokens(orgId, connectionId)` returns tokens only when the connection's
  `organizationId` matches `orgId`; (b) it throws/returns not-found for a `connectionId` that
  exists but belongs to a different org.
- Acceptance criteria: new test fails against the pre-fix implementation and passes after;
  all 4 existing callers (`disconnectConnection`, `checkConnectionHealth`,
  `syncExternalCalendar`, `ensureWebhookSubscription`) updated to pass `orgId` and pass their
  existing tests unmodified in behavior; `npm run lint && npm run typecheck && npm test &&
  npm run build` all green.

**Stage 4 — RAG retrieval filter fix**
- Add/extend a unit test on the `match_chunks()` / general-search path in `src/server/ai/rag.ts`
  asserting soft-deleted (`deleted_at` set) and non-`READY` documents are excluded from
  general-search results, mirroring the existing documentId-scoped path's test coverage.
- Acceptance criteria: new test fails pre-fix, passes post-fix; existing documentId-scoped
  tests unchanged; `npm run typecheck && npm test` green.

**Stage 5 — `unscopedPrisma` module split**
- No new test required (pure re-export move). Acceptance criteria: `npm run typecheck && npm
  run lint && npm test && npm run build` all green with zero behavior diff; grep confirms no
  remaining import of `unscopedPrisma` from `@/server/db/tenant` outside the new module's
  re-export; all ~58 previously-identified call sites updated to the new import path.

**Stage 6 — `DocumentUploadIntent` ↔ `Document` FK**
- See "Migration and rollback requirements" below for the full checklist. Test-wise: extend
  `tests/unit/document-tenant-integrity.test.ts` and/or
  `tests/unit/conversation-document-integrity.test.ts` to assert the new FK is enforced
  (inserting a `Document` referencing a `DocumentUploadIntent` in a different org fails at
  the DB level, not just in application code).
- Acceptance criteria: migration applies cleanly to a copy of the staging schema; existing
  `storagePath`-based correlation continues to pass all current tests; new FK-enforcement
  test fails against the pre-migration schema (if run against a schema without the FK, it
  should demonstrate the gap) and passes post-migration; full verification sequence per
  `docs/release-runbook.md` (lint/typecheck/test/build + `npx prisma validate`) green.

## Migration and rollback requirements, especially for Step 6

Step 6 is the only stage in this plan that touches the database schema. It must **not** be
executed as part of this document — it is a plan, not an action.

- **Migration must be additive and separate**, per the project's own established convention
  ("ship correction migrations as separate additive migrations, not folded in" —
  `docs/DECISIONS.md`). Do not combine it with any other schema change.
- **Follow the two-system synchronization requirement**: `docs/DECISIONS.md` notes RLS/SQL
  and Prisma migrations are two systems that must stay manually synchronized — if the new FK
  requires any hand-applied SQL (e.g. an RLS policy touch), it must be added to the
  corresponding `prisma/sql/*.sql` script in the same PR, not deferred.
- **Backfill consideration**: existing `Document` rows have no FK to `DocumentUploadIntent`
  today. Before adding a `NOT NULL` composite FK, audit whether all current `Document` rows
  have a matching `DocumentUploadIntent` by `storagePath`; if any don't, the FK must either
  be nullable or a backfill/cleanup step must run first and be documented as a prerequisite,
  not assumed.
- **Follow the composite-FK pattern already established** for `Collection`→`Document`,
  `Document`→`DocumentChunk`, and `Conversation`+`Document`→`ConversationDocument`
  (`docs/DATABASE-AUDIT.md` §2): `@@unique([organizationId, id])` on the parent plus a
  composite FK `[organizationId, xId] → Parent([organizationId, id])`, so the constraint is
  enforced at the database level, not just by convention.
- **Staging-first rollout**: per `docs/release-runbook.md`, the migration must pass the
  three-stage CI → staging → production pipeline, including staging RLS/tenant SQL
  assertions and Playwright E2E smoke tests, before any production deploy.
- **Rollback plan required before merge**: because this is an additive migration, rollback
  should be a corrective migration that drops the new FK/constraint — per
  `docs/DECISIONS.md`, "rollback must reverse application order (app before corrective
  migration)." Do not plan to roll back by editing/deleting the forward migration file after
  it has shipped to any environment; write a new down-migration instead. Document the exact
  rollback migration alongside the forward one in the same PR description, even though it
  won't be applied unless needed.
- **No code in this repository should assume the FK exists** until the migration has been
  applied in production and verified — any application-code change that depends on the new
  FK (e.g. removing the `storagePath`-based correlation fallback) must ship in a later,
  separate PR, never the same one as the migration.

## Items that should be postponed

- **Switching the Prisma connection to a non-RLS-bypassing role**, to make RLS load-bearing
  for product queries. `docs/DECISIONS.md:35-38` is explicit: "Do not change the database
  connection role to a non-bypassing role without an explicit architecture review — RLS
  policies expect JWT claims the current connection doesn't carry, so switching roles would
  break functionality rather than freely add security." This audit does not recommend
  revisiting that decision; it is listed only because a naive reading of "TenantDb is a
  single point of failure" might suggest it as the obvious fix. It is not, given the current
  RLS policy design.
- **Removing or restricting `unscopedPrisma` itself.** It is a deliberate, documented escape
  hatch for legitimate cross-tenant infrastructure code (webhooks, jobs, superadmin). Stage 5
  above only renames its import path for clarity; removing the capability entirely is out of
  scope and would break existing legitimate call sites.
- **Any change to `TENANT_MODELS` contents.** The current 33-entry allowlist is verified
  correct against the schema as of this audit. No models should be added or removed as part
  of this plan — only the *test coverage* around the list changes (stage 2).
- **Any performance optimization of `tenantDb(orgId)` instantiation** (item 7 in the
  Optional findings). No profiling data exists showing this is a real cost; instrument and
  measure before optimizing, not before.
