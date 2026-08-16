# RLS UPDATE-Policy WITH CHECK Hardening

Repository-wide follow-up to the tenant-reassignment-via-UPDATE gap first found and fixed for
`business_dna`/`business_dna_services` (`20260816000000_business_dna_rls_update_with_check`,
documented in `docs/business-dna-mvp.md`). This document covers the same class of fix applied to
every other affected table, via `20260817000000_tenant_update_rls_with_check_hardening`.

## Vulnerability class: USING vs. WITH CHECK on UPDATE

A Postgres RLS `UPDATE` policy can carry two independent clauses:

- **USING** — evaluated against the row's state **before** the write, to decide whether the row
  is even visible for the `UPDATE` to touch.
- **WITH CHECK** — evaluated against the row's state **after** the write. If omitted, Postgres
  falls back to reusing `USING` for `SELECT`/`DELETE`, but for `UPDATE` a missing `WITH CHECK`
  means the resulting row is **never independently re-validated**.

A policy with only `USING (organization_id = auth_org_id())` therefore only proves the caller was
allowed to touch the row **before** the write. It does not stop the same `UPDATE` statement from
also setting `organization_id` to a different value — the write is a single atomic operation, and
without `WITH CHECK`, Postgres has no way to reject a resulting row that no longer belongs to the
caller's tenant. An authenticated member of organization A, authorized to update a row they
currently own, could in principle execute `UPDATE ... SET organization_id = '<org B>'` in the same
statement and move the row into a tenant they have no authorization for.

**The invariant this hardening protects**: a row visible/writable under tenant A before an
`UPDATE` must not be movable to tenant B unless the resulting row independently passes tenant
authorization.

## Audit method

Every `UPDATE` policy in the schema was enumerated directly from a fully-migrated Postgres
database (`SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE cmd =
'UPDATE'`), not assumed from memory or prior documentation. Each table's Prisma model was then
read to check its real ownership shape (nullable vs. required tenant column, unique constraints,
foreign keys) and its actual application-layer read/write paths were inspected.

## Fixed tables

`20260817000000_tenant_update_rls_with_check_hardening` adds `WITH CHECK` to 16 `UPDATE`
policies via `ALTER POLICY` (which leaves the existing `USING` clause, and every `DELETE`/`INSERT`
policy, untouched):

| Table               | New `WITH CHECK`                                           | Notes                                   |
| ------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `activities`        | `organization_id = auth_org_id()`                          |                                         |
| `calendar_events`   | `organization_id = auth_org_id()`                          |                                         |
| `collections`       | `organization_id = auth_org_id()`                          |                                         |
| `companies`         | `organization_id = auth_org_id()`                          |                                         |
| `contacts`          | `organization_id = auth_org_id()`                          |                                         |
| `conversations`     | `organization_id = auth_org_id()`                          |                                         |
| `deals`             | `organization_id = auth_org_id()`                          |                                         |
| `documents`         | `organization_id = auth_org_id()`                          |                                         |
| `pipelines`         | `organization_id = auth_org_id()`                          |                                         |
| `tags`              | `organization_id = auth_org_id()`                          |                                         |
| `teams`             | `organization_id = auth_org_id()`                          |                                         |
| `voice_assistants`  | `organization_id = auth_org_id()`                          |                                         |
| `webhook_endpoints` | `organization_id = auth_org_id()`                          |                                         |
| `workflows`         | `organization_id = auth_org_id()`                          |                                         |
| `prompts`           | `organization_id = auth_org_id()`                          | see "Special case: prompts" below       |
| `notifications`     | `user_id = auth.uid() AND organization_id = auth_org_id()` | see "Special case: notifications" below |

(`business_dna` and `business_dna_services` were already fixed by the prior migration; they're
included in the live `pg_policies` verification below for completeness, not re-changed here.)

## Special case: prompts

