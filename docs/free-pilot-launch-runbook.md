# Free pilot launch runbook (as of main `7a8c354`)

How to put one real small business on Syveka as a controlled, free pilot using only what the code
on main does today. Every step below was read from the repository; nothing here was executed
against a live environment in the session that wrote it. Steps marked **VERIFY** depend on
deployment configuration that the repository cannot show and must be checked once on the target
environment before the first customer.

Companion documents: `pilot-entitlement-grants-runbook.md` (limits and grants),
`pilot-data-requests-runbook.md` (deletion and export), `free-pilot-demo-script.md` (the demo).

## 1. The pilot package

**Working name:** Syveka AI Business Assistant — controlled free pilot.

| Included (works on the FREE plan today) | What the customer gets                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business DNA                            | A business profile (services, prices, hours, policies, key facts) entered once, optionally pre-filled from the company website; every AI surface reads it                                                                   |
| ONE SYVEKA chat                         | An assistant that answers from the business profile and knowledge documents, searches and creates CRM contacts, logs activities, checks availability and books meetings — every write shown first and confirmed by the user |
| CRM                                     | Contacts, companies, deals on a default pipeline ("Myyntiputki", 6 stages), notes and tasks                                                                                                                                 |
| Booking / calendar                      | Internal calendar, booking types with a public booking link, availability schedules, guest confirmation email                                                                                                               |
| Team access                             | Invitations with roles (OWNER, ADMIN, MANAGER, MEMBER, VIEWER), audit log                                                                                                                                                   |
| Knowledge base                          | Document upload and search used by the assistant (50 MB on FREE)                                                                                                                                                            |

