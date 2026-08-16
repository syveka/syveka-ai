# Security & Compliance Claim Rules

This document exists because getting this wrong is a real business and
legal risk. Read it before writing anything customer-facing, marketing
copy, a security questionnaire answer, or a `Certification` row.

## The five-state claim ladder

Every control and every certification carries a `ClaimVerificationState`:

1. **`TECHNICALLY_IMPLEMENTED`** — the code/process exists. Nobody has
   reviewed it against a framework's requirements yet.
2. **`INTERNALLY_REVIEWED`** — a Syveka team member (or this kind of audit)
   has reviewed the control and judged it adequate. Still not independent.
3. **`EXTERNAL_AUDIT_REQUIRED`** — the control needs independent
   verification before any external claim can be made about it.
4. **`EXTERNALLY_VERIFIED`** — an independent third party has verified this
   specific control (e.g. a penetration test finding remediated and
   re-verified, a vendor's own SOC 2 report covering a control Syveka
   relies on).
5. **`CERTIFIED`** — an accredited body has issued a certification or
   attestation report covering this control (ISO 27001 certificate, SOC 2
   Type II report).

## What Syveka may NOT currently state, anywhere

As of this document (Phase 1, Issue #74), Syveka must not claim, in any
customer-facing material, sales conversation, security questionnaire
response, or public page:

- "ISO 27001 certified"
- "SOC 2 certified" or "SOC 2 compliant"
- "HIPAA certified" or "HIPAA compliant"
- "GDPR certified" (GDPR has no certification scheme to be "certified"
  against in the way ISO/SOC 2 do — this phrase is a category error, not
  just unverified)
- Any equivalent phrasing implying independent attestation that has not
  actually occurred

## What Syveka MAY currently state (if true), with the right framing

- "We have implemented [specific control] as part of our security
  practices" — an `IMPLEMENTED` + `TECHNICALLY_IMPLEMENTED` or
  `INTERNALLY_REVIEWED` claim, framed as engineering fact, not attestation.
- "We are building toward ISO 27001 / SOC 2 readiness" — a readiness
  statement, not a certification claim.
- "[Control] maps to GDPR Article 32 / [ISO domain] / [SOC 2 criterion]" —
  a mapping statement (`ControlFrameworkMapping`), not a certification
  claim.
- Concrete, evidenced answers to specific security-questionnaire questions
  (see `docs/compliance/OPERATIONS.md` §"Security questionnaire readiness")
  — these are factual statements about what exists, not certification
  claims, and are the actual near-term business value of this phase.

## Enforcement

- A `Certification` row may only be created/updated to
  `verificationState = CERTIFIED` when `issuer` and
  `verificationReference` are both populated — enforced in
  `src/server/services/compliance/certifications.ts`, covered by
  `tests/unit/compliance-claim-safety.test.ts` ("cannot mark a certification
  CERTIFIED without issuer and verification reference").
- No seed data, fixture, or migration in this repository creates a
  `Certification` row claiming `EXTERNALLY_VERIFIED` or `CERTIFIED` — Phase
  1 ships the _table_, not a certificate. Populating a real certification
  record requires an actual certificate/report in hand.
- Any future public Trust Center (Step 17, explicitly deferred) must read
  claim state from these fields, not from marketing copy maintained
  separately — see `docs/compliance/OPERATIONS.md`.

## Who can override this

Nobody, without the actual underlying fact changing. If Syveka completes a
real ISO 27001 audit, update the relevant `Certification` row with the real
`issuer`, `issueDate`, `verificationReference`, and only then may
`CERTIFIED` claims be made — and even then, scope the claim to what the
certificate's `scope` field actually covers.
