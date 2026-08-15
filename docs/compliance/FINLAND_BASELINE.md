# Syveka — Finland/EU Trust & Compliance Baseline

Status: **Phase 1 foundation** (Issue #74). This document is Syveka's internal
compliance/readiness source of truth. It is **not** a certification, **not**
a legal opinion, and **not** a claim that Syveka is certified against any
framework listed below. See `docs/compliance/SECURITY_CLAIMS.md` for the
rules governing what can and cannot be stated publicly.

Syveka targets Finnish/EU SMEs first. This baseline is scoped to what that
requires: GDPR compliance as a data controller/processor, security practices
that stand up to enterprise procurement review, and a documented path toward
ISO 27001 and SOC 2 readiness. NIS2 applicability is assessed, not assumed.
HIPAA is mapped only for architectural awareness of a possible future US
healthcare vertical — it is explicitly **not** a Finland-baseline requirement.

## How to read this document

Every control below is one of:

| Status                           | Meaning                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMPLEMENTED`                    | The technical/organizational control exists in the codebase or an operational process, with repository evidence.                                                                                   |
| `PARTIAL`                        | Some of the control exists; a real gap remains.                                                                                                                                                    |
| `MISSING`                        | The control does not exist yet.                                                                                                                                                                    |
| `NOT_APPLICABLE`                 | The control's underlying risk does not apply to Syveka's current architecture/scale.                                                                                                               |
| `EXTERNAL_VERIFICATION_REQUIRED` | The control may exist, but confirming it requires a fact this document cannot verify from the repository alone (a vendor's DPA, a region setting in a third-party console, a legal determination). |

These are **implementation/readiness** states, never certification states.
Whether a control has been _independently audited_ is a separate axis —
see `ComplianceControl.verificationState` in
`docs/compliance/CONTROL_MODEL.md` and `docs/compliance/SECURITY_CLAIMS.md`.

Evidence cited as "PR #NN" or "commit" is git history, not a live feed —
verify current state with `git log`/the running code before relying on a
stale line item here.

## GDPR / EU privacy

| #   | Requirement                                                                                | Status                              | Location                                                                                                                                       | Evidence                                                              | Gap                                                                                                                                                                     | Next action                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Access control enforced server-side, not client-trusted                                    | IMPLEMENTED                         | `src/server/db/tenant.ts` (`tenantDb(orgId)`), `src/server/auth/rbac.ts` (`requirePermission`)                                                 | `tests/rls/*`, `tests/unit/tenant-models-coverage.test.ts`            | None found in this audit                                                                                                                                                | Keep the `TENANT_MODELS` drift-guard test current as new models ship                                                                                                                             |
| G2  | Data minimization / purpose limitation in AI processing                                    | PARTIAL                             | `docs/AI-RAG-AUDIT.md`, `src/server/services/ai/*`                                                                                             | AI chat streaming is moderated before flush (per `docs/DECISIONS.md`) | No formal per-feature "data sent to AI provider" inventory exists yet                                                                                                   | Populate `ProcessingRecord` for each AI feature (chat, RAG, business-DNA extraction)                                                                                                             |
| G3  | Records of processing activities (ROPA)                                                    | MISSING (schema now exists)         | `prisma/schema.prisma` (`ProcessingRecord`)                                                                                                    | This PR's migration                                                   | No records populated yet — the table is new                                                                                                                             | Operational task: populate ROPA entries for CRM, calendar, inbox, AI chat, voice (Vapi), billing (Stripe) processing activities                                                                  |
| G4  | Lawful basis tracked per processing activity, consent is not the default                   | IMPLEMENTED (model), MISSING (data) | `ProcessingRecord.lawfulBasis` (6-value enum: consent is one of six)                                                                           | Schema design in this PR                                              | No populated records yet                                                                                                                                                | Same as G3                                                                                                                                                                                       |
| G5  | Data-subject rights: access/export/rectification/erasure/restriction/objection/portability | MISSING (workflow now exists)       | `DataSubjectRequest`, `DsrEvent`                                                                                                               | This PR's migration + service layer                                   | No production intake channel (email/form) wired to create requests yet; no automated cross-service deletion                                                             | Wire an intake path (Phase 2); keep deletion manual/audited until proven safe (explicitly deferred per Issue #74 Phase 1 scope)                                                                  |
| G6  | Retention periods defined per data category                                                | MISSING (schema now exists)         | `RetentionPolicy`, `RetentionExecution`                                                                                                        | This PR's migration                                                   | No policies populated; no automated retention enforcement (deliberately deferred)                                                                                       | Operational task: define retention periods per data category (contacts, messages, documents, audit logs, voice recordings)                                                                       |
| G7  | Processor/subprocessor tracking                                                            | MISSING (schema now exists)         | `Subprocessor` model                                                                                                                           | This PR's migration                                                   | Supabase, Stripe, Vercel, Resend, Vapi, QStash, Anthropic, OpenAI are not yet entered; DPA/region/transfer-safeguard status is `UNKNOWN` for all of them until verified | Populate `Subprocessor` rows for each vendor from actual signed DPAs/vendor documentation — do not guess                                                                                         |
| G8  | International transfer safeguards (SCC/adequacy) tracked                                   | MISSING (schema now exists)         | `Subprocessor.internationalTransfer`                                                                                                           | This PR's migration                                                   | Same as G7 — `TransferSafeguard.UNKNOWN` is the correct default until verified                                                                                          | Legal/ops review of each subprocessor's transfer basis                                                                                                                                           |
| G9  | Breach/incident records with notification-deadline tracking                                | MISSING (schema now exists)         | `SecurityIncident` (24h/72h/final-report deadline fields, `NotificationRequirement.UNKNOWN` default)                                           | This PR's migration                                                   | No incidents recorded (none known); notification applicability is explicitly never auto-inferred                                                                        | Keep `notificationRequired` at `UNKNOWN` until a human (ideally with legal input) reviews a real incident                                                                                        |
| G10 | DPIA workflow for high-risk/new processing                                                 | MISSING (schema now exists)         | `PrivacySecurityAssessment`                                                                                                                    | This PR's migration                                                   | No assessments recorded yet                                                                                                                                             | Run one for the next new AI feature or integration as a live test of the workflow                                                                                                                |
| G11 | Consent records only where consent is the actual lawful basis                              | IMPLEMENTED (model-level guardrail) | `LawfulBasis` enum has 6 values, `ProcessingRecord` doesn't assume consent                                                                     | This PR's migration                                                   | N/A                                                                                                                                                                     | —                                                                                                                                                                                                |
| G12 | Accountability / evidence that controls exist                                              | PARTIAL                             | `ComplianceEvidence`, existing CI (tests, lint, audits, secret scan)                                                                           | CI workflow `.github/workflows/ci.yml` (17 jobs), PR #72              | Evidence rows aren't yet linked from CI to `ComplianceEvidence`                                                                                                         | Phase 2: a CI step that writes evidence rows automatically (deferred per Issue #74 Step 25 — "full vendor API integrations... automatic evidence ingestion" explicitly out of scope for Phase 1) |
| G13 | Privacy by design/default                                                                  | PARTIAL                             | RLS-enabled-zero-policy pattern used consistently (`stripe_webhook_events`, and every table in this PR); `tenantDb()` auto-injects org scoping | `prisma/schema.prisma`, `tests/rls/*`                                 | No formal privacy-by-design checklist gating new features                                                                                                               | Consider a lightweight PR checklist item referencing `PrivacySecurityAssessment`                                                                                                                 |

## ISO/IEC 27001 readiness

No ISO standard text is reproduced here or anywhere in this repository —
descriptions below are Syveka's own, mapped by `ControlCategory` in
`ControlFrameworkMapping`, not copied clause numbers.

| #   | Area                                                                                 | Status                      | Location                                                                                                           | Evidence                                                     | Gap                                                                                                                  |
| --- | ------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| I1  | Governance: documented engineering charter and decision log                          | IMPLEMENTED                 | `CLAUDE.md`, `docs/DECISIONS.md`                                                                                   | Both files, actively maintained                              | None                                                                                                                 |
| I2  | Access control: RBAC + superadmin separation                                         | IMPLEMENTED                 | `src/server/auth/rbac.ts` (5-role matrix), `src/server/auth/superadmin.ts`                                         | `docs/DECISIONS.md` ("Superadmin is a separate axis")        | No periodic access-review evidence recorded yet — `AccessReview` model is new                                        |
| I3  | Asset/data awareness                                                                 | PARTIAL                     | `docs/DATABASE-AUDIT.md`, `prisma/schema.prisma`                                                                   | Existing docs                                                | Docs are dated to a prior audit pass; not continuously refreshed                                                     |
| I4  | Secure development: CI gates (lint, typecheck, tests, dependency audit, secret scan) | IMPLEMENTED                 | `.github/workflows/ci.yml`                                                                                         | 17 required CI jobs, all currently green on `main`           | None found                                                                                                           |
| I5  | Change management: PR review, migration-history checksums, CI required-checks gate   | IMPLEMENTED                 | `scripts/check-migration-history.mjs`, branch protection (external to repo, not independently verified here)       | `migrations:check`, this PR's own process                    | Branch-protection _enforcement_ is a GitHub setting, not verifiable from the repo — `EXTERNAL_VERIFICATION_REQUIRED` |
| I6  | Incident management                                                                  | PARTIAL                     | `SecurityIncident`/`IncidentEvent` (new), no prior formal process documented                                       | This PR's migration                                          | No incident response runbook exists yet                                                                              |
| I7  | Supplier/vendor risk                                                                 | MISSING (schema now exists) | `Subprocessor`                                                                                                     | This PR's migration                                          | Same as G7                                                                                                           |
| I8  | Logging/monitoring                                                                   | PARTIAL                     | `AuditLog` (tenant-scoped), `ComplianceAuditLog` (platform-scoped, new)                                            | `src/server/services/audit.ts`                               | No centralized security-event monitoring/alerting found in this audit                                                |
| I9  | Continuity/recovery evidence                                                         | PARTIAL                     | `docs/release-runbook.md` documents a backup/PITR procedure and a required restore test before production releases | `docs/release-runbook.md` §"Production preflight and backup" | No evidence artifact showing a restore test was actually executed and recorded                                       |
| I10 | Security policies                                                                    | MISSING (schema now exists) | `SecurityPolicy`, `PolicyAcknowledgement`                                                                          | This PR's migration                                          | No policies exist yet; `CLAUDE.md` functions as a de facto engineering policy but isn't versioned through this model |
| I11 | Periodic review / evidence management                                                | MISSING (schema now exists) | `ComplianceEvidence`, `AccessReview`                                                                               | This PR's migration                                          | No reviews recorded yet                                                                                              |

**Certification boundary**: Syveka is not ISO 27001 certified and this
document does not claim otherwise. Certification requires an accredited
external auditor. See `docs/compliance/SECURITY_CLAIMS.md`.

## NIS2 / Finnish implementation readiness

NIS2 applicability depends on sector, size, and role (operator of essential
services vs. important entity vs. out of scope) — **this repository cannot
determine Syveka's own NIS2 applicability**, and this document does not
assert it. That determination requires legal review.

Readiness _capability_, independent of applicability, is tracked below:

| #   | Capability                                              | Status                           | Location                                                                                                                                                                                 | Gap                                                                              |
| --- | ------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| N1  | Risk-management evidence                                | MISSING (schema now exists)      | `ComplianceRisk`                                                                                                                                                                         | No risks recorded yet                                                            |
| N2  | Incident management with notification-deadline tracking | MISSING (schema now exists)      | `SecurityIncident` (`notificationEarlyWarningDueAt` / `notificationAuthorityDueAt` / `notificationFinalReportDueAt` — configurable, not hard-coded 24h/72h assumptions baked into logic) | Deadlines must be computed and reviewed per real incident, not templated blindly |
| N3  | Supply-chain security                                   | MISSING (schema now exists)      | `Subprocessor`                                                                                                                                                                           | Same as G7                                                                       |
| N4  | Vulnerability handling                                  | IMPLEMENTED                      | CI dependency audit (`npm audit --omit=dev --audit-level=high`, blocking), Dependabot-equivalent not independently verified                                                              | `.github/workflows/ci.yml`                                                       |
| N5  | Access control                                          | IMPLEMENTED                      | Same as I2                                                                                                                                                                               | —                                                                                |
| N6  | Continuity                                              | PARTIAL                          | Same as I9                                                                                                                                                                               | —                                                                                |
| N7  | Governance                                              | IMPLEMENTED                      | Same as I1                                                                                                                                                                               | —                                                                                |
| N8  | Applicability/legal determination                       | `EXTERNAL_VERIFICATION_REQUIRED` | —                                                                                                                                                                                        | Requires legal review; this document takes no position                           |

## SOC 2 mapping

SOC 2 is not a Finland-baseline requirement; it is mapped so a future
enterprise (especially US-facing) customer can see readiness. **Syveka is
not SOC 2 certified or "SOC 2 compliant."** A SOC 2 report requires an
independent auditor's attestation over an observation period — it cannot be
self-declared.

| Trust Service Criterion (informal mapping) | Status                           | Evidence                                                                                                     |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Security (CC-series, informal)             | PARTIAL                          | RBAC, superadmin gate, RLS-zero-policy pattern, audit logs, CI security gates                                |
| Availability                               | `EXTERNAL_VERIFICATION_REQUIRED` | Depends on hosting-provider SLAs (Vercel/Supabase) not independently verified here                           |
| Processing integrity                       | PARTIAL                          | PR #72's durable Stripe webhook idempotency ledger is a concrete example of processing-integrity engineering |
| Confidentiality                            | PARTIAL                          | Tenant isolation via `tenantDb()`, RLS; no data classification scheme found                                  |
| Privacy                                    | PARTIAL                          | See GDPR section above                                                                                       |

## HIPAA (deferred, architectural mapping only)

HIPAA is **not** implemented, **not** assessed for applicability, and
**not** a Finland-baseline requirement. Per Issue #74's explicit scope, this
phase does nothing HIPAA-specific beyond noting that the same underlying
control model (`ComplianceFramework.HIPAA` exists as an enum value) could
carry a future HIPAA mapping without a schema rewrite, if Syveka ever
pursues a US healthcare vertical. No HIPAA-specific workflows, Business
Associate Agreement tracking, or PHI-specific safeguards were built in this
phase.

## Summary

Phase 1 delivers the **domain layer and documentation foundation**, not a
populated compliance program. Every register above exists and is tested for
tenant isolation, authorization, and claim safety (see
`docs/compliance/CONTROL_MODEL.md`); almost none of them yet contain real
operational data — that population is explicit follow-up work (see
`docs/compliance/OPERATIONS.md` §"Deferred to Phase 2+").
