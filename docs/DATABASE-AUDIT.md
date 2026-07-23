# Syveka AI — Database & Tenant-Security Audit

Snapshot date: **2026-07-23**. Based on a full read of `prisma/schema.prisma` (43 models),
all 10 tracked migrations, the 6 hand-applied `prisma/sql/*.sql` scripts, `supabase/`, and
every `unscopedPrisma`/`tenantDb` call site sampled across services, actions, and API routes.

## 1. Models and tenancy

43 models total. Every business model carries `organizationId String @db.Uuid` **except**
models deliberately scoped only through a parent relation (documented via code comments):
`PipelineStage` (via `Pipeline`), `TagsOnContacts` (via `Contact`/`Tag`), `Message` (via
`Conversation`), `EventAttendee` (via `CalendarEvent`), `AvailabilityRule`/
`AvailabilityOverride` (via `AvailabilitySchedule`), `BookingToken` (via `Booking`).
`Prompt.organizationId` is nullable by design (global/org-shared template library).

## 2. Composite tenant-safety constraints — the important pattern, and where it's missing

Three relations use `@@unique([organizationId, id])` on the parent **plus a composite FK**
`[organizationId, xId] → Parent([organizationId, id])`, which makes it structurally impossible
at the database level for a child row to reference a parent in a different org:

| Parent | Child | FK | Added in |
|---|---|---|---|
| `Collection` | `Document.collection` | `[organizationId, collectionId] → Collection([organizationId, id])`, `onDelete: Restrict` | `20260715230000_security_invariant_corrections` |
| `Document` | `DocumentChunk.document` | `[organizationId, documentId] → Document([organizationId, id])`, `onDelete: Cascade` | same |
| `Conversation` + `Document` | `ConversationDocument` | both FKs composite, `onDelete: Cascade` | same |

**This pattern is used only for these three relations.** Every other cross-model relation
(`Contact.company`, `Deal.contact/company`, `CalendarEvent.externalCalendar`, `Booking.bookingType`,
`VoiceCall.assistant`, etc.) uses a plain single-column FK with **no DB-level guarantee both
rows share the same `organizationId`** — that invariant is enforced only by application code
(`tenantDb`) or by services re-validating parent ownership before use.

**`DocumentUploadIntent` ↔ `Document`: no FK relationship exists at all.**
`DocumentUploadIntent` (`organizationId`, `userId`, unique `storagePath`) has no FK to
`Document`, and `Document` has none back. The two are correlated only by matching
`storagePath` strings in application code (`src/server/services/documents.ts`). A `CHECK`
constraint added in the same corrective migration enforces
`document_upload_intents.storage_path LIKE organization_id || '/%'`, but nothing at the DB
level ties the *resulting* `Document` row's org to the intent that authorized it — that is an
application-layer invariant only, verified correct today but not database-enforced.

## 3. Evidence of shipped-then-patched schema drift (directly answers the audit brief)

`20260715000000_ai_chat_production_hardening` created `conversation_documents` with **plain**
single-column FKs to `conversations`/`documents`/`organizations`. Roughly 2.5 hours later,
`20260715230000_security_invariant_corrections` — whose header explicitly states "Additive
correction for tenant relationship integrity. Do not fold this into either previously published
production-hardening migration." — dropped those plain FKs and replaced them with the composite
org-matching FKs described above, and did the same for `documents.collection_id` and
`document_chunks.document_id` (both originally plain FKs from the `20260701000000_initial_baseline`
migration). **For that ~2.5-hour window, the database itself would have permitted linking a
conversation/document/chunk across organizations** — only Prisma-layer discipline prevented it
in practice. This has since been corrected and the correction is preserved as its own migration
(the convention to preserve going forward, per `PROJECT-CONTEXT.md`).

Similarly, `20260713000000_calendar_booking_v1` shipped 11 new tables with **no RLS at all**;
RLS for them was added five days later in `20260718000000_calendar_booking_rls`. During that
window, RLS provided no protection for those tables — again, this only matters for the
Supabase-native client path (see §6), since Prisma bypasses RLS regardless.

## 4. Migration-by-migration summary

