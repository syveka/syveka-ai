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
  This is a message count, not a spend cap (see below).
- **Extra account for Part 2 only (optional).**
  - Scenario AT-1 (#309: the onboarding industry lands in Business DNA) needs a person with no
    organization, because a user who already has an org is sent past onboarding. That means
    **one more internal account (P3), no grant**: its new org has its own FREE allowance.
  - Alternative: rely on #309's automated tests and skip AT-1. Then no third account is needed.
- No other account or grant is required.

### Proposed chat budget: up to 20 messages (proposal only, not authorization)

| Use                                                    | Messages |
| ------------------------------------------------------ | -------- |
| Part 1 chat scenarios (C1–C11)                         | 11       |
| Part 1 known-defect checks (B5a, B5b)                  | 2        |
| Part 2 acceptance (AT-1, AT-2, AT-3), later session    | 3        |
| Retries, only if measured spend allows (stopping rule) | ≤ 4      |
| **Total**                                              | **≤ 20** |

### Cost: estimate, enforcement and stopping rule

**What runs per chat message.** Based on the code at `526f3779`:

- **Main model.** `claude-sonnet-4-5` (`src/server/ai/router.ts`).
  - Each tool round re-sends the whole context: the system prompt, tool definitions, Business
    DNA, and up to 40 earlier messages of that conversation (`CONTEXT_WINDOW_TURNS = 20`).
  - A message whose answer proposes a change normally makes 2 calls: the tool call, then the
    reply.
  - The tool loop allows **up to 5 rounds** per message (`maxToolRounds` default 5).
  - A round is retried **up to 3 times** on transient provider errors, but only before any text
    has streamed (`AI_RETRY_MAX_ATTEMPTS` default 3).
- **Title.** `claude-haiku-4-5-20251001`, one call on a conversation's first message, at most
  64 output tokens.
- **Rolling summary.** A Haiku call, only when a conversation passes 40 messages. The plan
  keeps conversations far below that.
- **Knowledge-base search.** On by default in the composer: one OpenAI embedding call per
  message (`text-embedding-3-small`, fractions of a cent). **Testers switch "Use knowledge
  base" off**, which removes this call.
- **Moderation.** OpenAI `omni-moderation-latest`, no list price.
- **Never.** Deep mode (`claude-opus-4-8`) is not to be switched on. The `gpt-4o` fallback in
  the router has no caller.
- **No model call.** Confirm and Cancel, form saves and CRM actions.

**Prices** (Anthropic list): Sonnet 4.5 $3 / $15 per million input / output tokens; Haiku 4.5
$1 / $5.

**Estimate.** This is an estimate, not a maximum. Assumptions: a fresh conversation per
scenario, about 8k input tokens per call, about 400 output tokens.

| Item                                              | Estimate |
| ------------------------------------------------- | -------- |
| Message with a proposal (2 calls)                 | ≈ $0.06  |
| Other message (1 call)                            | ≈ $0.03  |
| Part 1: 13 messages (8 with proposals, 5 without) | ≈ $0.63  |
| Titles: about 13 conversations on Haiku           | < $0.01  |
| Part 2: 3 messages                                | ≈ $0.12  |

**What is technically enforced.** Only these:

- **50 AI messages** per org per calendar month (FREE plan; the 51st returns 402).
- **30 messages per user** and **300 per org** per minute.
- **5 tool rounds** per message.
- **4,096 output tokens** per model call.

Typed chat has **no input-token cap** other than the model's 200k context window. **There is
no spend cap in the app.** A message's cost is stored only in the database (`Message.
estimatedCostUsd`), and no page shows it.

Worst case allowed by the enforced limits:

- 5 calls × (200k × $3/M + 4,096 × $15/M) ≈ **$3.31 per message**;
- about **$66 for 20 messages**;
- plus any billed retries.

**The $2.00 budget is therefore NOT technically enforced.** The figures above don't prove a
maximum.

**Monitoring.**

1. **Tally sheet.** The tester records every sent message: scenario, time, number of action
   cards, anything unusual.
2. **Anthropic Console.** The owner reads Usage and Cost (read-only) for the staging API key.
   - It is attributable only if that key carries no other traffic during the session.
   - Console data can lag.
3. **Not part of this plan.** A read-only database query of `Message.estimatedCostUsd` for the
   pilot org would need its own approval.
4. **Not proposed now.** A dedicated workspace or key with a spend limit is the only real hard
   cap. It would be a configuration change, so it needs its own decision.

**Stopping rule** (conservative; applies even if everything looks fine):

1. **Session setup.**
   - One fresh conversation per scenario; at most 2 messages per conversation.
   - Knowledge base off; Deep mode off; no attachments.
2. **Ledger.** Count every sent message at a planning value of **$0.15**. That is 3 calls ×
   (12k input + 800 output), about 2.4× the estimate. $2.00 ÷ $0.15 = **13 messages, exactly
   Part 1**.
3. **Hard stop at 13 messages in Part 1.**
   - Retries and Part 2 only after the owner has read the actual spend in the Console.
   - Then only as many messages as (remaining budget ÷ $0.15) allows.
   - Never more than 20 in total.
4. **Stop the session at once** on any of these:
   - a reply with more than one action card;
   - a reply that keeps going or repeats itself;
   - a visible error or retry;
   - a 402 or 429;
   - a Console reading above $1.50.

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

Run in this order. After B5b, the pilot org is itself an **existing org with a populated
legacy industry and an empty Business DNA industry** (see 5.1). AT-3 checks the approved rule
on it; AT-2 then checks the owner-review remedy.

| #                               | Steps                                                                                         | Pass criterion (KNOWN-DEFECT is a fail here)                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AT-1 (#309, optional; needs P3) | P3 onboards a new org with industry "Florist (synthetic)"; opens Business DNA; asks chat once | Business DNA shows the industry already filled; audit has `business_dna.create`; chat names it |
| AT-3 (#310)                     | The Business DNA industry is still empty from B5b; P1 asks chat once                          | Chat names no industry; "Photography studio" (the legacy onboarding value) never appears       |
| AT-2 (#310 + owner review)      | P1 enters "Photo & video studio" in the Business DNA form, saves, asks chat once              | `business_dna.update` row; chat names only "Photo & video studio"                              |

Not UI-testable here: an org with no Business DNA record at all, which keeps the legacy
fallback. #310's unit tests cover it.

### 5.1 Existing organizations after #309 + #310

**Verified in code** (`main` @ `526f3779`, #310 head `4280308`):

- The legacy onboarding value `organization.settings.industry` is read in exactly one place:
  the chat route's organization line (`src/app/api/v1/ai/chat/route.ts:286`).
- No page shows it, and nothing lets anyone edit it.
- The Business DNA form fills industry only from the Business DNA record (`page.tsx:43`).
- #309 changes only how **new** organizations are created.
- Neither PR changes stored data.

| Existing org's state                                                   | Chat on staging today                                                   | Chat after #309 + #310          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Legacy industry, no Business DNA record                                | Legacy industry                                                         | Legacy industry (fallback kept) |
| Legacy industry, Business DNA record with an empty or cleared industry | Legacy industry                                                         | **No industry**                 |
| Legacy industry X, Business DNA industry Y                             | X in the organization line, Y in the Business DNA block (contradiction) | Y only                          |
| No legacy industry, Business DNA industry Y                            | Y in the Business DNA block                                             | Y in both places                |

**Impact.** Row 2 is not repaired by shipping both PRs together. Its industry, typed once at
onboarding, stops appearing in chat. This is the approved rule: an existing empty or cleared
field never silently falls back to legacy data.

- Only chat answers change. Voice, booking and other features don't read this value.
- The owner may not notice, because the old value was never visible anywhere.
- Partial mitigation already in the code: when an owner, admin or manager uses chat, the
  missing-fields guidance asks for empty important fields one at a time. Industry is second in
  priority, after the display name.
- How many organizations are in row 2 is **unknown**. Counting them needs a read-only database
  query, which this plan doesn't run. It would need its own approval, for example to size the
  notice below.

**Recommendation.** No automatic backfill, migration or copy from `settings`. With the release
notes for #309 + #310, ask owners of existing organizations to:

1. open **Settings → Business DNA** and check **Industry**;
2. if it is empty and the business has one, type it and **Save**. The save is audited as
   `business_dna.update`.

AT-2 above exercises exactly this path.

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
4. the section 3 stopping rule was followed (no more than 13 Part 1 messages unless the owner's Console reading allowed more; never over 20);
5. any booking proposal was cancelled with no `calendar.book` row.

**Part 2 passes when** AT-3 and AT-2 (and AT-1 if run) are PASS on the released SHA.

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

Shipping both together fixes the **new-onboarding** path only. Existing organizations whose Business DNA industry is empty but whose legacy onboarding industry is set will stop showing an industry in chat. That is by design, and the remedy is an owner review through the form (section 5.1).

## 10. Chat model deprecation (recorded; no model change made)

**Official notice.** Source: Anthropic, "Model deprecations",
<https://platform.claude.com/docs/en/about-claude/model-deprecations>, read 2026-10-13.

- **Deprecation history, entry "2026-09-30: Claude Sonnet 4.5 model".** Anthropic notified
  developers on September 30, 2026 of the model's upcoming retirement on the Claude API.

  | Retirement date   | Deprecated model             | Recommended replacement |
  | ----------------- | ---------------------------- | ----------------------- |
  | November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5`     |

- **Model status table:** `claude-sonnet-4-5-20250929`, Deprecated, deprecated September 30,
  2026, tentative retirement November 30, 2026.
- **The same page says:**
  - deprecated models are likely to be less reliable than active models;
  - "Requests to models past the retirement date will fail."
- **Other models this app uses** (same table):
  - `claude-haiku-4-5-20251001` (titles, summaries, voice, public assistant): **Active**,
    retirement "not sooner than October 15, 2026". Anthropic promises at least 60 days' notice
    before retiring a publicly released model.
  - `claude-opus-4-8` (Deep mode): **Active**.

**What this repo uses.** `chat` and `draft` are routed to the alias `claude-sonnet-4-5`
(`src/server/ai/router.ts:25,31`), on `main` / staging `526f3779` and on production
`fc645727c`. I assume the alias resolves to `claude-sonnet-4-5-20250929`; this plan doesn't
verify that, because it makes no API call.

**Impact on the pilot. It does affect the pilot:**

1. **Every Phase 1 chat result is produced by a deprecated model.**
   - An intermittent provider error or odd behavior must be recorded as "model/provider"
     evidence, not silently retried.
   - The stopping rule in section 3 applies.
2. **Chat results don't carry over to another model.**
   - When chat moves to a replacement model, C1–C11 and AT-2/AT-3 must be re-run on it.
   - Prices differ too, so the section 3 cost figures must be recomputed.
3. **Deadline.** Part 1 and Part 2 must finish before **November 30, 2026**.
4. **Outside the pilot.** After that date, typed chat and drafts fail on staging and on
   production unless the model is changed.
   - That is a production risk and needs its own owner decision and change.
   - It is not made here.

## 11. Execution approval request

I request approval to execute **Phase 1, Part 1 only**, on these terms:

- **Staging SHA:** `526f3779d5c6a551f015fd6b07e3bd0bbdaf7150` (staging release run
  38294065687). The tester confirms in Vercel that this SHA is live before starting. If it
  isn't, stop.
- **Accounts and roles:**
  - P1 OWNER (creates the org);
  - P2 MEMBER (invited by P1);
  - internal addresses only;
  - no entitlement grant;
  - P3 is needed only for optional AT-1, in Part 2.
- **Test subset:**
  - Part 1: A1–A2, B1–B5b, C1–C11, D1–D6 with D4b;
  - booking is cancel-and-record only;
  - Part 2 (AT-3, AT-2, optional AT-1) needs the separately authorized #309 + #310 release and
    a separate go.
- **Cost:**
  - estimated about $0.63 for Part 1's 13 chat messages, plus under $0.01 for titles;
  - the **$2.00 budget is not technically enforced**: the app has no spend cap, and the only
    hard limits are 50 messages a month, 5 tool rounds and 4,096 output tokens per call;
  - control is the section 3 stopping rule: hard stop at 13 messages, with retries only after
    the owner reads the actual spend in the Anthropic Console.
- **Known defects** (recorded, never counted as passes):
  - KD-1: chat names the onboarding industry over Business DNA;
  - KD-2: a cleared Business DNA industry still shows in chat;
  - KD-3: CRM phone search needs the exact formatting;
  - KD-4 (observation): chat-logged notes have no audit row of their own;
  - observation: chat may propose a booking, which is cancelled;
  - the chat model is deprecated (section 10).
- **Retained synthetic data** (no delete path; labelled `PILOT-001`):
  - the pilot organization;
  - its Business DNA;
  - conversations, notes and audit rows;
  - soft-deleted CRM rows (contacts are purged after 30 days).

## 12. Open items outside this phase

- **#316 (Voice contact identity):**
  - Implementation and standard CI (20/20) are complete.
  - **Not merge-ready:** real-PostgreSQL validation is outstanding (0 executed, 7 skipped).
  - It is a separate open gate; no infrastructure work or workflow was started.
  - Voice is excluded from this pilot.
- **#309 / #310:** merge #309, then #310, and ship both in one staging release (section 9).
  Include the owner-review note from 5.1.
- **Chat model migration** before November 30, 2026 (section 10). Owner decision; not part of
  this pilot.
- **Creator Studio:** deferred, together with its paid-usage approval and enablement.
- **#306 / #308:** not deployed. #306 is the invite return; #308 adds rate limits on
  invitations and Business DNA services.
