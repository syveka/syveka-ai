# Business DNA MVP

Business DNA is Syveka's organization-scoped source of truth for factual business context used by customer-facing and operator-facing AI features. It exists so Inbox, Chat, Voice, Booking, CRM and future automation modules do not each invent their own business-profile storage or prompt formatting.

## Current architecture

The current MVP is a singleton `BusinessDNA` record per organization (`business_dna.organization_id` is unique). The record is accessed through the normal Syveka stack:

1. UI or REST transport authenticates the user and calls `requirePermission("business-dna:read" | "business-dna:write")`.
2. The resulting `TenantContext` supplies the trusted `orgId`. Client payloads do not select a tenant.
3. `src/server/services/business-dna.ts` uses `tenantDb(ctx.orgId)` for reads and writes and audits create/update mutations.
4. `business_dna` is included in the tenant model allowlist, so Prisma access receives the organization predicate automatically.
5. Postgres RLS provides defense in depth for Supabase-native access. The table's policies bind authenticated CRUD to `auth_org_id()`; destructive access is role restricted.
6. `src/server/business-dna/context.ts` is the canonical read/normalization/prompt boundary for downstream agents. Consumers must use it instead of re-querying or hand-formatting Business DNA.

The REST surface is `GET /api/v1/business-dna` for reads and `PUT /api/v1/business-dna` for create-or-replace. The authenticated app uses the same service through Server Actions. Validation is centralized in `src/lib/validators/business-dna.ts`.

## Current persisted model

The shipped MVP intentionally keeps one row per organization and separates the main business concepts instead of storing one unrestricted profile blob:

- identity: `displayName`, `industry`
- supported languages: `supportedLocales`
- products/services summary: `productsServices`
- communication: `brandTone`, `communicationStyle`
- weekly opening hours: `openingHours` (validated JSON)
- customer-facing policies: `policies`
- pricing guidance: `pricingNotes`
- minimal customer context: `targetCustomer`
- operational facts: `keyFacts[]`
- extraction provenance: `sourceUrl`, `extractedAt`

This is sufficient for the currently integrated Chat, Voice, Inbox, Booking and CRM prompt consumers, but it is not the final structured Business DNA domain model.

## Authorization and tenant isolation

Business DNA must never accept an organization identifier as authority from request data. Tenant identity comes only from the authenticated `TenantContext`.

The permission split is:

- `business-dna:read`: read the organization's profile
- `business-dna:write`: create/update the organization's profile

Transport handlers are responsible for calling `requirePermission`; domain services are responsible for using `tenantDb(ctx.orgId)` and for audit logging sensitive writes. Unknown request fields are rejected at validation boundaries so a client cannot smuggle `organizationId`, role flags, or future persistence fields through mass assignment.

Cross-tenant protection is covered at multiple layers: permission/session resolution, tenantDb query injection, service tests, and live SQL RLS tests. Do not replace these with a client-supplied organization filter.

## Agent consumption contract

All AI modules should consume Business DNA through `src/server/business-dna/context.ts`.

That module has two responsibilities:

- perform the single tenant-scoped Business DNA read for an organization;
- turn the record into a normalized, explicitly untrusted factual context block.

Business DNA is factual reference data, not system instructions. Free-text values may have been entered by a user or derived from a website, so prompt consumers must preserve the existing prompt-injection boundary and the no-fabrication rule.

New consumers should not:

- query `businessDNA` directly unless there is a documented non-AI need;
- implement a second prompt formatter;
- infer prices, policies, opening hours or customer facts that are absent;
- treat organization-authored text as higher-priority instructions than platform rules.

## Structured MVP evolution

The next schema evolution should preserve the singleton Business DNA root while adding structure only where agents need deterministic fields. The intended MVP shape is:

### Company

- business name
- industry/business type
- short business description
- supported languages
- IANA timezone

### Products and services

A child collection (or equivalently well-typed structured relation) with:

- name
- description
- base price / price information
- duration where applicable
- active/inactive state
- stable organization ownership

A separate child collection is preferred over encoding a catalog as opaque free text once services need CRUD, filtering or Booking integration.

### Communication

- brand tone
- communication style
- preferred response style
- language behavior/instructions

### Opening hours

- weekly schedule
- closed days
- timezone
- small exception/holiday structure

### Policies

Structured fields for cancellation, booking, refund/return, payment and other customer-facing rules. Missing policies must remain missing; agents must never synthesize policy exceptions.

### Pricing and quotes

- currency
- basic pricing rules
- quote template/instructions
- constraints/notes

Money that becomes machine-actionable should follow the repository convention of integer minor units rather than floating-point currency values.

### Customer context and operational facts

Keep only the minimum context required for safe responses and actions. Operational facts should be bounded and structured enough to identify their meaning; this is not a general knowledge-base replacement.

Any persistence expansion must be delivered through the repository's normal Prisma migration workflow and regenerate the legacy schema-contract artifacts in lockstep. It must preserve RLS, tenantDb coverage, audit behavior, and live cross-tenant tests.

## UI

The existing `/settings/business-dna` page is the owner-facing editor. As structured fields are introduced, keep the page simple and organize it around the domain rather than the database:

1. Company
2. Services
3. Communication
4. Hours
5. Policies
6. Pricing / Quotes

Use the existing next-intl and RTL conventions. Read-only roles should continue to receive a non-editable view rather than an alternate data path.

## Intentionally deferred beyond MVP

The following are explicitly outside Business DNA MVP and must not be silently added to the profile:

- competitor intelligence
- KPI history
- advanced marketing strategy
- long-term strategic goals
- automatic pricing optimization
- continuous-learning business profiles
- market intelligence

Those capabilities require separate product, provenance and authorization decisions. Business DNA should remain the trusted operational profile used to answer and act consistently, not become an unrestricted strategy warehouse.