| Migration | What it does | RLS? |
|---|---|---|
| `20260701000000_initial_baseline` | **Not a from-scratch schema.** First ~1010 lines are a compatibility contract that verifies (or creates, if empty) a pre-existing hand-provisioned DB matches an exact expected shape (columns, types, FKs, enums, indexes) — because the DB predates Prisma migration tracking. Remaining lines create ~31 of the 43 eventual tables. | No |
| `20260712000000_dashboard_indexes` | 5 dashboard-query compound indexes | No |
| `20260712120000_crm_contacts_companies_v1` | `archived_at` columns, `activities.company_id` | No |
| `20260712180000_crm_deals_v1` | `deals.probability/position`, `STAGE_CHANGE` enum value | No |
| `20260713000000_calendar_booking_v1` | 11 new tables (calendar/booking domain) | **No** (deferred) |
| `20260714000000_secure_document_upload_intents` | Creates `document_upload_intents` | Enabled, **zero policies** (deliberate deny-all — server-only table) |
| `20260715000000_ai_chat_production_hardening` | Conversation summary fields, `conversation_documents` table (plain FKs) | Enabled + `FORCE`, one SELECT policy |
| `20260715230000_security_invariant_corrections` | Composite-FK correction (see §3) | N/A (constraint-only) |
| `20260718000000_calendar_booking_rls` | RLS for the 11 calendar/booking tables; 4 explicitly get zero policies (`calendar_connections`, `booking_tokens`, `reminders`, `calendar_sync_states` — OAuth tokens/secrets) | Yes |
| `20260719000000_initial_security_baseline` | pgvector HNSW index, `pg_trgm` search indexes, `match_chunks()` RPC, `handle_new_user()` trigger, **custom_access_token_hook** (stamps org_id/role into JWT), **enables RLS on all remaining tables (43/43 total)**, defines the full policy set, ends with a 695-line self-verifying policy-contract assertion | Yes — completes coverage |

Both migrations named "initial" are misleadingly positioned: `20260701000000_initial_baseline`
is a *compatibility guard* for an already-existing DB, and `20260719000000_initial_security_baseline`
is chronologically the **last** migration, retrofitting RLS that (per its own comments) was
originally hand-provisioned before migration tracking began.

**Out-of-band `prisma/sql/001–006`** (not Prisma-tracked): precursors/duplicates of what
`20260719000000` later formalizes (`001_extensions_and_indexes.sql`, `002_functions.sql`,
`003_rls.sql`), a deprecated wrapper (`005_calendar_booking_rls.sql`, now just includes the
tracked migration), a standalone legacy-preflight copy (`006_legacy_baseline_preflight.sql`),
and — the one with no tracked-migration equivalent — **`004_storage.sql`**, which provisions
5 Supabase Storage buckets and their org-prefix RLS policies. **A fresh environment provisioned
purely via `prisma migrate deploy` (the 10 tracked migrations) does not get Storage buckets** —
this is a manual, documented-in-runbook-only step.

## 5. Tenant-isolation risk by domain (requested checklist)

| Domain | DB-level enforcement | App-level enforcement | Verdict |
|---|---|---|---|
| Contacts / Companies | Plain FK, org-led indexes, full RLS CRUD | `tenantDb` exclusively | Clean |
| Deals | Same | `src/actions/deals.ts` (pattern consistent, not fully re-verified) | Clean |
| Collections / Documents | **Composite FK** (since correction migration) | `tenantDb` + validated `unscopedPrisma`; RAG queries re-filter by org | Clean |
| Conversations | **Composite FK** for `conversation_documents`; `Conversation` has `@@unique([organizationId,id])` | Ownership validated once via `tenantDb`, id reused safely after | Clean |
| Bookings / Calendar | Plain FKs; RLS is SELECT-only for most, zero-policy for 4 secret-bearing tables | `tenantDb`; public flow is unauthenticated by design (slug/token-resolved) | Clean, with one latent gap (see §7) |
| Voice agents / calls | Plain FK; full RLS CRUD on assistants, SELECT-only on calls | `tenantDb` + explicit re-verify in `syncToVapi` | Clean |
| API keys | Plain FK; RLS SELECT-only | Lookup by `keyHash` (the key **is** the credential) | Clean |
| Subscriptions / billing | 1:1 unique `organizationId`; RLS SELECT-only | Always keyed off `ctx.orgId` | Clean |
| Audit logs | Plain FK; RLS OWNER/ADMIN-only read | Writes always stamp `ctx.orgId`, use `unscopedPrisma` by design (must write even when actor lacks other permissions) | Clean |
| Notifications | Plain FK; RLS own-row | Explicit `organizationId` on job-created rows | Clean |
| File uploads (`DocumentUploadIntent`) | **No FK to `Document`**, only a path-prefix `CHECK` | `createDocument()` re-queries the intent by `(id, organizationId, userId)`, validates, atomically consumes | App-layer invariant only — see §2 |

