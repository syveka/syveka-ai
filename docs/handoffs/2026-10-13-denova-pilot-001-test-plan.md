# DENOVA Pilot #001 — staging test plan

Status: **ready for execution approval; not approved to run.** Scope approved by the owner on
2026-10-13 as an internal staging pilot with synthetic data and internal users only. Scope
approval is not approval to merge, deploy, spend or start. This plan uses only what is on
`main` / staging today (`526f3779`, staging release run 38294065687).

Ownership: the OLD Claude account owns the independent readiness review and the #315
investigation. This plan doesn't repeat either. Voice is excluded, so #316 doesn't gate it.

## 1. Scope

| In                                                                                  | Out (never touched during the pilot)                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Business DNA (settings page, services)                                              | Real customer data or communications                            |
| Typed chat: Preview → Confirm → Execute → Audit                                     | Live bookings, calendar booking, Timma                          |
| CRM: contacts, companies, deals, notes, deal tasks                                  | Voice calls, voice assistants, live voice chat                  |
| Creator Studio image drafts: **optional, only with a separate paid-usage approval** | Payments, `/settings/billing` checkout                          |
|                                                                                     | Publishing, social accounts, DNS, live sites, external accounts |

Also off-limits because they call paid or external services outside the scope: Business DNA
**"Regenerate from website"**, deal **AI insights**, inbox sending, workflows.

## 2. Prerequisites (each needs an explicit go at execution time)

1. **Staging build confirmed** as `526f3779` in Vercel. Nothing is deployed for the pilot.
2. **Pilot organization**: a new org named `DENOVA Pilot 001 (synthetic)`, created by an
   internal person through `/register` → `/onboarding`. Claude never creates accounts or
   enters passwords.
3. **Internal users** (internal addresses only; nobody outside the team):
   - P1 OWNER: runs Business DNA, chat-on-DNA and the audit log (`audit:view` is OWNER/ADMIN only).
   - P2 MEMBER: role checks (no Business DNA write, no CRM delete, no Creator approve/publish).
   - Optional P3 MANAGER: CRM delete and pipeline stages.
4. **Plan limits.** New orgs are FREE: 2 seats (pending invites count), **50 AI messages per
   month**, 0 Creator credits. A superadmin adds revocable grants at
   `/admin/organizations/[orgId]` with the reason "DENOVA Pilot 001":
   - `MAX_SEATS` +1 if P3 is used;
   - `AI_MESSAGES_PER_USER_MONTH` (adds pooled org messages), for example +200.
   - Grants don't change Stripe. Each chat message is a paid model call, so the owner approves
     the message budget.
5. **Synthetic data sheet**, prepared up front:
   - fictional business "DENOVA Demo Studio";
   - 6 contacts, 2 companies, 3 deals;
   - names marked `PILOT-001`, emails `@example.test`, phones in `+358 50 000 00xx` format
     (an unused range).
   - No real people, real businesses or real phone numbers.
6. **Redis (Upstash) healthy.** Chat confirmations and rate limits fail closed without it.
   - Symptom in chat: `confirmation_unavailable`.
   - Symptom on save: 503.
7. **Invitation email** goes through Resend to internal addresses only. Known gap: #306 is not
   deployed, so after signing up the invitee may need to reopen the invite link.
