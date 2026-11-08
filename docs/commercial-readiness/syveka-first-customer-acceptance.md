# Syveka — first pilot customer acceptance checklist (2026-11-08)

## How to run it

Run this checklist on the environment that will host the pilot. Use the dedicated test
organization first, then repeat the key steps with the pilot customer present. Keep the
evidence (screenshots, the times shown, the `/api/health` body) in the pilot record.

- Use synthetic people and email addresses you control. Send no message to a real third
  party.
- **Prerequisites:** release gates G-CI, G-DATA, G-DEP, G-PAY and G-MON pass
  (`syveka-release-gates.md`).
- Mark each step with one of:
  - **P**: pass
  - **F**: fail; note what you saw
  - **N**: not run; give the reason

## A. Automated checks (owner dispatches, or CI)

| #   | Check                                                                                     | Command or workflow                                                                           | Result |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| A1  | Required CI on the release SHA is green                                                   | `ci.yml` on the PR/merge                                                                      |        |
| A2  | Staging release validation (migrations, invariants, RLS, Playwright smoke + Business DNA) | `staging-release.yml` (owner dispatch)                                                        |        |
| A3  | Opt-in auth and invite journeys on the stable staging host                                | `staging-invite-journeys.yml` / `auth-journeys.spec.ts`                                       |        |
| A4  | `/api/health` → `healthy`, `database: ok`, `redis: ok`, `build` = release SHA             | `curl https://<host>/api/health`                                                              |        |
| A5  | Booking and chat-confirm journeys in a real browser against faked APIs (#418, #422)       | `npm run test:browser` (local; set `PW_CHROMIUM_EXECUTABLE_PATH` for a preinstalled Chromium) |        |
| A6  | The same journeys on the deployed pilot environment                                       | owner-observed, §B journeys 2 and 3                                                           |        |

## B. Manual journeys

Use a phone (Android Chrome and iOS Safari if available) and a desktop. Run them in Finnish
first, then English, then Arabic. Time zone: Europe/Helsinki.

### Journey 1: a new business gets started

| #   | Step                                                                                                                          | Expected                                                                                          | Result |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| 1.1 | Register with a new email you control; open the verification link                                                             | Lands on onboarding, not the dashboard                                                            |        |
| 1.2 | Create the organization (name, Finnish locale)                                                                                | Dashboard opens; organization name shown                                                          |        |
| 1.3 | Superadmin: open `/admin/organizations/<orgId>`; add grants (seats, contacts, AI messages, KB MB) with an expiry and a reason | Grants listed; the audit log shows `entitlement_grant.create`; new limits apply within about 60 s |        |
| 1.4 | Settings → Business DNA: fill in the services, hours, tone; save; reload                                                      | Values persist; no error                                                                          |        |
| 1.5 | CRM → add a customer contact; reload                                                                                          | Contact persists and appears in search                                                            |        |
| 1.6 | Invite a second member as MEMBER; accept in another browser                                                                   | The member sees the org; can't open Settings → Members management                                 |        |

### Journey 2: salon booking

| #    | Step                                                                                                                             | Expected                                                                                                       | Result |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 2.1  | Calendar → booking types: create "Hiustenleikkaus 45 min", buffer after 15 min                                                   | Saved                                                                                                          |        |
| 2.2  | Availability: Mon–Fri 09:00–17:00, plus a date override that closes one day                                                      | Saved; the closed day shows no slots                                                                           |        |
| 2.3  | Open the public booking page on a phone, logged out                                                                              | Slots in local time; the closed day is empty                                                                   |        |
| 2.4  | Book a slot as guest "Anna Testi" `<your-alias>+anna@…` with consent                                                             | Confirmation page; a confirmation email arrives; the event appears in the calendar; the contact appears in CRM |        |
| 2.5  | In a second browser, try the same slot at the same time                                                                          | Slot taken / no longer offered; no second event                                                                |        |
| 2.6  | Book again with the same email in different capitalization (`Anna+…@`)                                                           | **Same** CRM contact, not a new one (fixed in this branch)                                                     |        |
| 2.7  | Use the manage link: reschedule to another slot                                                                                  | Old event canceled; new event shown; reschedule email; the contact keeps both meetings                         |        |
| 2.8  | Use the manage link: cancel                                                                                                      | Event canceled; the slot is offered again                                                                      |        |
| 2.9  | After a booking's start time has passed, open its manage link and try to reschedule                                              | Refused (fixed in this branch); the visit stays in the calendar                                                |        |
| 2.10 | DST: view availability for Sunday 2027-03-28 (spring forward) and Sunday 2027-10-31 (fall back) with a rule spanning 02:00–05:00 | Each real hour offered once; times correct in local time                                                       |        |
| 2.11 | Owner cancels a booking from the calendar                                                                                        | Guest gets a cancellation email; status updated                                                                |        |

### Journey 3: AI business assistant

| #   | Step                                                                       | Expected                                                             | Result |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| 3.1 | Chat: "Mitkä ovat aukioloaikamme?"                                         | The answer uses Business DNA hours                                   |        |
| 3.2 | Upload the price-list PDF to the Knowledge Base; wait until it shows Ready | Status Ready; it does not stall more than 2 h                        |        |
| 3.3 | Ask about a price in the PDF                                               | The answer cites the document                                        |        |
| 3.4 | "Muuta lauantain aukioloajaksi 10–14"                                      | A proposed change with a preview; **nothing changes before Confirm** |        |
| 3.5 | Press Cancel; check Business DNA                                           | Unchanged                                                            |        |
| 3.6 | Repeat and Confirm; check Business DNA and the audit log                   | Changed once; an audit row with before and after                     |        |
| 3.7 | Double-tap Confirm / reload and confirm again                              | Applied once; a second confirm reports already decided               |        |
| 3.8 | A new chat: ask for Saturday hours                                         | The new hours                                                        |        |
| 3.9 | Repeat 3.4–3.6 in Arabic on a phone                                        | RTL layout readable; preview and buttons usable                      |        |

### Journey 4: CRM pipeline

| #   | Step                                             | Expected                                     | Result |
| --- | ------------------------------------------------ | -------------------------------------------- | ------ |
| 4.1 | Create a company; link the contact from 1.5      | Shown on both records                        |        |
| 4.2 | Create a deal for the contact and company        | It appears on the board without a reload     |        |
| 4.3 | Move the deal to the next stage; add an activity | Stage and activity persist; timeline updated |        |
| 4.4 | Open the dashboard                               | KPIs reflect the deal and contacts           |        |

### Journey 5: limits (free pilot)

| #   | Step                                                                                                     | Expected                                                                       | Result |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 5.1 | On a test org **without** grants, exceed 50 AI messages                                                  | A clear quota message; no model reply                                          |        |
| 5.2 | Upload files totalling more than 50 MB                                                                   | The quota message, at upload or at finalize; the total stays at or below 50 MB |        |
| 5.3 | Open Voice, Workflows, Creator Studio                                                                    | Unavailable or not offered on FREE                                             |        |
| 5.4 | Settings → Billing: confirm the pilot env Stripe key is test-mode/absent **before** anyone clicks a plan | No live charge possible                                                        |        |

### Journey 6: multi-tenant security (two test orgs, A and B)

| #   | Step                                                                                         | Expected                                                                      | Result |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| 6.1 | As a member of A, open B's contact, deal, document and booking-type URLs (ids copied from B) | 404 / not found, never B's data                                               |        |
| 6.2 | As A, chat: "show contacts of <B org name>"                                                  | Only A's data                                                                 |        |
| 6.3 | Use B's booking manage link while logged in as A                                             | Acts only on that booking (token-scoped); reveals nothing of A or B beyond it |        |
| 6.4 | As a VIEWER in A, try to confirm a Business DNA proposal                                     | Refused                                                                       |        |

## C. Voice AI: separate live-call acceptance (not part of the first package)

Run this only after explicit owner authorization for paid usage, with numbers and a budget
approved in writing:

1. Confirm which voice PRs are merged and deployed. Today #404–#411 and #415 are drafts.
2. Assistant activation does **not** buy a phone number unless approved (#380).
3. Calls only to and from team-owned numbers. One Finnish call, one English, one Arabic.
4. The spoken AI notice is heard at call start. The recording setting is respected (off by
   default per #410).
5. Post-call: the transcript, summary (in the call's language, #409), usage minutes and
   billing record each appear exactly once, even if the webhook is re-sent.
6. Concurrency cap: a second simultaneous call beyond the plan's slot count is refused
   gracefully.
7. Cost of each call reconciled against the Vapi dashboard.

## D. Sign-off

| Role                   | Name | Date | Decision |
| ---------------------- | ---- | ---- | -------- |
| Owner                  |      |      |          |
| Pilot customer contact |      |      |          |
