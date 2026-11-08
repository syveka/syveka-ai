# Syveka — first commercial release: what to offer first (2026-11-08)

## Recommendation

Start with a **controlled free pilot of "Syveka Business Starter"**: 3–5 hand-picked Finnish
appointment-based small businesses, on the FREE plan raised by admin grants. Payment comes
later; this is not a public paid launch.

The package is the smallest coherent product whose whole journey exists in the code and has
automated coverage:

> **"Your customers book themselves online, every booking lands in your CRM, and an assistant
> that knows your business answers your questions and keeps your business profile up to date —
> with your confirmation."**

A paid launch should follow only once the paid-launch gates in `syveka-release-gates.md` §2
pass. On current evidence the earliest is after the pilot, not before.

## Included

| Feature                                                                                                                                                                   | Why it's in                                                                                             | Limits for the pilot                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sign-up, organization, onboarding, team invitations and roles                                                                                                             | Needed to use the product at all; reviewed with no privilege-escalation path                            | FREE has 2 seats; raise with a `MAX_SEATS` grant                                                                       |
| Business DNA (form, plus chat-proposed changes with preview and confirm)                                                                                                  | The independent review found no defects; it feeds every AI answer                                       | Owner must observe chat confirm once on staging (B4)                                                                   |
| CRM: contacts, companies, deals, pipeline board, activities, dashboard                                                                                                    | Mature, tenancy-checked, covered by smoke E2E                                                           | 200 contacts on FREE; raise with a `MAX_CONTACTS` grant. No CSV import: the first data load is manual or assisted      |
| Booking and calendar: booking types, weekly availability and date overrides, public booking page, guest manage link, internal calendar, email confirmations and reminders | The clearest value for appointment businesses; strong conflict protection; defects fixed in this branch | No Google/Microsoft calendar sync (not configured, untested). Reminders depend on QStash schedules (B8)                |
| AI assistant (typed chat) with CRM, Business DNA, KB and booking tools (confirm-first writes)                                                                             | Differentiator; the quota is checked before any model call                                              | FREE has 50 messages/org/month; raise with an `AI_MESSAGES_PER_USER_MONTH` grant per the runbook. Watch spend manually |
| Knowledge base: upload PDF/DOCX/text, notes, URLs                                                                                                                         | Grounds the assistant in the business's own material                                                    | 50 MB on FREE (now actually enforced); raise with a `KB_STORAGE_MB` grant                                              |
| Audit log                                                                                                                                                                 | Trust and support                                                                                       | FREE has 0 days of retention display (plan feature)                                                                    |
| Finnish, English, Arabic (RTL) UI                                                                                                                                         | Built and parity-checked                                                                                | Arabic/mobile chat layout not yet owner-observed                                                                       |

## Excluded from the first release

| Feature                                        | Reason                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paid subscriptions (Stripe Checkout, portal)   | <ul><li>No Checkout session ever completed</li><li>#394 open (an unpaid upgrade can grant Pro)</li><li>No dunning</li><li>Placeholder legal texts</li></ul>  |
| Voice AI (phone and voice chat)                | <ul><li>Unmerged draft PR stack (#404–#411, #415)</li><li>Needs live paid calls</li><li>Number auto-purchase (#380)</li><li>AI notice legal review</li></ul> |
| Unified inbox / email                          | No application path creates the mailbox; Resend inbound domain is an owner action. Hide it or label it "coming soon"                                         |
| Workflows                                      | 0 on FREE; the grants runbook says don't grant                                                                                                               |
| Creator Studio, social publishing, HyperFrames | Variable generation cost; feature flag off; TikTok/YouTube are mocked or blocked; HyperFrames is experimental                                                |
| External calendar sync (Google/Microsoft)      | Not configured; OAuth never exercised                                                                                                                        |
| API keys / webhooks                            | Page hidden; `apiWebhooks` false on every plan                                                                                                               |

## Is a simpler package safer?

Yes, if the owner wants the fastest possible first customer: **Booking + CRM only**, with the
assistant off or at the FREE 50 messages.

That variant:

- removes the main variable cost (AI);
- removes the only journey that was never owner-observed (chat confirm);
- still delivers the core value: online booking that fills the CRM.

The recommended package keeps the AI assistant because it is what separates Syveka from
generic booking tools. The extra risk is limited to cost and to the B4 observation, both
manageable in a 3–5 customer pilot.

## Commercial reality (assumptions, labelled)

These come from reading the code, not from market data. No customer interviews or competitor
pricing were used.

- **Likely fits (assumption):** single-location appointment businesses with 1–5 staff, where
  one owner manages one calendar per staff member. Examples: hair and beauty salons, massage,
  physiotherapy, personal trainers, consultants.
- **Manual work still needed per pilot:**
  - organization grants by a superadmin;
  - the initial contact import (there is no CSV);
  - legal and data-processing terms in a pilot agreement;
  - GDPR export and deletion handled by runbook;
  - knowledge-base documents that fail embedding must be re-added by the user.
- **Can a customer finish the main journey without a developer?** The code supports it:
  sign-up → onboarding → booking type → availability → share the link → bookings appear in
  the calendar and CRM. It has not been demonstrated end to end on the release to be deployed
  (gate G-JOURNEY).
- **Variable cost:** AI chat (Anthropic), embeddings (OpenAI), transactional email (Resend).
  See `syveka-commercial-cost-assumptions.md`. No price is recommended until cost per active
  organization is measured.
- **Privacy and regulation:** customers' end-client personal data (names, emails, phone
  numbers, booking notes) is stored. The EU region is claimed in the placeholder policy, and
  each sub-processor's region should be confirmed in the final DPA. AI providers receive
  business context and CRM data that is relevant to each request.