8. **Creator Studio (optional track E only).** Needs a separate approval covering:
   - the paid budget;
   - running `scripts/enable-creator-studio-for-org.ts`, which needs database credentials, so
     the owner runs it;
   - staging probably runs real fal.ai (there's no mock in a production build);
   - a consenting internal subject, or fully synthetic reference images (3 approved images
     needed).

## 3. Scenarios

Each row: do this, then expect that. "Audit" means the row visible in `/settings/audit-log`
(filter `?action=`).

### A. Access and setup

| #   | Steps                               | Expected                                                                                | Audit                          |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| A1  | P1 completes onboarding             | Dashboard, then `/settings/business-dna`; default pipeline has 6 stages on `/crm/deals` | `org.create`                   |
| A2  | P1 invites P2 as MEMBER; P2 accepts | P2 is in the org with role MEMBER                                                       | `member.invite`, `member.join` |

### B. Business DNA

| #   | Steps                                                        | Expected                                              | Audit                                           |
| --- | ------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------- |
| B1  | P1 fills identity, voice, policies, pricing; saves           | Values persist after reload                           | `business_dna.create` / `.update`               |
| B2  | P1 adds 2 services, deactivates 1                            | Active list shows 1; the inactive one can be restored | `business_dna_service.create` ×2, `.deactivate` |
| B3  | Open the page in two tabs; save in tab 1, then save in tab 2 | Tab 2 is refused as stale; tab 1's values stay        | one `.update` only                              |
| B4  | P2 opens Business DNA                                        | Read-only; no save                                    | none                                            |
| B5  | P1 clears a field (for example target customer) and saves    | Field stays empty after reload                        | `business_dna.update`                           |

**Known issue for B5:** #309/#310 are not on staging. If onboarding was given an industry and
the Business DNA industry is later cleared, chat can still name the onboarding industry. Log
it as known (#310), not as a new defect.

### C. Chat: Preview → Confirm → Execute → Audit

| #   | Steps                                                                                  | Expected                                                                                    | Audit                                                               |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| C1  | P1: "Add contact PILOT-001 Aino Testi, aino@example.test"                              | Preview card; nothing written yet. **Confirm**, then the contact appears in `/crm/contacts` | `ai_action.confirm` (outcome `done`), `contact.create`              |
| C2  | Same request with another name, then **Cancel**                                        | No contact                                                                                  | `ai_action.cancel`                                                  |
| C3  | P1: "Set our cancellation policy to 24 h notice"                                       | Before/after diff card; **Confirm**, then the settings page shows it                        | `ai_action.confirm` (`done`), `business_dna.update` (via `ai_chat`) |
| C4  | Propose a Business DNA change in chat; change the same field in settings; then Confirm | Outcome "not done (stale)"; the settings value stays                                        | `ai_action.confirm` (`stale`/`not_done`), no `business_dna.update`  |
| C5  | Propose any change, wait more than 10 min, then Confirm                                | Expired or unavailable; nothing written                                                     | none                                                                |
| C6  | Click Confirm twice quickly, or reopen and confirm again                               | Exactly one write; the second attempt is refused                                            | one `ai_action.confirm`                                             |
| C7  | "Log a note on Aino: called about pricing", then Confirm                               | Note on the contact page                                                                    | `ai_action.confirm` only (known: no separate note audit)            |
| C8  | "Create it without asking me"                                                          | A preview card still appears; no direct write                                               | as C1/C2                                                            |
| C9  | "Which contacts do we have from Example Oy?"                                           | Answer with no confirmation card (read-only)                                                | none                                                                |
| C10 | P2 asks to change Business DNA                                                         | No proposal (no permission); chat says so                                                   | none                                                                |
| C11 | P1 opens a new chat while Business DNA is incomplete                                   | Chat asks for one missing field at a time                                                   | none                                                                |

**Booking guard:** never ask chat to book. If chat proposes `bookMeeting`, press **Cancel**,
record it, and check there is no `calendar.book` row. `bookMeeting` is offered to MEMBERs too;
it isn't behind a flag.

### D. CRM (manual)

| #   | Steps                                                                  | Expected                       | Audit                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| D1  | Create 2 companies and 5 contacts; link contacts to a company          | Lists and detail pages correct | `company.create`, `contact.create`       |
| D2  | Create 3 deals; move one through each stage to Won, one to Lost        | Kanban and deal pages correct  | `deal.create`, `deal.stage_change`       |
| D3  | Add notes on a contact, company and deal; add and complete a deal task | Visible on each page           | `.note`, `deal.task.create`              |
| D4  | Search contacts by name, email and a phone typed exactly as stored     | Found                          | none                                     |
| D5  | P2 tries delete                                                        | No delete control or refused   | none                                     |
| D6  | P1/P3: archive, restore, then delete a contact                         | Status moves as expected       | `contact.archive`, `.restore`, `.delete` |

**Known issue for D4:** phone search is a plain substring match. A phone stored as
`+358 50 000 0001` is not found by `0500000001` or `+358500000001` (finding F4 in the
2026-10-13 night handoff). Log it as known.

### E. Creator Studio image drafts (only if separately approved)

| #   | Steps                                                                            | Expected                                                  | Audit                                                                            |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| E1  | Owner enables the flag and credits for the pilot org only                        | `/creator-studio` opens; balance shows the floor          | script GRANT ledger entry                                                        |
| E2  | Create a profile, confirm consent, upload 3 references                           | References approved                                       | `creator.profile.create`, `.consent_confirmed`, `creator.reference_asset.create` |
| E3  | Generate 1–2 character images                                                    | Draft images in Library; credits reserved, then committed | `creator.generation.complete`                                                    |
| E4  | Create a post as DRAFT; **don't** request approval, schedule or connect accounts | Stays DRAFT; nothing published                            | `creator.post.create`                                                            |
| E5  | P2 (MEMBER) looks for approve/publish                                            | Not available                                             | none                                                                             |

Hard stop for track E: any spend beyond the approved budget, any social-account prompt, or
any `creator.post.scheduled` / `.published` row.

## 4. Stop conditions (pause and report)

- **P0:** a write without a Confirm click.
- **P0:** data from another organization visible.
- **P0:** an excluded feature starts (booking, voice, billing, publish, external send).
- **P0:** a real person's data entered.
- **P1:** a confirmed action without its audit row, other than C7's known gap.
- **P1:** a stale or expired action that wrote data.
- **P1:** a role able to do what its table says it can't.
- **P2:** wording, layout or translation issues.

## 5. Evidence to collect

Per scenario:

- scenario id, tester, UTC time, result (PASS / FAIL / KNOWN);
- a screenshot of the preview card and of the result;
- the matching audit-log row (action, actor, time);
- the conversation URL for chat cases.

Store screenshots in the owner's internal location, not in the repo. They show internal email
addresses.

Evidence comes only from the UI and the audit log: no database queries and no log exports.
Final summary: pass/fail counts, defects by P0–P2, AI messages used against the grant, and
Creator credits used (if E ran).

## 6. Cleanup (after the pilot)

What the app can do today:

1. Let unconfirmed actions expire (10 min). Nothing to do.
2. Soft-delete the pilot contacts, companies and deals in the UI (OWNER or MANAGER).
   - Contacts are purged automatically after 30 days.
   - Companies and deals stay soft-deleted.
3. Deactivate the Business DNA services; clear Business DNA fields if wanted.
4. Remove P2/P3 from the org; revoke any pending invitations.
5. Revoke the entitlement grants (superadmin, `/admin/organizations/[orgId]`).
6. Creator Studio (if used):
   - no posts scheduled;
   - no social accounts connected;
   - turning the flag off needs the owner's database access (separate decision).

What can't be removed without direct database work (a separate, explicit approval; not part
of this plan):

- conversations, activity notes and audit rows;
- Creator Studio profiles, images and posts (media stays in the `creator-generated-media`
  bucket);
- the organization itself (no delete feature).

All of it is synthetic and labelled `PILOT-001`. The default is to keep the org as an inactive,
clearly labelled test tenant.

## 7. Open items outside this pilot

- **#316 (Voice contact identity):** implementation and standard CI (20/20) are complete. Not
  merge-ready: real-PostgreSQL validation is outstanding (0 executed, 7 skipped). It is a
  separate follow-up; no workflow created or dispatched. Voice is excluded here, so it doesn't
  block the pilot.
- **#309 / #310:** Draft, CI green, awaiting merge approval (merge #309 first). Until they are
  deployed, see B5's known issue.
- **#306 / #308:** not deployed. The invite-return gap (#306) and the missing rate limits on
  invitations and Business DNA service changes (#308) apply during the pilot.
