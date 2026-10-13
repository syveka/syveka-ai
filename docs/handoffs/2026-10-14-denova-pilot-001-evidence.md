# DENOVA Pilot #001: execution evidence

Companion to `2026-10-13-denova-pilot-001-test-plan.md`. Staging only, synthetic organization
"DENOVA Pilot 001 (synthetic)" (`b18a7679…`), internal accounts P1 (OWNER) and P2 (MEMBER).
Times are UTC unless marked.

## Staging baseline

| Date       | SHA                                        | Release run                         | Note                                                                                                                          |
| ---------- | ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-13 | `526f3779d5c6a551f015fd6b07e3bd0bbdaf7150` | 38294065687 (#140)                  | Original plan baseline; A1 and the first A2 attempt ran here                                                                  |
| 2026-10-13 | `c0972b01740e294a9327ec359d8af6f0929a78b4` | 38458876164 (#142), all steps green | **Re-baselined, owner-approved 2026-10-13.** Diff from `526f377` is `tests/e2e/smoke.spec.ts` only (#318); app code identical |

Release #141 (38419326935, `526f377`) failed in the smoke tests: the E2E fixture organization
had reached the FREE 200-contact limit. Fixed by #318; it never deployed the stable alias.

## Results

| #   | When (UTC)       | SHA       | Result                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------- | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 2026-10-13 10:13 | `526f377` | PASS                                   | Org created; audit `org.create` 10:13:36                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A2  | 2026-10-13 10:14 | `526f377` | FAIL                                   | UI "The invitation could not be sent"; log `invite_member_failed` / `EmailSendError`; no `member.invite` audit. Cause: staging `EMAIL_FROM` used Resend's testing sender (`onboarding@resend.dev`), refused by Resend (403). The owner changed staging `EMAIL_FROM` to `no-reply@mail.syveka.com` (staging project, Production environment). The invitation row stayed `PENDING` and the Members page showed "Invitation pending" although no email was sent                                                                                                                    |
| A2  | 2026-10-13 22:12 | `c0972b0` | PASS (invite sent; acceptance pending) | One owner-approved retry, one send attempt. Precheck: `/api/health` healthy, build `c0972b0` (22:11:35); org "DENOVA Pilot 001 (synthetic)"; recipient P2; role Member. UI "Invitation sent."; Members page still one pending invitation for P2 (re-invite updates the existing row; no duplicate). Audit `member.invite` 01:12:19 Helsinki (22:12:19 UTC), invitation `a7647774…`. Resend email `01a13752-dac1-742f-b4d9-8c3b31fa1f24`: `POST /emails`, Sent then Delivered at 22:12 UTC, from `Syveka AI <no-reply@mail.syveka.com>`, the only email to P2 in the 15-day list |

**A2 is complete only after P2 accepts**: P2 is shown as a Member and the audit log has
`member.join`. Acceptance is a human step by P2; nobody signs in or accepts on P2's behalf.

## Findings

- **F-1, invitation failure is invisible.** After a failed send, the Members page shows
  "Invitation pending", the same as for a delivered invitation, and no audit row records the
  attempt. An owner would wait for an email that never arrives. This is covered by the
  invitation-hardening proposal, which is not implemented.
- **F-2, no check catches a bad sender configuration.** Resend's testing sender passed every
  release check and failed only at a user's first invitation.
- **F-3, Preview has no `EMAIL_FROM`.** This is a recorded follow-up; nothing was changed.
- **F-4, shared E2E data could block a release.** Leftover smoke-test contacts filled the E2E
  organization's contact limit. Fixed by #318.
