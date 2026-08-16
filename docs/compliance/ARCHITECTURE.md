# Trust & Compliance Domain — Architecture

Companion to `docs/compliance/FINLAND_BASELINE.md` (what's implemented) and
`docs/compliance/CONTROL_MODEL.md` (the control/risk model in detail). This
doc covers _how_ the domain is built and _why_.

## Scope: Syveka-internal, not yet customer-facing

Everything in this domain is **Syveka's own security/compliance posture as a
vendor** — it protects and evidences Syveka's platform, and answers the
questions an enterprise customer's security questionnaire asks. It is
**not** a per-tenant customer feature yet. Issue #74 explicitly names "can
later evolve into a Syveka customer-facing Trust & Compliance product" as a
_future_ direction, not Phase 1 scope.

Consequence: every model added in this phase
(`prisma/migrations/20260815010000_compliance_foundation_phase1/`) is
Syveka-platform-level data, not tenant-owned data:

- None of the 18 new models are added to `TENANT_MODELS`
  (`src/server/db/tenant.ts`) — they're in `DOCUMENTED_EXCLUSIONS` in
  `tests/unit/tenant-models-coverage.test.ts`, the same drift-guard
  mechanism that already excludes `User`, `Organization`, and
  `StripeWebhookEvent`.
- Access is gated by `requireSuperadmin()`
  (`src/server/auth/superadmin.ts`), the same axis that already gates
  `/admin/organizations` — **not** the tenant RBAC system
  (`requirePermission()`). A regular organization OWNER cannot see or touch
  any compliance record, even for their own organization, because these
  records don't belong to any organization.
- RLS is enabled with **zero policies** on every new table (deny-all for
  PostgREST/anon/authenticated; only the Prisma service-role connection —
  itself gated by `requireSuperadmin()` at the application layer — can
  reach these tables). This is the same pattern already used for
  `stripe_webhook_events`, `inbox_mailboxes`, and `document_upload_intents`.

Two models carry a nullable, best-effort _reference_ to a tenant
organization — `SecurityIncident.affectedOrganizationId` and
`DataSubjectRequest.relatedOrganizationId`. These exist purely for
reporting ("which of our customers was affected by this incident") and are
**never** an access-control boundary, exactly like
`StripeWebhookEvent.organizationId`.

## One control model, many frameworks (Step 3)

```
ComplianceControl
  ├─ ControlFrameworkMapping[]   (one control -> many framework references)
  ├─ ComplianceEvidence[]        (proof this control is real)
  └─ (referenced by) ComplianceRisk.mitigationControlId
```

A single control — e.g. "tenant isolation is enforced at the application
layer, not trusted from client input" — gets **one** row in
`compliance_controls`, and as many `ControlFrameworkMapping` rows as
frameworks care about it (GDPR Art. 32-style access control, an ISO
access-control domain, a NIS2 access-control capability, a SOC 2 CC6-style
criterion) without duplicating the technical description four times. This
directly satisfies Step 3/21's "do not build separate GDPR/ISO/NIS2/SOC2
systems" instruction.

`frameworkReference` on `ControlFrameworkMapping` is Syveka's own free-text
identifier/description (e.g. `"access control"`, `"CC6.1-style"`) — never
copyrighted standard clause text.

## Claim safety is structural, not just a naming convention (Step 18)

`ComplianceControl` and `Certification` both carry a `verificationState`
(`ClaimVerificationState`: `TECHNICALLY_IMPLEMENTED` →
`INTERNALLY_REVIEWED` → `EXTERNAL_AUDIT_REQUIRED` → `EXTERNALLY_VERIFIED` →
`CERTIFIED`), **separate from** `implementationStatus`
(`ControlImplementationStatus`: whether the control is technically built at
all). Collapsing these into one `compliant: boolean` was explicitly
prohibited by the task — see `docs/compliance/SECURITY_CLAIMS.md` for the
enforcement rule and the tests in `tests/unit/compliance-claim-safety.test.ts`
that check a `Certification` row can't claim `CERTIFIED` without the
metadata (`issuer`, `verificationReference`) that would make that claim
checkable.

## Why a dedicated `ComplianceAuditLog` instead of reusing `AuditLog`

`AuditLog.organizationId` is `NOT NULL` with `ON DELETE CASCADE` to
`Organization` — it is tenant-scoped by design, and every existing write
path assumes an organization to attribute the action to
(`src/server/services/audit.ts`'s `audit()` takes
`Pick<TenantContext, "orgId" | "userId">`). Compliance-domain actions have
no organization to cascade from. Rather than weaken `AuditLog`'s NOT NULL
constraint on a working, security-critical, already-shipped table for a
case it wasn't designed for, this phase adds `compliance_audit_log`: same
shape (`actorUserId`, `actorType`, `action`, `resourceType`, `resourceId`,
`before`/`after` JSON, `ip`, `userAgent`, `createdAt`), no organization
column. This mirrors the precedent already set by
`stripe_webhook_events` needing its own ledger rather than being forced
into a tenant-shaped table (see `docs/stripe-webhook-reliability.md`).

`src/server/services/compliance/audit.ts` exports `complianceAudit()`,
deliberately parallel to the existing `audit()` — same call shape minus
`orgId`, same "never throws into the caller's flow" guarantee, same
append-only usage (no service function updates or deletes a
`ComplianceAuditLog` row).

## owner/actor fields are soft references, not FKs

Every `ownerUserId`, `actorUserId`, `createdByUserId`, etc. across this
domain is a plain nullable `String @db.Uuid` column, **not** a Prisma
`@relation` to `User`. Adding a formal relation would require a matching
back-relation array field on `User` for each of the ~15 places this domain
references a user — real schema noise on a small, shared, sensitive model
for what are optional attribution fields, not referential-integrity
requirements. This mirrors the same choice already made for
`StripeWebhookEvent.organizationId`. If a referenced user is deleted, the
UUID becomes an orphaned reference (acceptable for an attribution field);
this is documented here rather than silently assumed.

## What Phase 1 deliberately does not do

See `docs/compliance/OPERATIONS.md` §"Deferred to Phase 2+" for the full
list carried over from Issue #74 Step 25. In architectural terms, the two
most consequential deferrals:

- **No automated destructive deletion.** `RetentionExecution` records
  _that_ a retention decision was made and _what_ happened, but nothing in
  this phase runs a scheduled job that deletes tenant data. `DsrEvent`
  provides an audit trail for erasure _requests_, but fulfilling an erasure
  request today is a manual, audited, cross-service operation — exactly as
  Step 11 instructs ("Phase 1 may establish orchestration and auditable
  workflows before full cross-service deletion automation").
- **No public Trust Center.** The data model is designed so a future public
  surface could read from `Certification`, `Subprocessor` (a curated
  subset), and published `SecurityPolicy` rows — but nothing in this phase
  exposes any of it outside `requireSuperadmin()`. Publishing requires an
  explicit, separate, human-approved step (Step 17).
