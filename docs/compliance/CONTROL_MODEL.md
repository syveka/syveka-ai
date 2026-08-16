# Compliance Control Model — Reference

Field-level reference for the models added in
`prisma/migrations/20260815010000_compliance_foundation_phase1/`. For the
_why_ behind these choices, see `docs/compliance/ARCHITECTURE.md`.

## ComplianceControl

The one reusable control record (Step 4). Critical distinction, enforced by
having two separate enum fields rather than one boolean:

- `implementationStatus` (`ControlImplementationStatus`): is it built?
  `IMPLEMENTED` / `PARTIAL` / `MISSING` / `NOT_APPLICABLE` /
  `EXTERNAL_VERIFICATION_REQUIRED`.
- `verificationState` (`ClaimVerificationState`): how verified is that
  claim? `TECHNICALLY_IMPLEMENTED` / `INTERNALLY_REVIEWED` /
  `EXTERNAL_AUDIT_REQUIRED` / `EXTERNALLY_VERIFIED` / `CERTIFIED`.

A control can be `IMPLEMENTED` + `TECHNICALLY_IMPLEMENTED` (built, never
reviewed), `IMPLEMENTED` + `INTERNALLY_REVIEWED` (built, someone checked
it), or `IMPLEMENTED` + `CERTIFIED` (built, and an external body attests to
it) — three meaningfully different claims that a single `compliant: true`
boolean would erase.

`category` is one of 13 `ControlCategory` values (governance, access
control, data protection, cryptography, logging/monitoring, incident
management, business continuity, supplier risk, secure development,
physical/environmental, human resources, asset management, network
security) — Syveka's own vocabulary, loosely informed by common security
domains, not a reproduction of any standard's clause structure.

## ControlFrameworkMapping

`(controlId, framework, frameworkReference)` unique triple. `framework` is
one of `GDPR` / `ISO27001` / `NIS2` / `SOC2` / `HIPAA`. `frameworkReference`
is a short internal string (e.g. `"access control"`), never a copied
standard clause.

## ComplianceEvidence

A _reference_ to evidence, never the evidence payload:

- `sourceType`: `CI_RUN` / `TEST_SUITE` / `SECURITY_SCAN` /
  `DEPENDENCY_AUDIT` / `SECRET_SCAN` / `RLS_TEST` / `MIGRATION` /
  `AUDIT_LOG` / `ACCESS_REVIEW` / `POLICY_DOCUMENT` / `VENDOR_REVIEW` /
  `MANUAL_ATTESTATION` / `OTHER`.
- `sourceIdentifier`: a CI run URL, a test file path, a migration name —
  something a human can go look up, not a copy of its content.
- `contentHash`: optional SHA-256 for tamper-evidence, without storing the
  underlying content.
- `summary`: short human text.
- `resultStatus`: `PASS` / `FAIL` / `PARTIAL` / `NOT_APPLICABLE` /
  `UNKNOWN`.
- `reviewDueAt`: freshness — evidence goes stale.

**Never** store secrets, access tokens, API keys, raw request/response
bodies, or unnecessary PII as evidence. If evidence would require that, cite
where the real record lives (a specific `AuditLog`/`ComplianceAuditLog` row
id, a CI run URL) instead of duplicating it.

## ComplianceRisk

Likelihood × impact, both `RiskLevel` (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`,
four levels, no invented precision beyond that). `inherentRiskLevel` is the
risk before mitigation; `residualRiskLevel` is after. `mitigationControlId`
optionally links to the `ComplianceControl` that reduces it. This is a
simple, defensible matrix — not a quantitative risk model. Documented here
precisely so nobody adds fake decimal precision later.

## SecurityPolicy / PolicyAcknowledgement

Version + status tracking only (`DRAFT`/`APPROVED`/`PUBLISHED`/`RETIRED`).
`documentRef` points at the policy text (a repo path or external URL) — the
policy body itself is not duplicated into the database. This is
deliberately not a document-management product (Step 7).

## SecurityIncident / IncidentEvent

`IncidentEvent` is append-only: the service layer
(`src/server/services/compliance/incidents.ts`) exposes
`addIncidentEvent()` but no update/delete for existing events, so an
incident's timeline cannot be silently rewritten.

`notificationRequired` defaults to `NotificationRequirement.UNKNOWN` and is
**never** set automatically — Step 8 is explicit that legal notification
applicability is a human (ideally legal) review decision.
`notificationEarlyWarningDueAt` / `notificationAuthorityDueAt` /
`notificationFinalReportDueAt` are plain nullable timestamps the service
layer can populate with whatever deadline a reviewer determines applies
(e.g. GDPR's 72-hour authority notification, or a NIS2 24-hour early
warning) — the schema does not hard-code which regime's clock applies.

## Subprocessor

`UNKNOWN` is a first-class value on `internationalTransfer`, `dpaStatus`,
and `securityReviewStatus` — the default for every field until someone
verifies it against a real signed agreement or vendor documentation. Never
populate a `Subprocessor` row with an assumed fact.

## ProcessingRecord (ROPA)

`lawfulBasis` is one of six `LawfulBasis` values — consent is one option,
never the default or the only modeled basis. `retentionPeriod` is free text
("36 months"), not a structured duration, matching Step 6's "no invented
precision" instruction for something that's often genuinely qualitative in
practice ("until the contract ends plus statutory limitation period").

## DataSubjectRequest / DsrEvent

`identityVerificationStatus` and `status` are separate fields —
authorization/authentication of the requester is tracked distinctly from
request-processing status. `deadlineAt` is computed by the service layer at
creation time (see `src/server/services/compliance/dsr.ts`), not hard-coded
into the schema, so the 30-day GDPR default (or a shorter internal SLA) is
an application-layer decision, adjustable without a migration.

`DsrEvent` is append-only, same pattern as `IncidentEvent`.

## RetentionPolicy / RetentionExecution

`RetentionPolicy` defines periods; `RetentionExecution` _records_ that a
retention/deletion decision was made or carried out — it is evidence, not
the deletion mechanism. Phase 1 does not run scheduled destructive
deletion; see `docs/compliance/OPERATIONS.md`.

## PrivacySecurityAssessment

A lightweight DPIA-triggering record, not a full DPIA workflow product.
`dpiaRequired` (`UNKNOWN`/`NOT_REQUIRED`/`REQUIRED`/`IN_PROGRESS`/`COMPLETE`)
is set by a human reviewer, never inferred.

## AccessReview

Evidence that a periodic review of privileged access happened. Reads
existing RBAC/superadmin state at query time (via `unscopedPrisma` +
`app_metadata.is_superadmin`, the same data the app already uses to
authorize) — this model does not duplicate authorization data, only
records that a review occurred and what it found
(`findingsSummary`, `staleAccessFound`, `actionsTaken`).

## Certification

Represents a real, externally-issued certificate or report. Creating a row
with `verificationState = CERTIFIED` without `issuer` and
`verificationReference` populated is a documentation violation of
`docs/compliance/SECURITY_CLAIMS.md`, enforced by application-layer
validation in `src/server/services/compliance/certifications.ts`
(the database itself cannot verify an external fact) and covered by
`tests/unit/compliance-claim-safety.test.ts`.

## ComplianceAuditLog

Append-only. See `docs/compliance/ARCHITECTURE.md` for why this is a
dedicated table rather than a reuse of `AuditLog`.