| Intentionally not enabled | Why                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Voice (phone assistant)   | 0 assistants on FREE and needs Vapi configuration; the voice grounding work (#329 voice slice, #335) is not merged        |
| Workflows                 | 0 active workflows on FREE; AI-step grounding (#330) is not merged; no live staging evidence yet                          |
| Inbox                     | Needs a mail domain and webhook secrets; cannot be switched off per organization, so it stays visible but empty (see §10) |
| Creator Studio            | Behind the `creator_studio_v1` flag, off by default                                                                       |
| Paid billing              | Stripe hardening (#342, #343) not merged; the pilot is free                                                               |

FREE limits that apply unless raised by a grant: 2 seats, 50 AI messages per organization per
month, 200 contacts, 50 MB documents. See the grants runbook.

## 2. Preconditions (operator, once per environment) — VERIFY

The application fails closed without these; a missing one looks like a broken feature to the
customer.

| Needed for                                        | Configuration                                                                            | Symptom if missing                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Sign-up and password reset emails                 | Supabase Auth SMTP; `/api/auth/callback` in the Auth redirect allow-list                 | "verify your email" never arrives                                                                   |
| User rows                                         | `handle_new_user` trigger applied (migration `20260719000000_initial_security_baseline`) | organization creation fails after sign-up                                                           |
| AI chat, website extraction                       | Anthropic key, `OPENAI_API_KEY` (moderation and embeddings), Upstash Redis               | chat returns an error; extraction returns 503/502                                                   |
| Invitations, booking confirmations, notifications | `RESEND_API_KEY`, `EMAIL_FROM`                                                           | invite reports "failed" (and still holds a seat, §8); bookings succeed without a confirmation email |
| Reminders, 30-day purge                           | QStash schedule registered                                                               | reminders never go out; soft-deleted rows are never purged                                          |
| Public links                                      | `NEXT_PUBLIC_APP_URL` set to the customer-facing host                                    | booking links point at the wrong host                                                               |
| Grants                                            | A superadmin user (`app_metadata.is_superadmin = true`, set in the Supabase dashboard)   | nobody can raise a limit                                                                            |

Also decide **which environment** hosts the pilot. Staging currently serves `6339063` and is
validated by the release workflow; main has since moved to `7a8c354` (#347, #349) without a staging
release, and production has not been released in this series of batches.

## 3. Create or identify the pilot organization

The customer does this themselves; nothing requires the operator:

1. `/register`: name, email, password (12 characters minimum). The account is created after the
   verification email link is opened **in the same browser**.
2. The link lands on `/onboarding`: organization name (required), business ID and industry
   (optional).
3. Creating the organization gives it: the OWNER membership, the FREE subscription, the default
   pipeline. It creates **no** Business DNA row, availability schedule or booking type (those are
   §4 and §7).
4. The user is redirected to `/settings/business-dna`.

Alternative: Ehab creates the organization as the owner and invites the customer as ADMIN. That
uses one of the two FREE seats for Ehab; grant `MAX_SEATS` first if the customer needs two seats
of their own.

## 4. Business DNA

- `/settings/business-dna`. Everything is optional and the page can be skipped. The assistant
  degrades honestly when the profile is empty: it says it has no business profile instead of
  inventing facts, and it can propose profile updates from chat for the user to confirm.
- "Regenerate from website" fills a **preview** from the company website; nothing is saved until
  the user saves. Rate-limited to 5 per hour per organization.
- Services (name, duration, price) can be added only **after** the profile has been saved once.
- Save at least: description, services with durations (bookings use them), opening hours, contact
  details, prices or price ranges if the customer wants the assistant to quote them, and
  policies. The assistant quotes only what is in the profile.

## 5. Pilot entitlements

Nothing is required to start. Apply grants from `/admin/organizations/<orgId>` only when the
customer needs more than FREE allows (seats, AI messages, contacts, storage), with an expiry date
equal to the pilot's end. Procedure, audit trail and rollback: `pilot-entitlement-grants-runbook.md`.

## 6. CRM readiness

- Contacts and companies start empty with an empty-state message; deals use the default pipeline.
- 200 contacts on FREE (the check is on contact creation only). For a customer importing a list,
  grant `MAX_CONTACTS` first. There is no CSV import in the UI; contacts are created one by one, or
  by the assistant from chat (each creation is confirmed by the user).
- The assistant's CRM tools: search contacts, create contact, log activity. Deletion is a soft
  delete with a 30-day purge.

## 7. Booking / calendar setup (customer, with Ehab on the first call)

1. **Create at least one active booking type** at `/calendar/booking-types` (name, duration,
   notice period, consent text). Without one, the public page returns "not found". The public link
   is shown on that page.
2. **Availability**: without a schedule, bookings use Monday–Friday 09:00–17:00 in
   **Europe/Helsinki**. Create a schedule at `/calendar/availability` if the business works other
   hours or is outside Finland. One default schedule per owner.
3. **External calendar is optional.** Conflicts are checked against Syveka's own calendar. Google
   or Microsoft connection needs provider configuration on the deployment (VERIFY if the customer
   asks for it).
4. Test the public link once: open it signed out, book a slot, confirm the booking appears in
   `/calendar` and that the guest confirmation email arrives (needs Resend; the booking succeeds
   even if the email does not).
5. Reminders need the QStash schedule (VERIFY).

## 8. Invitations

- `/settings/members`: invite by email with a role. FREE allows 2 seats including the owner;
  pending invitations count as seats. The email goes through Resend.
- Known friction: **a pending invitation cannot be revoked in the UI** on main (a fix is proposed
  in #350, unmerged). A mistyped address, or an invitation whose email failed to send, holds its
  seat until it expires after 7 days. Re-inviting the same address refreshes the same invitation
  (no extra seat); inviting a different address needs a free seat. Workaround: grant `MAX_SEATS`
  for the pilot, or wait 7 days.
- Acceptance is self-service and handles sign-up, sign-in, a wrong account and another browser
  (#337, #338). The accept page explains every failure (expired, seat limit, read-only, already a
  member) in the reader's language.

## 9. Features enabled

Business DNA, ONE SYVEKA chat (with CRM, knowledge and booking tools), CRM, booking/calendar,
invitations and roles, knowledge documents, dashboard with a setup-readiness card, notifications,
audit log, EN/FI/AR interface with right-to-left Arabic.

## 10. Features intentionally disabled, and how that looks to the customer

| Feature        | What the customer sees                                                                                           | Operator note                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Voice          | Nav item visible; page shows the upgrade card (0 assistants on FREE)                                             | Do not grant `VOICE_ASSISTANTS`                                                                   |
| Workflows      | Nav item visible; workflows can be drafted but not activated or test-run (0 on FREE)                             | Do not grant `ACTIVE_WORKFLOWS`                                                                   |
| Inbox          | Nav item visible to every role; the page stays empty unless the deployment has a mail domain and webhook secrets | Cannot be hidden per organization without a code change; say "not part of the pilot"              |
| Creator Studio | Nav item visible; the page says the feature is disabled                                                          | Flag stays unset                                                                                  |
| Billing page   | `/settings/billing` shows the FREE plan card; plan changes go to Stripe Checkout                                 | Tell the customer not to upgrade during the free pilot; billing hardening (#342/#343) is unmerged |

Tell the customer up front that these four menu items are visible but not part of the pilot.

## 11. Verification checklist (do once per pilot, in order)

- [ ] Preconditions in §2 verified on the target environment.
- [ ] Register → verification email → onboarding → `/settings/business-dna` works end to end.
- [ ] Business DNA saved; one service with a duration exists.
- [ ] Ask the assistant for a price or opening hour that **is** in the profile → it answers from the
      profile. Ask for one that **is not** → it says it cannot confirm it.
- [ ] Ask the assistant to create a contact → a confirmation card appears; confirm → the contact
      exists in `/crm/contacts`.
- [ ] One active booking type; the public link books a slot; the booking shows in `/calendar`.
- [ ] One invitation sent and accepted by a second person (or by Ehab's own second address).
- [ ] `/settings/audit-log` shows the actions above.
- [ ] Grants applied (if any) show on `/settings/billing` within a minute.
- [ ] `/api/health` on the environment reports `healthy`, `database: ok`, `redis: ok`.

## 12. Known limitations to state in the pilot agreement

- 50 AI messages per organization per month on FREE unless granted more; the assistant tells the
  user when the quota is reached.
- Invitations cannot be revoked (7-day expiry); seats are limited.
- No CSV import.
- Guest booking confirmations and invitation emails depend on the email provider; bookings still
  succeed without the email.
- The assistant quotes only what the profile and connected data contain; it will say "I can't
  confirm" rather than guess.
- Organization deletion, data export and the erasure of one person's data are manual (see the
  data-requests runbook). Deleting a contact removes that record only; bookings, deals, messages
  and audit entries about the same person are separate records.
- Deleted data remains in database backups and recovery dumps until their retention expires; the
  retention period is not yet confirmed (data-requests runbook §6).
- The public privacy, terms and DPA pages are placeholders pending counsel; the subprocessor list
  on them is incomplete (data-requests runbook §7).
- English copy appears in a few places (for example the "Name" label on the registration form).

## 13. Rollback / disable procedure

- **Stop a pilot but keep data:** revoke the organization's grants (admin page). Members keep
  signing in on plain FREE limits. Optionally remove extra members at `/settings/members`.
- **Lock out all members:** there is no "suspend organization" button. Removing memberships one by
  one (owner cannot be removed) is the only in-app option; otherwise an operator sets
  `organizations.deleted_at` manually, which makes the application treat the organization as
  inactive (same first step as erasure).
- **Delete everything:** manual, see `pilot-data-requests-runbook.md` §4.
- **Undo a grant made by mistake:** revoke it; nothing else changes.

## 14. Support / escalation

- First line: Ehab, by the email given in the pilot agreement. The customer's own OWNER/ADMIN can
  manage members, Business DNA, booking types and schedules without Syveka.
- Operator views: `/admin/organizations` (usage, plan, grants), the organization's
  `/settings/audit-log`, `/api/health`.
- Logs: Vercel request logs and Sentry (scrubbed errors) for the deployment; structured events such
  as `invite_member_failed`, `middleware_session_check_failed`, `public_assistant_failed` carry
  error names only, never customer text.
- A suspected cross-tenant issue is a stop-the-pilot event: report it, do not debug on the
  customer's data.

## 15. What must never be promised

- That the assistant knows anything not in the business profile, documents or CRM.
- That any action happens without the user confirming it (every write is confirm-first).
- Phone/voice answering, workflow automation, a shared inbox or content generation as part of this
  pilot.
- Automatic or self-service data deletion or export, or "GDPR compliant".
- That deleting a contact erases every record about that person, or that deleted data is removed
  from backups at once.
- That the website's privacy policy, terms or DPA are final, or that they list every subprocessor.
- Email-based features working if the environment's email provider is not configured.
- Uptime or support response times beyond what Ehab can personally keep.
- A price or discount for a paid plan (billing is not part of the pilot).
