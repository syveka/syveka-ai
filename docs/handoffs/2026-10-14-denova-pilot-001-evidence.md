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

| #   | When (UTC)        | SHA       | Result                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------- | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 2026-10-13 10:13  | `526f377` | PASS                                   | Org created; audit `org.create` 10:13:36                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A2  | 2026-10-13 10:14  | `526f377` | FAIL                                   | UI "The invitation could not be sent"; log `invite_member_failed` / `EmailSendError`; no `member.invite` audit. Cause: staging `EMAIL_FROM` used Resend's testing sender (`onboarding@resend.dev`), refused by Resend (403). The owner changed staging `EMAIL_FROM` to `no-reply@mail.syveka.com` (staging project, Production environment). The invitation row stayed `PENDING` and the Members page showed "Invitation pending" although no email was sent                                                                                                                    |
| A2  | 2026-10-13 22:12  | `c0972b0` | PASS (invite sent; acceptance pending) | One owner-approved retry, one send attempt. Precheck: `/api/health` healthy, build `c0972b0` (22:11:35); org "DENOVA Pilot 001 (synthetic)"; recipient P2; role Member. UI "Invitation sent."; Members page still one pending invitation for P2 (re-invite updates the existing row; no duplicate). Audit `member.invite` 01:12:19 Helsinki (22:12:19 UTC), invitation `a7647774…`. Resend email `01a13752-dac1-742f-b4d9-8c3b31fa1f24`: `POST /emails`, Sent then Delivered at 22:12 UTC, from `Syveka AI <no-reply@mail.syveka.com>`, the only email to P2 in the 15-day list |
| A2  | 2026-10-14 11:06  | `c0972b0` | **PASS**                               | P2 accepted the existing invitation (human step, runbook §1). Verified read-only as P1 at 11:10 UTC; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B1  | 2026-10-14 11:19  | `c0972b0` | **PASS**                               | Business DNA created and persisted after reload; one `business_dna.create`; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B2  | 2026-10-14 11:29  | `c0972b0` | **PASS**                               | 2 services created, 1 deactivated; persisted after reload; audit 2 × `.create`, 1 × `.deactivate`; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B3  | 2026-10-14 11:49  | `c0972b0` | **PASS**                               | Stale save from a second tab refused; tab 1's value kept; exactly one `business_dna.update`; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B4  | 2026-10-14 ~12:00 | `c0972b0` | **PASS**                               | P2 (MEMBER) sees Business DNA read-only; no new audit row; details below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**A2 is complete only after P2 accepts**: P2 is shown as a Member and the audit log has
`member.join`. Acceptance is a human step by P2; nobody signs in or accepts on P2's behalf.

### A2 acceptance: PASS (2026-10-14 11:06 UTC, `c0972b0`)

P2 used the existing invitation (no resend), signed in as the invited account and pressed Accept;
the owner reports P2 landed in the "DENOVA Pilot 001 (synthetic)" dashboard. Read-only checks as
P1, staging `c0972b0` healthy:

