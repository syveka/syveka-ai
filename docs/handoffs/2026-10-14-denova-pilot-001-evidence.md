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
| A2  | 2026-10-14 11:06 | `c0972b0` | **PASS**                               | P2 accepted the existing invitation (human step, runbook §1). Verified read-only as P1 at 11:10 UTC; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**A2 is complete only after P2 accepts**: P2 is shown as a Member and the audit log has
`member.join`. Acceptance is a human step by P2; nobody signs in or accepts on P2's behalf.

### A2 acceptance: PASS (2026-10-14 11:06 UTC, `c0972b0`)

P2 used the existing invitation (no resend), signed in as the invited account and pressed Accept;
the owner reports P2 landed in the "DENOVA Pilot 001 (synthetic)" dashboard. Read-only checks as
P1, staging `c0972b0` healthy:

| Check                        | Result       | Evidence                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 is a member               | PASS         | Members page: P1 Owner, P2 (`bushra334a@gmail.com`), two rows only                                                                                                                                                                                                                                                                |
| Role                         | PASS         | P2's role: Member                                                                                                                                                                                                                                                                                                                 |
| Invitation no longer pending | PASS         | Members page shows no pending invitation (before: "Invitation pending · Member")                                                                                                                                                                                                                                                  |
| `member.join`                | PASS         | Audit 14:06:10 Helsinki (11:06:10 UTC), actor P2, `organization_member` `ad71cd8f…`, after `{activeSeats: 2, bookingTypesDisabled: 0}`                                                                                                                                                                                            |
| Correct organization         | PASS         | Audit log and Members page of "DENOVA Pilot 001 (synthetic)" (`b18a7679…`); `org.create` → `member.invite` (`a7647774…`) → `member.join`                                                                                                                                                                                          |
| No duplicates                | PASS         | One membership row for P2, one `member.join`, one `member.invite` (invitations are unique per organization and address)                                                                                                                                                                                                           |
| FREE seats                   | PASS         | 2 of 2 used (`activeSeats: 2`), no other pending invitation                                                                                                                                                                                                                                                                       |
| No organization made by P2   | NOT VERIFIED | Not visible to P1: another organization's audit log is outside this tenant. The Vercel request-log view failed to load ("Something went wrong", 3 attempts). The owner reports P2 went straight to the DENOVA dashboard. Doesn't affect this organization; confirm with the owner whether P2 submitted "Create your organization" |

Invitation token not recorded.

### A2 acceptance: FAIL (2026-10-13 22:32 UTC, `c0972b0`)

P2 opened the invitation link on mobile and saw "Something went wrong / This page could not be
loaded."

**Staging logs** (Vercel, project `syveka-ai-staging`, read-only; token redacted):

| Time (Helsinki) | Request                   | Result                                                                                  |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| 01:32:03        | `GET /invite/<token>`     | 307 to `/en/invite/<token>`                                                             |
| 01:32:04        | `GET /en/invite/<token>`  | 200, no session error logged: the browser was **signed in**, so the page showed Accept  |
| 01:32:05        | `GET /en/login`           | 307 to `/dashboard` (prefetch of the page's "Switch account" link)                      |
| 01:32:06        | `GET /en/invite/<token>`  | 307 to `/register`, `AuthSessionMissingError` (a request without cookies)               |
| 01:32:07        | `POST /en/invite/<token>` | **500** `Error: Invitation was sent to a different email address` (digest `2077601389`) |
| 01:32:16–17     | `GET /en/invite/<token>`  | 307 to `/register`, then `/en/register` 200; no registration followed                   |

**Root cause: CONFIRMED.** Accept was clicked while signed in to an account whose address isn't
P2's. `acceptInvitation` refused it (correctly) by throwing; `acceptInvitationAction` doesn't
catch it, so the server action failed with 500 and `[locale]/error.tsx` showed the generic
message. The page offered Accept without checking the account. Its "Switch account" link goes to
`/login`, which the middleware redirects a signed-in person away from (to `/dashboard`), so
there was no way to switch. Which account was signed in is **unknown**: the logs don't show it.

**State afterwards** (P1's Members page and audit log, 22:40 UTC): one invitation, still
"Invitation pending · Member"; no `member.join`. Nothing was written.

**Relation to #306:** #306 (draft, not in `c0972b0`) carries an invitation through sign-up and
sign-in. It does not handle a browser already signed in to another account, so it doesn't fix
this.

**Fix:** draft #323 (stacked on #306). For another signed-in account, the page names both
addresses and offers "Sign out and continue" instead of Accept. "Switch account" signs out and
returns to the invitation, and a mismatch on Accept returns to the page instead of a 500. Not
merged or deployed.

**Workaround without a deploy** (not yet tried): P2 opens the link in a browser with no Syveka
session (a private window), or signs out of Syveka first. The page then sends P2 to register.
Without #306, P2 must reopen the invitation link after registering and verifying the email.

**A2 status at the time: BLOCKED — FIX READY, REQUIRES MERGE/DEPLOY APPROVAL** (#306 → #323 →
#324, CI green on #323). P2 can still complete A2 earlier with the workaround above, which needs
no deploy or new email. **Superseded:** P2 completed A2 with the workaround on 2026-10-14 (A2
acceptance: PASS, above). The fixes are still needed for real customers.

**Pilot completion after A2:** 2 of 28 (7.1%); Part 1 alone 2 of 26 (7.7%). Next in plan
order: B1.

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
- **F-5, an invitation opened while signed in to another account dead-ends** (UX gap, high for
  onboarding). The person sees a generic error and can't switch accounts. Fix in draft #323.
- **F-6, logged-out traffic is logged as errors** (observability gap, medium). The middleware
  and `getSessionUser` log `AuthSessionMissingError`, the ordinary no-session state, with
  `console.error`. On staging a request to `/` every minute logs one such entry; Vercel counted
  35 error-level entries in the window viewed, and the one real 500 was among them. Recommended fix: don't log
  `AuthSessionMissingError` as an error. Not changed: `middleware.ts` affects every request, so
  this needs its own decision. Also skipped tonight because error and logging hygiene is
  the other Claude account's active work.
- **F-7, the invitation page isn't translated** (UX gap, low). Its text is hardcoded English,
  while the email and the rest of the app follow the organization's language. Fix in draft
  #324 (stacked on #323): en, fi and ar, with the role shown by its label.
- **F-8, an email link opened in another browser loses the invitation** (bug, high for mobile
  onboarding). Supabase's SSR client uses PKCE (`@supabase/ssr` 0.6.1, `flowType: "pkce"`), so a
  verification link only completes in the browser that registered. Elsewhere (typically a
  phone's mail app) `/api/auth/callback` sends the person to `/login?error=auth_callback_failed`;
  the login page ignores the error and the invitation is dropped, so an invitee without an
  organization lands on "Create your organization". Derived from the code, not observed on
  staging. Fix in draft #325 (stacked on #306). The A2 procedure in the runbook avoids it.
- **F-9, a pending invitation can't be cancelled** (product gap, medium). `InviteStatus` has
  `REVOKED`, but nothing in the app sets it and the Members page has no cancel action. A pending
  invitation holds a seat for 7 days, so on FREE (2 seats) a mistaken invitation blocks the
  second seat until it expires. Not implemented (a feature; needs a product decision).
