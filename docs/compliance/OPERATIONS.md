# Trust & Compliance — Operations

How this domain gets used day-to-day, and what's explicitly not built yet.

## Security questionnaire readiness

Issue #74's core near-term business goal is answering Finnish/EU enterprise
customer security questions with real, verified answers instead of
marketing assumptions. Once the registers below are populated (a follow-up
operational task, not part of this PR), each of these questions has a
concrete source:

| Question                                        | Source                                                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where is customer data stored?                  | `Subprocessor.region` / `dataResidency` (once populated — currently unpopulated, see `docs/compliance/FINLAND_BASELINE.md` G7)                                                                              |
| Who can access customer data?                   | `src/server/auth/rbac.ts` (5-role matrix) + `src/server/auth/superadmin.ts`, evidenced by `AccessReview` rows                                                                                               |
| How is tenant isolation implemented?            | `docs/compliance/ARCHITECTURE.md`, `src/server/db/tenant.ts`, `tests/rls/*`                                                                                                                                 |
| Are privileged actions logged?                  | `AuditLog` (tenant actions), `ComplianceAuditLog` (platform actions)                                                                                                                                        |
| How are incidents handled?                      | `SecurityIncident` / `IncidentEvent` (process exists; no incident runbook document yet — a gap, see `FINLAND_BASELINE.md` I6)                                                                               |
| How are subprocessors tracked?                  | `Subprocessor` (table exists; unpopulated)                                                                                                                                                                  |
| How are access rights reviewed?                 | `AccessReview` (table exists; no reviews recorded yet)                                                                                                                                                      |
| How is data deleted?                            | `DataSubjectRequest` / `DsrEvent` for subject-initiated erasure; `RetentionPolicy` / `RetentionExecution` for scheduled retention (neither populated; no automated deletion — manual, audited process only) |
| How are vulnerabilities/dependencies monitored? | `.github/workflows/ci.yml` (`npm audit --omit=dev --audit-level=high`, blocking on every PR)                                                                                                                |
| What certifications exist?                      | `Certification` (table exists; **zero rows** — Syveka holds no certifications as of this phase)                                                                                                             |
| Which controls are implemented?                 | `ComplianceControl` (table exists; unpopulated — populate from `FINLAND_BASELINE.md`'s own findings as the first operational task)                                                                          |
| Which claims have independent verification?     | `ComplianceControl.verificationState` / `Certification.verificationState` — currently nothing is beyond `INTERNALLY_REVIEWED` at best                                                                       |

**Honest current state**: the schema and service layer exist and are
tested; the registers are not yet populated with Syveka's real operational
data. Answering a real customer questionnaire today should still cite the
underlying engineering facts (RLS, RBAC, audit logs, CI gates — all real
and verifiable in this repository) rather than the as-yet-empty compliance
tables.

## Populating the registry (first operational task, not part of this PR)

1. Seed `ComplianceControl` + `ControlFrameworkMapping` rows from
   `docs/compliance/FINLAND_BASELINE.md`'s own table rows — each line item
   there is close to a ready-made control record.
2. Seed `Subprocessor` rows for Supabase, Stripe, Vercel, Resend, Vapi,
   QStash, Anthropic, and OpenAI — from actual vendor DPAs/documentation,
   not assumption. Leave `internationalTransfer`/`dpaStatus` as `UNKNOWN`
   until verified.
3. Seed `ProcessingRecord` rows for the major processing activities (CRM
   contacts, calendar/booking, AI chat + RAG, voice/Vapi, inbox/email,
   billing/Stripe).
4. Run one real `AccessReview` covering current superadmin + org-owner
   accounts as a live test of the workflow.

## Deferred to Phase 2+ (Issue #74 Step 25, explicit)

Not built in this phase, by design:

- Actual ISO 27001 certification / SOC 2 audit / external penetration test
  / external legal opinion
- A Vanta (or equivalent) subscription
- Public Trust Center UI polish (the data model supports it later; nothing
  is exposed publicly now)
- Full security-questionnaire automation
- Full vendor API integrations / automatic evidence ingestion from every
  SaaS provider
- HIPAA-specific product workflows
- Complex GRC workflow/approval-chain engines
- Enterprise multi-step policy approval chains beyond
  `SecurityPolicy.status` + `approvedByUserId`/`approvedAt`
- **Automated destructive data deletion** — `RetentionExecution` records
  eligibility and outcome; nothing runs a scheduled job that actually
  deletes tenant data. Erasure requests (`DataSubjectRequest`) are
  fulfilled manually today, with an audit trail, until cross-service
  deletion is proven safe.
- Production deployment of any kind (out of scope for a Draft PR)

## Ownership boundaries — what needs what kind of review

| Category                                                                            | Who                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engineering work (this PR: schema, services, tests, docs)                           | Done here                                                                                                                                                 |
| Operational work (populating registers, running reviews)                            | Syveka ops, follow-up                                                                                                                                     |
| Legal review (NIS2 applicability, DPA adequacy, breach-notification determinations) | Outside engineering's authority — `NotificationRequirement.UNKNOWN` and similar fields exist specifically so engineering never makes this call implicitly |
| External audit/certification (ISO 27001, SOC 2)                                     | An accredited third party, when Syveka is ready to pursue it                                                                                              |
| Deployment                                                                          | A separate protected action per `CLAUDE.md` §9 — not performed as part of this work                                                                       |

## Incident runbook — explicit gap

`SecurityIncident` gives incident _tracking_; it is not itself an incident
_response runbook_ (who gets paged, escalation paths, communication
templates). That gap is named here rather than silently left implicit —
see `FINLAND_BASELINE.md` I6.
