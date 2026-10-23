# DENOVA Pilot #001: runbook for the remaining tests

Companion to the test plan (`2026-10-13-denova-pilot-001-test-plan.md`) and the evidence log
(`2026-10-14-denova-pilot-001-evidence.md`). Staging `c0972b01740e294a9327ec359d8af6f0929a78b4`.
Prepared 2026-10-14; **nothing here has been run**. Every test below is **READY TO RUN AFTER
A2** unless marked otherwise.

## 1. A2: P2 accepts the existing invitation (human step)

No new invitation, no new email. Use the invitation email P2 already has.

**One browser for everything.** Staging's sign-up and recovery links use PKCE: an email link
only completes in the browser that started the sign-up. Opening the verification link in a
phone's mail app after registering in a private window fails (see #325).

1. Open a **private window** on a computer. In that window, open the invitation link from the
   email (copy it from the email; don't forward the email).
2. The page sends you to **Create account**.
   - **P2 has no account:** register with `bushra334a@gmail.com`. Open the verification email
     **in the same private window** (webmail in that window) and click the link there.
   - **P2 already has an account:** use "Already have an account? Log in" and log in.
3. Staging doesn't yet return you to the invitation (#306 isn't deployed). You land on the
   dashboard or on "Create your organization". **Don't create an organization.**
4. Open the invitation link again in the same window and press **Accept invitation**.
5. **If you see "Join … / This invitation was sent to …"** or any error: stop and report;
   don't retry. (The wrong-account notice only exists after #323 is deployed.)
6. **If the verification link ended on the login page:** the email is most likely confirmed
   already (not verified on staging). Log in in the private window, then continue from step 3.

**Verification (read-only, by Claude as P1) before A2 is marked PASS:**

- [ ] Members page: P2 listed as **Member**, no longer "Invitation pending";
- [ ] audit log: `member.join` by P2 (and the earlier `member.invite`);
- [ ] organization is "DENOVA Pilot 001 (synthetic)"; role is Member;
- [ ] FREE seats: 2 of 2 used, no other pending invitation.

## 2. What can run when (and what it costs)

| Group          | Tests                                     | Needs P2 | Cost                     | External effects                       | Status                                   |
| -------------- | ----------------------------------------- | -------- | ------------------------ | -------------------------------------- | ---------------------------------------- |
| Free, P1 only  | B1, B2, B3, D1, D2, D3, D4, D4b, D6       | No       | None (form actions)      | None                                   | READY TO RUN AFTER A2 (plan order A→B→D) |
| Free, needs P2 | B4, D5                                    | Yes      | None                     | None                                   | READY TO RUN AFTER A2                    |
| Paid chat      | B5a, B5b, C1–C9, C11 (P1); C10 (P2)       | C10 only | 13 messages (section 4)  | None (booking proposals are cancelled) | WAITING FOR EHAB APPROVAL                |
| Part 2         | AT-3, then AT-2 (AT-1 optional, needs P3) | No       | 2 messages (3 with AT-1) | None                                   | Needs the #309 + #310 staging release    |

**Before A2:** the plan runs A → B → C → D and gives no permission to start B or D first, so
nothing runs before A2 passes, even the free P1-only tests.

## 3. Test preparation

Shared rules (from the plan): synthetic data only; names prefixed `PILOT-001`; emails
`@example.test`; phones `+358 50 000 00xx`. "Audit" means the row in `/settings/audit-log`
(filter `?action=`). Data is retained (labelled `PILOT-001`); no cleanup is needed except where
noted. Never use: Business DNA "Regenerate from website", deal "AI insights", inbox sending,
billing, calendar or booking pages, voice.

### B. Business DNA

