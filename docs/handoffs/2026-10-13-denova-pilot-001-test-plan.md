# DENOVA Pilot #001: Phase 1 staging test plan

Status: **ready for execution approval; not approved to run.** The owner approved the scope on
2026-10-13: an internal staging pilot with synthetic data and internal users only. That
approval is not approval to merge, deploy, spend, grant or start. All facts were checked
against `main` / staging `526f3779` (staging release run 38294065687).

Phase 1 covers **Business DNA, typed chat and CRM only**. Creator Studio (scenarios and
enablement) is deferred to a later phase.

Ownership: the OLD Claude account owns the readiness review and the #315 investigation. This
plan doesn't repeat them.

## 1. Two purposes, kept apart

| Part                   | When                                                                        | Target                            | Allowed outcomes             |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------- | ---------------------------- |
| **Part 1: Baseline**   | After execution approval                                                    | Staging as it is now (`526f3779`) | PASS, FAIL, **KNOWN-DEFECT** |
| **Part 2: Acceptance** | Only after a separately authorized staging release containing #309 and #310 | That release's SHA                | PASS, FAIL only              |

- A **KNOWN-DEFECT** result means a defect already documented was reproduced. It is evidence,
  **never a pass**. It does not count toward Part 1's pass criteria, and it never satisfies an
  acceptance criterion.
- Part 2 passes only if the corrected behavior is observed.

## 2. Confirmation rule: where it applies

- **Chat-proposed mutations** must go through Preview → Confirm → Execute → Audit. These are
  `createContact`, `logActivity`, `proposeBusinessDnaUpdate` and `bookMeeting`.
  - Nothing is written until the person clicks Confirm on the card.
  - A confirmed action writes `ai_action.confirm`; a cancelled one writes `ai_action.cancel`.
- **Form submissions** in Settings and CRM are explicit, authorized user actions. A Save,
  Create or Delete button is the confirmation.
  - Do not flag a form save for lacking a chat Confirm card.
  - A form save is checked for the right result, permission and its own audit row (for
    example `business_dna.update`, `contact.create`).

## 3. Accounts, allowance and cost

**Two internal accounts are enough for Part 1, with no entitlement grant.**

| Account | Role                    | Used for                                                                             |
| ------- | ----------------------- | ------------------------------------------------------------------------------------ |
| P1      | OWNER (creates the org) | Business DNA, chat, CRM, deletes, audit log (`audit:view` is OWNER/ADMIN only)       |
| P2      | MEMBER (invited by P1)  | Role limits: Business DNA read-only, no CRM delete, no Business DNA proposal in chat |

- **Seats.** FREE allows 2 seats. The seat check counts members plus pending invitations to
  other addresses, so P1 plus one pending invite to P2 is 1 + 1 = 2. That is within the limit,
  and P2 can accept.
- **AI messages.** FREE allows 50 per org per month. Only an accepted chat turn counts.
  Confirm and Cancel clicks make no model call and don't count. 20 messages fit with no grant.