## 6. The single most important finding: RLS does not protect the application

RLS coverage is **structurally complete** — all 43 tables have `ROW LEVEL SECURITY` enabled,
cross-checked against the `protected_tables` array in `20260719000000_initial_security_baseline`
with no table missing. The policy set is unusually rigorous: a 695-line self-verifying contract
block that raises an exception on any policy drift or unexpected extra policy.

**However, this protects almost nothing for the actual product**, because:

1. `src/server/db/prisma.ts`'s own header comment states: *"Raw Prisma client on the
   SERVICE-ROLE connection (bypasses RLS)."*
2. `prisma/sql/003_rls.sql`'s own comment states: *"Prisma uses the service role (bypasses
   RLS); these policies protect every Supabase-client path: PostgREST, Realtime, Storage."*
3. `DATABASE_URL`/`DIRECT_URL` connect via the Supabase-provisioned pooled/direct Postgres role,
   which is exempt from RLS regardless of `FORCE ROW LEVEL SECURITY` (only `conversation_documents`
   even has `FORCE` set, and it doesn't matter for this connection role either way).

**Practical implication**: RLS is a genuine, real defense layer only for Supabase-native client
paths authenticated with a user JWT — PostgREST (if ever queried directly), Realtime, and
Storage (`storage.objects`, meaningfully enforced against `createSupabaseServer()` calls). It is
**not** a backstop for the Prisma/Next.js application layer, where ~100% of business logic runs.
All real tenant isolation for the product rests on:

- `tenantDb(orgId)` — a Prisma Client Extension (`src/server/db/tenant.ts`) that auto-injects
  `organizationId` into every query for a fixed **32-model allow-list**, structurally
  preventing a caller from forgetting the filter for those models.
- **Manual discipline at ~40 `unscopedPrisma` call sites** — the documented "escape hatch for
  cross-tenant infrastructure code (webhooks, jobs)." An ESLint rule bans importing
  `@/server/db/prisma` directly outside `src/server/db/**`, but **does not restrict
  `unscopedPrisma`**, which is what most service/action/job code actually uses for anything
  outside the 32-model allow-list.

Sampling every `unscopedPrisma.<model>.findUnique/findFirst(` call site that takes a
request-supplied `id` (~35 call sites, the classic IDOR shape) found **no exploitable gap** —
every one either uses a secret token as the lookup key (booking tokens, API key hashes,
invitation tokens), explicitly includes `organizationId`/`userId` in its own `where`, or reuses
an id that was already validated by a preceding `tenantDb` call earlier in the same request.
**This is correct today by manual review, not by structural guarantee.**

## 7. One latent risk worth flagging (no current exploit path found)

`src/server/services/calendar-connections.ts` — `getFreshTokens(connectionId)` calls
`unscopedPrisma.calendarConnection.findUnique({ where: { id: connectionId } })` with **no
org/user filter**, and returns decrypted OAuth access/refresh tokens. Every current caller
(`disconnectConnection`, `checkConnectionHealth`, `syncExternalCalendar`,
`ensureWebhookSubscription`) passes a `connectionId` already validated against `ctx.orgId`
earlier in the same call chain — but the function itself is not tenant-safe in isolation, and
nothing prevents a future caller from passing an unvalidated id. **Recommendation**: require an
`orgId` parameter and filter on it inside `getFreshTokens` itself, so the function is safe by
construction rather than by caller discipline.

## 8. Recommended changes (do not implement without owner/Codex task assignment — see `NEXT-STEPS.md`)

1. Harden `getFreshTokens()` to take and filter by `orgId` directly (§7).
2. Consider adding a real FK/back-reference from `Document` to the `DocumentUploadIntent` that
   authorized it, closing the one remaining app-layer-only correlation (§2).
3. Fix the general-KB-search retrieval path's missing `deleted_at`/`status='READY'` filter to
   match the documentId-scoped path (see `AI-RAG-AUDIT.md` §6 — a same-tenant data-consistency
   gap, not a cross-tenant leak, but worth closing).
4. Document `prisma/sql/004_storage.sql` as a required manual step in any "provision a fresh
   environment" runbook — it is not covered by `prisma migrate deploy`.
5. Do **not** change the `DATABASE_URL` connection role to a non-bypassing role without an
   explicit architecture review — RLS policies are written expecting `auth_org_id()`/`auth_role()`
   JWT claims that the Prisma service-role connection does not carry; switching roles without
   also switching the entire query layer to pass those claims would break the application, not
   secure it further for free.