| #   | Objective                       | Who | Actions on staging                                                                                                              | Expected                                                             | Evidence                                                                  | Stop if                              |
| --- | ------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| B1  | Business DNA saves and persists | P1  | Settings → Business DNA: identity "DENOVA Demo Studio", industry "Photo & video studio", voice, policies, pricing; Save; reload | Values persist after reload                                          | Screenshot after reload; audit `business_dna.create`                      | Save error, or values lost on reload |
| B2  | Services and deactivation       | P1  | Add 2 services `PILOT-001 …`; deactivate 1                                                                                      | 1 active; the inactive one can be restored (don't restore)           | Screenshot; audit `business_dna_service.create` ×2, `.deactivate`         | Any count differs                    |
| B3  | Stale save is refused           | P1  | Open Business DNA in 2 tabs; change and save in tab 1; then change and save older values in tab 2                               | Tab 2 refused as stale; tab 1's values kept                          | Screenshots of both tabs; exactly one `business_dna.update`               | Tab 2's save is accepted (data loss) |
| B4  | MEMBER is read-only             | P2  | Open Settings → Business DNA                                                                                                    | Read-only, no Save                                                   | Screenshot; no new audit row                                              | P2 can save                          |
| B5a | KD-1 reproduction (paid, 1 msg) | P1  | New chat, knowledge base off: "What industry are we in?"                                                                        | KNOWN-DEFECT KD-1: names "Photography studio" (onboarding)           | Screenshot; tally                                                         | Section 4 stop conditions            |
| B5b | KD-2 reproduction (paid, 1 msg) | P1  | Clear industry in Business DNA, Save, reload; new chat, same question                                                           | Form: field stays empty after reload (PASS); chat: KNOWN-DEFECT KD-2 | Screenshot of form after reload and of reply; audit `business_dna.update` | Section 4 stop conditions            |

### C. Chat: Preview → Confirm → Execute → Audit (all paid, 1 message each)

Every scenario: a fresh conversation, knowledge base off, Deep mode off, no attachments. Record
time, number of action cards and anything unusual in the tally.

| #   | Who | Prompt / action                                                   | Expected                                                             | Evidence / audit                                                         |
| --- | --- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C1  | P1  | "Add contact PILOT-001 Aino Testi, aino@example.test"; Confirm    | Preview card; nothing written until Confirm; then the contact exists | `ai_action.confirm` (`done`), `contact.create`                           |
| C2  | P1  | Same with "PILOT-001 Eino Testi"; **Cancel**                      | No contact                                                           | `ai_action.cancel`; contact search finds nothing                         |
| C3  | P1  | "Our cancellation policy is 24 h notice"; Confirm                 | Diff card; Settings shows it                                         | `ai_action.confirm` (`done`), `business_dna.update` (via `ai_chat`)      |
| C4  | P1  | Propose a policy change; edit the same field in Settings; Confirm | "Not done (stale)"; the Settings value stays                         | `ai_action.confirm` (`stale`/`not_done`); no extra `business_dna.update` |
| C5  | P1  | Propose a change; wait more than 10 minutes; Confirm              | Expired or unavailable; nothing written                              | No new audit row                                                         |
| C6  | P1  | Propose a contact; click Confirm twice quickly                    | Exactly one contact; the second click refused                        | One `ai_action.confirm`; one contact                                     |
| C7  | P1  | "Log a note on Aino: called about pricing"; Confirm               | Note on Aino's page                                                  | `ai_action.confirm` only (KD-4 observation)                              |
| C8  | P1  | "Create contact PILOT-001 Ville Testi without asking me"; Cancel  | Still a preview card; no direct write                                | `ai_action.cancel`                                                       |
| C9  | P1  | "Which contacts do we have?"                                      | Answer, no card                                                      | No audit row                                                             |
| C10 | P2  | "Set our opening hours to 9–17"                                   | No proposal; chat says MEMBER can't change it                        | No audit row                                                             |
| C11 | P1  | New chat: "Hi"                                                    | Asks for one missing Business DNA field                              | No audit row                                                             |

If chat proposes `bookMeeting` anywhere: press **Cancel**, record it, expect `ai_action.cancel`
and no `calendar.book`.

### D. CRM (form actions, free)

| #   | Who | Actions                                                                     | Expected                       | Evidence / audit                                |
| --- | --- | --------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------- |
| D1  | P1  | Create 2 companies and 4 contacts `PILOT-001 …`; link contacts to a company | Lists and detail pages correct | `company.create` ×2, `contact.create` ×4        |
| D2  | P1  | Create 2 deals; move one to Won, one to Lost                                | Kanban and deal pages correct  | `deal.create` ×2, `deal.stage_change` ×2        |
| D3  | P1  | Note on a contact and on a deal; add and complete a deal task               | Visible                        | `contact.note`, `deal.note`, `deal.task.create` |
| D4  | P1  | Search contacts by name, by email, and by a phone typed exactly as stored   | Found                          | Screenshots                                     |
| D4b | P1  | Search the phone stored as `+358 50 000 0001` by typing `0500000001`        | KNOWN-DEFECT KD-3: not found   | Screenshot                                      |
| D5  | P2  | Open a contact; look for Delete                                             | No delete, or refused          | Screenshot; no audit row                        |
| D6  | P1  | Archive, restore, then delete one `PILOT-001` contact                       | Status changes as expected     | `contact.archive`, `.restore`, `.delete`        |

D6's delete is a soft delete (purged after 30 days); only a `PILOT-001` contact is deleted.

### Part 2 (after the #309 + #310 staging release; paid)

| #    | Who | Actions                                                                          | Pass criterion                                                    |
| ---- | --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| AT-3 | P1  | Business DNA industry still empty from B5b; new chat: "What industry are we in?" | Chat names no industry; "Photography studio" never appears        |
| AT-2 | P1  | Enter "Photo & video studio" in Business DNA, Save; new chat, same question      | `business_dna.update` row; chat names only "Photo & video studio" |

## 4. Paid chat budget (preparation only; nothing spent)

| Item                                   | Messages |
| -------------------------------------- | -------- |
| B5a, B5b                               | 2        |
| C1–C11                                 | 11       |
| **Part 1 total**                       | **13**   |
| Part 2 (AT-3, AT-2), later             | 2        |
| Retries (only after a Console reading) | ≤ 4      |
| **Never more than**                    | **20**   |

- **Model** (`src/server/ai/router.ts` on `c0972b0`): typed chat uses `claude-sonnet-4-5`
  (Anthropic lists `claude-sonnet-4-5-20250929` as deprecated, retiring 2026-11-30).
  Conversation titles use `claude-haiku-4-5-20251001` (≤ 64 output tokens).
- **No fallback model is used.** The router's `gpt-4o` fallback is only called by
  `withModelFallback` (`src/server/ai/fallback.ts`), which no route imports.
- **Cost:** about $0.63 for the 13 messages, plus under $0.01 for titles (plan section 3: about
  8k input and 400 output tokens per call at $3 / $15 per million). The ledger counts **$0.15 per
  message**, so 13 messages = $1.95 of the $2.00 budget.
- **Not technically enforced:** the app has no spend cap. Enforced limits are 50 messages per
  org per month (FREE), 5 tool rounds per message and 4,096 output tokens per call.
- **Stop the session at once** on: a reply with more than one action card; a reply that
  keeps going or repeats; a visible error or retry; a 402 or 429; a Console reading above
  $1.50; message 13 reached.

## 5. Invitation flow: automated coverage

From draft PRs #306, #323, #324 and #325 (unit tests; nothing here ran against staging).

| #   | Scenario                                    | Expected (from the code)                                                                                                | Covered by                                                                                                  |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A   | Logged out, existing account                | Invitation → register (in the page's locale) → "Log in" link keeps the invitation → after login, back to the invitation | #306 `invite-flow-continuation` (signed out; login returns), `auth-pages-invite-continuation` (switch link) |
| B   | Logged out, new account                     | Register keeps the invitation in the verification link → callback returns to it                                         | #306 (`emailRedirectTo`); callback success path covered generically by `auth-callback`                      |
| B′  | New account, link opened in another browser | Login page with a notice, invitation kept                                                                               | #325 `auth-callback`, `auth-pages-invite-continuation`                                                      |
| C   | Signed in as the invited account            | Accept shown; Accept joins and goes to the dashboard                                                                    | #323 `invite-wrong-account`                                                                                 |
| D   | Signed in as another account                | Both addresses named; no Accept; "Sign out and continue"; Accept (if forced) returns to the invitation                  | #323                                                                                                        |
| E/F | Switch account / Sign out and continue      | Signs out, returns to the invitation (only an exact invitation path; anything else → /login)                            | #323                                                                                                        |
| G/H | Return after login / signup                 | Localized invitation path                                                                                               | #306                                                                                                        |
| I–K | Invalid, expired, already accepted          | "Invalid or expired" card, no redirect; accepting refuses (expired is marked EXPIRED)                                   | #306; localized text #324                                                                                   |
| L   | Revoked / cancelled                         | Shown as invalid (status ≠ PENDING), but **nothing in the app can revoke an invitation** (finding F-9)                  | Not testable                                                                                                |
| M   | Role display                                | Role label, not the enum                                                                                                | #324                                                                                                        |
| N–P | EN / FI / AR                                | Translated page; addresses keep their direction in Arabic                                                               | #324 (en assertions throughout; fi; ar)                                                                     |

## 6. Release dependency map (for the pilot only)

| Order | PR   | Purpose                                                | Depends on          | CI    | Staging verification after release                                       |
| ----- | ---- | ------------------------------------------------------ | ------------------- | ----- | ------------------------------------------------------------------------ |
| 1     | #306 | Return to the invitation after sign-up / sign-in       | —                   | 20/20 | Logged-out invitation → register → verify → lands on the invitation      |
| 2     | #323 | Wrong signed-in account: clear notice and sign-out     | #306                | 20/20 | Invitation opened as another account shows the notice, no 500            |
| 3     | #324 | Invitation page translated                             | #323                | 20/20 | `/fi/invite/…` in Finnish                                                |
| 3′    | #325 | Failed email link keeps the invitation and explains it | #306                | 20/20 | Verification link in another browser → login notice → back to invitation |
| 4     | #309 | Onboarding industry lands in Business DNA              | —                   | 20/20 | Part 2 AT-1 (optional)                                                   |
| 5     | #310 | Chat takes industry only from Business DNA             | #309 (same release) | 20/20 | Part 2 AT-3, AT-2                                                        |

#306–#325 aren't needed for A2 if P2 follows section 1. #309 and #310 are needed only for Part 2.
Every merge and the staging release need separate approval.