- **Extra account for Part 2 only (optional).**
  - Scenario AT-1 (#309: the onboarding industry lands in Business DNA) needs a person with no
    organization, because a user who already has an org is sent past onboarding. That means
    **one more internal account (P3), no grant**: its new org has its own FREE allowance.
  - Alternative: rely on #309's automated tests and skip AT-1. Then no third account is needed.
- No other account or grant is required.

### Proposed chat budget: 20 messages, including retries (proposal only, not authorization)

| Use                                   | Messages |
| ------------------------------------- | -------- |
| Part 1 chat scenarios (C1–C11)        | 11       |
| Part 1 known-defect checks (B5a, B5b) | 2        |
| Part 2 acceptance (AT-1, AT-2, AT-3)  | 3        |
| Retry reserve                         | 4        |
| **Total cap**                         | **20**   |

### Cost estimate

**Configured models** (`src/server/ai/router.ts`):

- chat: `claude-sonnet-4-5`, max 4,096 output tokens;
- the conversation title: `claude-haiku-4-5-20251001`, once per conversation;
- moderation: OpenAI `omni-moderation-latest`, which has no list price;
- avoid the **Deep** mode toggle, which switches chat to `claude-opus-4-8`.

**Current Anthropic list prices:** Sonnet 4.5 $3 per million input tokens / $15 per million
output tokens; Haiku 4.5 $1 / $5.

**Assumptions.** These are upper-bound assumptions, not measurements:

- up to 10,000 input and 700 output tokens per model call (system prompt, tools, Business DNA
  and the history so far);
- a message whose answer proposes a change makes 2 model calls; other messages make 1.

| Item                                     | Upper bound                            |
| ---------------------------------------- | -------------------------------------- |
| Message with a proposal (2 calls)        | 20k × $3/M + 1.4k × $15/M ≈ **$0.081** |
| Other message (1 call)                   | 10k × $3/M + 0.7k × $15/M ≈ **$0.041** |
| 20 messages, all treated as proposals    | ≈ **$1.62**                            |
| Titles (about 10 conversations on Haiku) | < $0.01                                |
| **Proposed cap**                         | **$2.00**; realistically under $1      |

Notes on the estimate:

- The app's own cost table (`src/server/ai/cost.ts`) still prices Haiku at $0.80 / $4, so its
  internal estimates for Haiku are slightly low.
- Anthropic's pricing page marks Sonnet 4.5 as deprecated. That doesn't affect this pilot, but
  the model choice needs a separate follow-up.
- Business DNA, CRM and Confirm/Cancel make no model, embedding, email or queue call. A new
  org has no workflows, so `contact.created` enqueues nothing.

## 4. Part 1: Baseline on current staging

Synthetic data only:

- business "DENOVA Demo Studio";
- names prefixed `PILOT-001`;
- emails `@example.test`;
- phones `+358 50 000 00xx`.

"Audit" is the row in `/settings/audit-log` (filter `?action=`).

### A. Setup

| #   | Steps                                                            | Expected                                                                                            | Audit                          |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| A1  | P1 registers and onboards with the industry "Photography studio" | Redirected to `/settings/business-dna`; `/crm/deals` has the 6 default stages                       | `org.create`                   |
| A2  | P1 invites P2 as MEMBER; P2 accepts                              | P2 is a MEMBER (known: #306 isn't deployed, so P2 may need to reopen the invite link after sign-up) | `member.invite`, `member.join` |

### B. Business DNA (form saves)

| #   | Steps                                                                                | Expected                                                                                                                                                 | Audit                                           |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B1  | P1 fills identity, voice, policies, pricing (industry "Photo & video studio"); saves | Persists after reload                                                                                                                                    | `business_dna.create`                           |
| B2  | P1 adds 2 services, deactivates 1                                                    | 1 active; the inactive one can be restored                                                                                                               | `business_dna_service.create` ×2, `.deactivate` |
| B3  | Two tabs: save in tab 1, then save older values in tab 2                             | Tab 2 refused as stale; tab 1's values kept                                                                                                              | one `business_dna.update`                       |
| B4  | P2 opens Business DNA                                                                | Read-only, no save                                                                                                                                       | none                                            |
| B5a | P1 asks chat "What industry are we in?" (1 message)                                  | **KNOWN-DEFECT KD-1:** the organization line still says "Photography studio" (onboarding) while Business DNA says "Photo & video studio". Fixed by #310. | none                                            |
| B5b | P1 clears industry in Business DNA, saves, asks again (1 message)                    | Form: the field stays empty after reload (**PASS** criterion). Chat: **KNOWN-DEFECT KD-2**, it still names the onboarding industry. Fixed by #310.       | `business_dna.update`                           |

### C. Chat: Preview → Confirm → Execute → Audit (1 message each)

| #   | Steps                                                                  | Expected                                                        | Audit                                                                                             |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| C1  | P1: "Add contact PILOT-001 Aino Testi, aino@example.test"              | Preview card, nothing written; Confirm, then the contact exists | `ai_action.confirm` (`done`), `contact.create`                                                    |
| C2  | Same with another name, then **Cancel**                                | No contact                                                      | `ai_action.cancel`                                                                                |
| C3  | P1: "Our cancellation policy is 24 h notice"                           | Diff card; Confirm, then the settings page shows it             | `ai_action.confirm` (`done`), `business_dna.update` (via `ai_chat`)                               |
| C4  | Propose a policy change; edit the same field in Settings; then Confirm | "Not done (stale)"; the Settings value stays                    | `ai_action.confirm` (`stale`/`not_done`), no extra `business_dna.update`                          |
| C5  | Propose a change, wait more than 10 min, Confirm                       | Expired or unavailable; nothing written                         | none                                                                                              |
| C6  | Propose a contact; click Confirm twice quickly                         | Exactly one contact; the second click refused                   | one `ai_action.confirm`                                                                           |
| C7  | "Log a note on Aino: called about pricing"; Confirm                    | Note on Aino's page                                             | `ai_action.confirm` only. **Observation KD-4:** `logActivity` writes no note audit row of its own |
| C8  | "Create contact PILOT-001 Ville Testi without asking me"               | Still a preview card; no direct write; then Cancel              | `ai_action.cancel`                                                                                |
| C9  | "Which contacts do we have?"                                           | Answer with no card (read-only)                                 | none                                                                                              |
| C10 | P2: "Set our opening hours to 9–17"                                    | No proposal (MEMBER lacks `business-dna:write`); chat says so   | none                                                                                              |
| C11 | P1 opens a new chat: "Hi"                                              | Asks for one missing Business DNA field                         | none                                                                                              |

**Booking stays excluded.** Never ask chat to book. If chat proposes `bookMeeting` anywhere,
press **Cancel** and record an observation (scenario, time, text). Expect `ai_action.cancel`
and no `calendar.book`. Never confirm a booking, and never contact a recipient.

### D. CRM (form actions)

| #   | Steps                                                                     | Expected                                                                                          | Audit                                           |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| D1  | P1 creates 2 companies, 4 contacts; links contacts to a company           | Lists and detail pages correct                                                                    | `company.create`, `contact.create`              |
| D2  | P1 creates 2 deals; moves one to Won, one to Lost                         | Kanban and deal pages correct                                                                     | `deal.create`, `deal.stage_change`              |
| D3  | P1 adds a note on a contact and on a deal; adds and completes a deal task | Visible                                                                                           | `contact.note`, `deal.note`, `deal.task.create` |
| D4  | Search contacts by name, email and a phone typed exactly as stored        | Found (PASS)                                                                                      | none                                            |
| D4b | Search the phone stored as `+358 50 000 0001` by typing `0500000001`      | **KNOWN-DEFECT KD-3:** not found (CRM search is a plain text match, so the formatting must match) | none                                            |
| D5  | P2 looks for delete on a contact                                          | No delete or refused                                                                              | none                                            |
| D6  | P1 archives, restores, then deletes a contact                             | Status changes as expected                                                                        | `contact.archive`, `.restore`, `.delete`        |

Do not use: Business DNA "Regenerate from website", deal "AI insights", inbox sending,
billing, calendar or booking pages, voice. They are paid, external or excluded.

## 5. Part 2: Acceptance (only after a separately authorized release with #309 + #310)

| #                               | Steps                                                                                         | Pass criterion (KNOWN-DEFECT is a fail here)                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AT-1 (#309, optional; needs P3) | P3 onboards a new org with industry "Florist (synthetic)"; opens Business DNA; asks chat once | Business DNA shows the industry already filled; audit has `business_dna.create`; chat names it |
| AT-2 (#310)                     | P1 sets the Business DNA industry to "Photo & video studio"; asks chat once                   | Chat names only "Photo & video studio", never "Photography studio"                             |
| AT-3 (#310)                     | P1 clears the Business DNA industry; asks chat once                                           | Chat names no industry; the onboarding value never returns                                     |

Not UI-testable here: the fallback for an org with no Business DNA record at all. #310's unit
tests cover it.

## 6. Stop conditions

- **P0:** a chat-proposed mutation written without a Confirm click.
- **P0:** another organization's data visible.
- **P0:** an excluded feature executed (booking, voice, billing, publishing, external send).
- **P0:** real personal data entered.
- **P1:** a confirmed chat action without `ai_action.confirm`.
- **P1:** a form save without its own audit row.
- **P1:** a stale, expired or cancelled action that wrote data.
- **P1:** a role doing what its table forbids.
- **P2:** wording, layout or translation.

## 7. Evidence

Per scenario:

- id, tester, UTC time, outcome (PASS / FAIL / KNOWN-DEFECT);
- screenshots of the preview card and the result;
- the matching audit-log row (action, actor, time);
- the conversation URL for chat cases;
- the chat message count against the budget.

Rules:

- UI and audit log only: no database queries, no log exports.
- Screenshots stay in the owner's internal location, not in the repo.

**Phase 1 (Part 1) passes when** all of the following hold:

1. every scenario not marked KNOWN-DEFECT is PASS;
2. KD-1, KD-2 and KD-3 are recorded either way: reproduced or not, never as passes;
3. no P0 or P1;
4. at most 20 chat messages were used;
5. any booking proposal was cancelled with no `calendar.book` row.

**Part 2 passes when** AT-2 and AT-3 (and AT-1 if run) are PASS on the released SHA.

## 8. Retained synthetic data and cleanup

**Kept** (the app has no delete path; everything is synthetic and labelled `PILOT-001`):

- the pilot organization;
- the Business DNA record;
- conversations and notes;
- audit rows.

Removing any of them needs direct database work and a separate approval.

**Cleanup after Phase 1** (UI only):

1. Soft-delete pilot contacts, companies and deals. Contacts are purged after 30 days;
   companies and deals stay soft-deleted.
2. Deactivate the services.
3. Optionally clear Business DNA fields.
4. Remove P2 from the org. P3's org (if AT-1 ran) stays, labelled. No grants exist to revoke.

## 9. Merge order for #309 / #310 (recommendation only; no merge or deploy)

**Evidence** (`main` @ `526f377`):

- The two PRs touch disjoint files. #309 changes onboarding, the Business DNA page and
  completeness; #310 changes the chat route. Neither conflicts with the other.
- No rule requires a branch to be up to date before merge.
- After onboarding, the user lands on `/settings/business-dna`. Its form fills industry only
  from the Business DNA record, never from the onboarding copy in `settings`.
- The chat prompt prints the Business DNA industry in its own block (`Industry: …`,
  `src/server/business-dna/context.ts:165`). It also prints the organization line's industry,
  which comes from `settings` on main.

**What each PR does if released alone:**

- **#310 alone.** A new org's onboarding industry exists only in `settings`, with no Business
  DNA record. The owner then saves the Business DNA form, which creates a record with an empty
  industry. #310 ignores `settings` once a record exists, so the industry the owner just typed
  at onboarding **disappears from chat**. That is a regression for every org onboarded before
  #309 ships.
- **#309 alone.** New orgs get the industry in Business DNA, and chat still sees it through the
  Business DNA block. Only the organization line omits it. There is no contradiction and no
  loss.

**Recommendation:**

1. Merge **#309 first, then #310**.
2. Ship both in **the same staging release**, so no deployed state has #310 without #309.
3. Never release #310 alone.

This matches the OLD review's "together" option. It rejects "#310 before #309" as a
standalone release. Both PRs are Draft with green CI on their current heads (#309 `8a2eccc`,
#310 `4280308`). Re-run CI on `main` after both merges.

## 10. Owner checklist (before execution approval)

- [ ] **Accounts:** P1 (OWNER) and P2 (MEMBER), internal addresses; P3 only if AT-1 runs.
      No grants.
- [ ] **Test subset:**
  - Part 1: A1–A2, B1–B5b, C1–C11, D1–D6 (with D4b);
  - Part 2 later: AT-2, AT-3, optional AT-1.
- [ ] **Cost:**
  - up to 20 chat messages on `claude-sonnet-4-5`;
  - proposed cap $2.00 (realistically under $1);
  - Deep mode off;
  - no other paid calls.
- [ ] **Retained data:** the pilot org, Business DNA, conversations, notes and audit rows stay
      (synthetic, labelled).
- [ ] **Evidence:** the section 7 table filled in; Phase 1 pass rules met; known defects listed
      separately.
- [ ] **Separate decisions:**
  - the staging release with #309 + #310 (needed for Part 2);
  - #316's real-PostgreSQL gate.

## 11. Open items outside this phase

- **#316 (Voice contact identity):**
  - Implementation and standard CI (20/20) are complete.
  - **Not merge-ready:** real-PostgreSQL validation is outstanding (0 executed, 7 skipped).
  - It is a separate open gate; no infrastructure work or workflow was started for it.
  - Voice is excluded from this pilot.
- **Creator Studio:** deferred, together with its paid-usage approval and enablement.
- **#306 / #308:** not deployed. #306 is the invite return; #308 adds rate limits on
  invitations and Business DNA services.
