# Free pilot demo script (as of main `7a8c354`)

A 10–15 minute customer demonstration using only functionality that exists on main and works on
the FREE plan. Every claim below is backed by code; every item marked **VERIFY** depends on the
environment and must be rehearsed once before a customer sees it. Not marketing copy.

## Prerequisites (the day before)

- A demo organization on the environment you will show (staging serves `6339063`), owned by your
  demo account, with:
  - Business DNA saved: description, 3–5 services with durations and prices, opening hours,
    contact details, one policy (for example cancellation);
  - two or three knowledge documents (price list, FAQ) uploaded and indexed;
  - 5–10 contacts, 2 companies, 2–3 deals on the pipeline;
  - one active booking type with a public link; an availability schedule if the hours differ from
    Mon–Fri 09–17 Helsinki;
  - a second email address you control, for the invitation step.
- **VERIFY** the environment: `/api/health` healthy; chat answers; "Regenerate from website"
  works on a real site; a test booking's confirmation email arrives; an invitation email arrives.
- Decide the interface language with the customer (EN/FI/AR all work; Arabic is right-to-left).
- Have the FREE limits in mind: 50 AI messages per month per organization — do not burn them in
  rehearsal; 2 seats.

## The sequence

### 1. Explain the business once — Business DNA (2 min)

Open `/settings/business-dna`. Show the saved profile: services, hours, policies, key facts.

Say: "Everything Syveka's assistant says about your business comes from here, from your documents
and from your CRM. You fill it in once; every surface uses it."

Show "Regenerate from website" **only if VERIFIED**: it produces a preview from the customer's own
site; nothing is saved until you click save. Fallback: skip it and say the profile can also be
pre-filled from the website.

### 2. Show Syveka using that context — chat (3 min)

Open `/chat`. Ask, in the customer's language:

1. "What does [a service in the profile] cost and how long does it take?" → answered from the
   profile.
2. "Are you open on Saturday?" → answered from the profile hours.
3. Ask for something **not** in the profile, for example "Do you offer gift cards?" → the
   assistant says it cannot confirm it and points to the contact route or asks. Say: "It will not
   invent prices, hours or policies. That is deliberate."

Fallback if chat is unavailable: show the saved profile and the system's "no business profile"
behavior from the runbook; do not demo with a broken environment.

### 3. Ask ONE SYVEKA to do something useful (3 min)

In the same conversation:

1. "Create a contact for Anna Example, anna@example.com, interested in [service]." → a
   confirmation card shows exactly what will be created. Say: "Nothing is written until you
   confirm. Every action works this way." Confirm.
2. "What times are free on Thursday afternoon?" → availability from the calendar.
3. Optionally: "Book Anna for [service] on Thursday at 14:00." → confirmation card with the
   resolved duration; confirm.

Then open `/crm/contacts` and `/calendar`: the contact and the booking are there.
`/settings/audit-log` shows who did what.

### 4. CRM (2 min)

`/crm/contacts`, `/crm/companies`, `/crm/deals`: the pipeline board with the default stages, a deal
moved between stages, a note on a contact. Say what it is: a focused CRM for a small team, not a
replacement for an enterprise system. There is no CSV import today; say so if asked.

### 5. Booking (2 min)

Open the public booking link in a private window, signed out: pick a slot, book as a guest. Back
in `/calendar`, the booking appears. Mention the guest confirmation email (**VERIFY** it arrives
on this environment before claiming it live).

### 6. Team (1 min)

`/settings/members`: invite your second address with a role, open the email, accept. Explain roles
(owner, admin, manager, member, viewer). Mention: two seats on the free pilot unless agreed
otherwise.

### 7. What the pilot includes (1 min)

Business DNA, the assistant, CRM, booking and calendar, team access, knowledge documents, in the
customer's language; free for the agreed period; Ehab onboards them personally.

### 8. What is intentionally not enabled yet (1 min)

Point at the visible menu items and name them: Voice (phone assistant), Workflows, Inbox, Creator
Studio. Say they exist in the product but are not part of this pilot and will not be switched on
without a separate agreement. Billing is not part of the pilot.

## Fallbacks

| If…                                   | Then…                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Chat returns an error                 | Stop the AI part; show Business DNA, CRM and booking. Do not retry in front of the customer.        |
| Website extraction fails              | Skip it; the profile is already filled.                                                             |
| No confirmation email arrives         | Show the booking in the calendar; say email delivery is being set up for their environment.         |
| Invitation email does not arrive      | Show the pending invitation in the members list; accept it later. Note: it holds a seat for 7 days. |
| A limit message appears (402 / quota) | Explain FREE limits honestly; grants exist for pilots.                                              |

## Claims Ehab can safely make

- The assistant answers only from the business profile, documents and CRM, and says when it cannot
  confirm something.
- Every action the assistant proposes is shown first and runs only after the user confirms it.
- Each organization's data is isolated; roles control who can do what; actions are logged.
- Works in English, Finnish and Arabic (right-to-left).
- Booking links work without connecting an external calendar.

## Claims Ehab must not make

- Anything about phone/voice answering, automated workflows, a shared inbox or content generation
  being part of this pilot.
- "GDPR compliant", automatic deletion, complete erasure of a person by deleting a contact,
  immediate removal from backups, or self-service data export (see
  `pilot-data-requests-runbook.md`).
- That the privacy policy, terms or DPA on the website are final or list every subprocessor: they
  are placeholders pending counsel.
- CSV import, integrations beyond the calendar providers configured on the environment, or an
  external calendar connection unless VERIFIED on that environment.
- Any price, discount or upgrade path (billing is not part of the pilot).
- Uptime or response-time guarantees.
- That the AI "learns" from conversations: it reads the profile, documents and CRM; it does not
  train on the customer's data (do not claim more about provider retention than the providers'
  terms say).

## Known pilot limitations (say them before the customer finds them)

- 50 AI messages per organization per month on FREE unless granted more.
- 2 seats; pending invitations count and cannot be revoked for 7 days.
- 200 contacts; no import.
- Default availability is Helsinki time until a schedule is saved.
- Four menu items are visible but not part of the pilot.
- A few labels are English only.