`Prompt.organizationId` is **nullable** — a `NULL` row is a global/system prompt, and
`prompts_select`'s existing policy (`organization_id IS NULL OR organization_id = auth_org_id()`)
already treats it as visible to every organization. Critically, `prompts_update`'s `USING
(organization_id = auth_org_id())` clause evaluates to `NULL` (never `true`) for a `NULL`
`organization_id` row, so **global prompts were never visible to this policy's `USING` clause for
an authenticated caller in the first place** — they are not writable through this RLS path today,
with or without this fix.

The gap this closes is therefore specific to **org-owned** prompts: without `WITH CHECK`, a
member of organization A, authorized to update their own org's prompt, could execute
`UPDATE prompts SET organization_id = NULL WHERE id = <own prompt>` — "promoting" their org's
prompt content to a globally-visible system prompt, an information-disclosure risk on top of the
plain reassignment risk. The new `WITH CHECK (organization_id = auth_org_id())` closes both: the
resulting row must still belong to the caller's own org, so it can neither move to another
specific organization nor become `NULL`/global. Global prompts remain entirely unaffected, since
this policy never applied to them either before or after this change.

## Special case: notifications

`Notification` is genuinely **dual-owned** — `organizationId` and `userId` are both real,
independent, `NOT NULL` columns, and `notifications_select`'s existing policy already requires
both (`user_id = auth.uid() AND organization_id = auth_org_id()`). `notifications_update`,
however, only ever checked `user_id = auth.uid()`.

The generic `organization_id`-only `WITH CHECK` shape used for the other 14 tables would have
been the **wrong** predicate here — a notification's true access boundary is "this org AND this
specific user," not org membership alone. The new `WITH CHECK (user_id = auth.uid() AND
organization_id = auth_org_id())` mirrors `notifications_select`'s own predicate exactly instead.

Risk assessment before fixing: since `notifications_select` already requires both predicates,
reassigning a notification's `organization_id` alone (the previously-possible attack) could not
leak the notification to any other user or organization — the recipient's own `user_id` gate
still applied. The practical risk was closer to self-inconsistent data (a user's own notification
tagged with the wrong org) than a cross-tenant leak, but the fix is safe and mechanical: verified
against the only app-layer `UPDATE` path
(`src/server/services/notifications.ts` `markRead`), which only ever writes `read_at` and never
touches `organization_id`/`user_id`, so no legitimate behavior changes.

## Deferred: users

`users_self_update` (`USING (id = auth.uid())`) is **intentionally not touched**:

- `users` is self-referential identity data, not tenant-owned data — there is no "tenant" for a
  `WITH CHECK` to protect here in the same sense as the other tables.
- The only app-layer writes to `users` (`src/actions/settings.ts`, `src/server/services/
organizations.ts`) already go through `unscopedPrisma` (the service-role connection), never
  through this RLS-gated authenticated path at all — this policy has no bearing on the app's own
  behavior either way.
- `id` is both this table's primary key and the target of many other tables' foreign keys.
  Reassigning it to an existing user's `id` is already blocked by the primary-key uniqueness
  constraint; reassigning it to an unused `id` is self-orphaning (the row silently becomes
  inaccessible to its own owner on the next request, since `auth.uid()` no longer matches), not a
  cross-user or cross-tenant attack.

Documented as a deliberate, reviewed deferral, not a silent gap.

## Migration

`20260817000000_tenant_update_rls_with_check_hardening`: additive, policy-only (`ALTER POLICY`),
no table/column/data change. Verified against both a fresh install (all 22 migrations replayed
from an empty schema) and a true upgrade path (`main`'s prior 21 migrations applied first,
representative rows inserted across `companies`/`contacts`/`deals`/`prompts`/`notifications` using
the pre-hardening schema, then this migration applied on top) — confirmed via the actual Prisma
client, not just raw SQL, that every pre-existing row's data was untouched and the app-layer write
path (`prisma.deal.update(...)`) still works.

The legacy schema-contract generator (`scripts/generate-legacy-schema-contract.mjs`) and
`tests/staging/release-invariants.sql` were updated to reflect the new `WITH CHECK` values.
`20260719000000_initial_security_baseline` (checksum-pinned, historical — never edited) still
declares these 16 policies with their original `USING`-only shape in its own mid-deploy contract,
since that snapshot is necessarily frozen at its own point in migration history;
`tests/unit/release-migration-contract.test.ts` was updated with an explicit, reviewed
`SUPERSEDED_UPDATE_ROWS` list so this deliberate, documented policy evolution doesn't read as
unexplained drift.

## Live RLS test coverage

`tests/rls/isolation.sql` (extended; fixtures in `tests/rls/isolation-fixtures.sql`) proves, for
every one of the 15 hardened organization-owned tables, against real Postgres RLS with a real
authenticated role (not mocks):

1. Organization A can update its own row.
2. Organization A **cannot** reassign that row's `organization_id` to organization B (rejected by
   `WITH CHECK`; the row is provably unchanged afterward, since the whole run happens inside a
   transaction that always rolls back).
3. A **guessed** organization B row id cannot be updated at all, by primary key alone, independent
   of whether the caller also happens to filter by `organization_id`.

`notifications` gets the same three assertions using its dual-predicate `WITH CHECK`. The suite
also still covers cross-tenant `SELECT` visibility and cross-tenant `INSERT` rejection (pre-
existing coverage, unaffected by this change). Run via `scripts/ci/run-rls-check.sh iso
tests/rls/isolation-grants.sql tests/rls/isolation-revokes.sql tests/rls/isolation-fixtures.sql
tests/rls/isolation-cleanup.sql tests/rls/isolation.sql tests/rls/isolation-grants-verify.sql`.

## Application-layer defense (unaffected, reviewed)

RLS is defense-in-depth here, not the primary tenant boundary for this app's own backend:

- Every hardened table is in `TENANT_MODELS` (`src/server/db/tenant.ts`); `tenantDb(orgId)`
  already injects `organizationId` into every `find*`/`update`/`delete`/`upsert`'s `where` clause
  and always overrides any client-supplied `organizationId` in `create`/`createMany`'s `data`.
- A representative sample of relation-assignment code (`src/server/services/contacts.ts`,
  `src/server/services/deals.ts`) confirmed explicit tenant-ownership assertions
  (`assertCompanyInTenant`, `assertContactInTenant`, `assertStageInTenant`) already guard
  cross-entity relations before linking — a real defense against IDOR via a related-entity id,
  independent of this RLS change.
- No raw client-payload spread into a hardened table's Prisma `update`/`create` `data` was found;
  the two spread patterns found repo-wide (`src/server/services/booking.ts`,
  `src/server/services/calendar-sync.ts`) both override the tenant column **after** the spread, so
  a malicious value cannot win.

RLS `UPDATE` policies do not, and did not before this change, role-gate by `OWNER`/`ADMIN`/
`MANAGER`/`MEMBER`/`VIEWER` — only `DELETE` policies do. Role-based write restriction is an
application-layer (RBAC) concern in this codebase, layered separately from RLS's tenant-boundary
job; this hardening pass does not change that split, broaden any role's effective permissions, or
touch any `DELETE`/`INSERT` policy.

## Remaining security debt

None from this class of issue: every `UPDATE` policy identified by the prior Business DNA review's
sibling-table scan is now either hardened (16 tables, this pass + the prior business_dna pass) or
explicitly documented as deferred with a reviewed reason (`users`). A future pass could revisit
`users_self_update` if the identity/auth architecture changes to route writes through the
RLS-gated path, but there is no known exploitable gap today.