| Check                        | Result                | Evidence                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 is a member               | PASS                  | Members page: P1 Owner, P2 (`bushra334a@gmail.com`), two rows only                                                                                                                                                                                                                                                                             |
| Role                         | PASS                  | P2's role: Member                                                                                                                                                                                                                                                                                                                              |
| Invitation no longer pending | PASS                  | Members page shows no pending invitation (before: "Invitation pending · Member")                                                                                                                                                                                                                                                               |
| `member.join`                | PASS                  | Audit 14:06:10 Helsinki (11:06:10 UTC), actor P2, `organization_member` `ad71cd8f…`, after `{activeSeats: 2, bookingTypesDisabled: 0}`                                                                                                                                                                                                         |
| Correct organization         | PASS                  | Audit log and Members page of "DENOVA Pilot 001 (synthetic)" (`b18a7679…`); `org.create` → `member.invite` (`a7647774…`) → `member.join`                                                                                                                                                                                                       |
| No duplicates                | PASS                  | One membership row for P2, one `member.join`, one `member.invite` (invitations are unique per organization and address)                                                                                                                                                                                                                        |
| FREE seats                   | PASS                  | 2 of 2 used (`activeSeats: 2`), no other pending invitation                                                                                                                                                                                                                                                                                    |
| No organization made by P2   | PASS (human-observed) | First not verifiable from P1 (another organization's audit log is outside this tenant; the Vercel request-log view failed to load, 3 attempts). The owner then confirmed: the "Create your organization" page appeared during P2's sign-up, but it was not filled in and Create was not pressed; P2 returned to the invitation and accepted it |

Invitation token not recorded.

### B1 Business DNA saves and persists: PASS (2026-10-14 11:19 UTC, `c0972b0`)

Owner-approved, B1 only. P1 in "DENOVA Pilot 001 (synthetic)", Settings → Business DNA.

**Before:** no Business DNA ("You haven't set up your Business DNA yet", every field empty); no
voice assistants (so the save's assistant re-sync had nothing to call); audit log `org.create`,
`member.invite`, `member.join` only.

**Values written** (synthetic; other fields left empty, opening hours the form's default of every
day closed):

| Field               | Value                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Display name        | DENOVA Demo Studio                                                                                |
| Industry            | Photo & video studio                                                                              |
| Short description   | PILOT-001 synthetic test profile: a fictional photo and video studio used for staging tests only. |
| Brand tone          | Friendly and professional                                                                         |
| Communication style | Short, clear answers                                                                              |
| Booking policy      | PILOT-001: Book online at least 48 hours in advance.                                              |
| Payment policy      | PILOT-001: Payment is due on the day of the session.                                              |
| Currency            | EUR                                                                                               |
| Pricing notes       | PILOT-001: Portrait session from 150 EUR. Video packages are quoted per project.                  |

Cancellation policy was left empty on purpose so that C3 ("24 h notice" via chat) is a clean
first value.

**Save:** one Save; the form showed "Saved."

**After reload:** the setup notice is gone and the form's submitted values match the table exactly,
with no other field set.

**Audit:** one new row, `business_dna.create`, 14:19:50 Helsinki (11:19:50 UTC), actor P1,
`business_dna` `2ae05708…`. No other new rows (no `.update`, no duplicate).

### B2 Services and deactivation: PASS (2026-10-14 11:29–11:31 UTC, `c0972b0`)

Owner-approved, B2 only. P1 in "DENOVA Pilot 001 (synthetic)" (header checked), Settings →
Business DNA → Services.

**Before:** "No services added yet"; newest audit row `business_dna.create` (four rows in all).

| #   | Name                          | Price / note              | Duration | Description                                     | Created (UTC) | Id          |
| --- | ----------------------------- | ------------------------- | -------- | ----------------------------------------------- | ------------- | ----------- |
| 1   | PILOT-001 Portrait session    | 150.00 EUR, starting from | 60 min   | Synthetic pilot test service, not a real offer. | 11:29:24      | `b164aed6…` |
| 2   | PILOT-001 Event video package | 400.00 EUR, starting from | 120 min  | Synthetic pilot test service, not a real offer. | 11:30:20      | `8ac9cfc3…` |

Each was added once with "Active" on; both were listed as active. Service 2 was deactivated once
(11:31:00 UTC).

**After reload:** two services listed, no duplicate. Portrait session active (Edit, Deactivate);
Event video package marked "Inactive" with Edit and **Reactivate**. Reactivate was not pressed.
In the code, deactivation only sets `isActive: false` (no delete) and `reactivateBusinessDnaService`
sets it back with a `business_dna_service.reactivate` audit row, so the service is restorable.

**Audit:** three new rows, all by P1: `business_dna_service.create` `b164aed6…` (14:29:24
Helsinki), `business_dna_service.create` `8ac9cfc3…` (14:30:20), `business_dna_service.deactivate`
`8ac9cfc3…` (14:31:00). No `.update` or `.reactivate`, nothing else new. The organization has no
voice assistants, so the deactivation's assistant re-sync had nothing to call.

### B3 Stale save is refused: PASS (2026-10-14 11:49 UTC, `c0972b0`)

Owner-approved, B3 only. P1 in "DENOVA Pilot 001 (synthetic)" (header checked), two tabs on
Settings → Business DNA.

**Before:** both tabs loaded version `2026-10-14T11:19:50.104Z` with identical values (the B1
values; Brand tone "Friendly and professional"). Audit log: 7 rows, newest
`business_dna_service.deactivate`.

**Harness note (no data effect):** the first attempt to edit tab 1 didn't reach the page (the
browser-automation input went to a background tab); the Save click did nothing. Checked before
continuing: the field still held the old value, the version was unchanged, no "Saved." message,
and the audit log still had 7 rows. The edit was then repeated and confirmed before saving.

| Step | Tab | Action                                                                                 | Result                                                                                                                                                                                                    |
| ---- | --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 1   | Brand tone "Friendly and professional" → "Warm and professional"; Save once            | "Saved."; version `11:49:17.236Z`; no other field changed                                                                                                                                                 |
| 2    | 2   | Not refreshed (still `11:19:50.104Z`); Brand tone → "Calm and professional"; Save once | Refused: "Business DNA was changed elsewhere (in chat or another tab) after you opened this page. Your changes were not saved and are still here." Offers to open or load the latest version. Not retried |

**After reload:** Brand tone "Warm and professional", version `11:49:17.236Z`; every other field
unchanged from B1.

**Audit:** 8 rows; one new `business_dna.update`, 14:49:17 Helsinki (11:49:17 UTC), actor P1,
`business_dna` `2ae05708…`. No second update from tab 2 and nothing else new.

### B4 MEMBER is read-only: PASS (2026-10-14, `c0972b0`)

Owner-approved, B4 only, view-only: no edit, click or write attempt was made as P2.

**How it was observed:** P2 signed in on the owner's side and opened Settings → Business DNA. The
owner visually confirmed the organization "DENOVA Pilot 001 (synthetic)" and that the page is
read-only. Claude's browser stayed signed in as P1 (profile email checked), so Claude did not see
P2's screen and took no screenshot of it; Claude's checks are the P1-side state and the code that
staging runs.

| Check                                | Result | Evidence                                                                                                                                                                                             |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 is a Member                       | PASS   | P1 Members page: P2 (`bushra334a@gmail.com`) role `MEMBER`                                                                                                                                           |
| Organization                         | PASS   | Owner's observation on P2's screen; P1 header "DENOVA Pilot 001 (synthetic)"                                                                                                                         |
| Values visible, no editable controls | PASS   | Owner: page read-only. Code: `MEMBER` has `business-dna:read`, not `:write`; the page passes `readOnly`, every form section is a disabled `<fieldset>` and the products field is disabled            |
| No Save button                       | PASS   | Code: with `readOnly` the Save button isn't rendered; consistent with the owner's observation                                                                                                        |
| No service controls                  | PASS   | Code: `canManageServices` is false without `business-dna:write`, so Add / Edit / Deactivate / Reactivate aren't rendered. The server actions also require `business-dna:write` (`requirePermission`) |
| No mutation from viewing             | PASS   | Audit log (P1): 8 rows before and after, newest still `business_dna.update` 11:49:17 UTC; no new `business_dna` or `business_dna_service` row                                                        |

The code checked (`src/server/auth/permissions.ts`, `settings/business-dna/*`,
`src/actions/business-dna*.ts`) is identical to `c0972b0`, the staging build.

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

**Pilot completion after B4:** 6 of 28 (21.4%); Part 1 alone 6 of 26 (23.1%). Next in plan
order: B5a (paid, needs approval).

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
