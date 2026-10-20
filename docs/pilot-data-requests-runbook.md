# Pilot data-requests runbook (as of main `6339063`)

What Syveka can and cannot do today when a pilot customer, or a person whose data a pilot customer
stored, asks for access, export, correction or deletion. This is an inventory of the code on main,
written so Ehab knows what is a button, what is a manual step, and what has to be checked at a
provider. **It is not a legal assessment and does not claim compliance.** For the implementation
plan, see `docs/gdpr-readiness-plan.md`.

Classification used below:

- **IMPLEMENTED** — code exists and is tested;
- **WIRED** — reachable from the app by the named role;
- **MANUAL** — possible only with database or provider access by an operator;
- **NOT IMPLEMENTED** — nothing in the repository does it;
- **PROVIDER VERIFICATION REQUIRED** — depends on a third party's retention or deletion behavior
  that the repository cannot show.

## 1. Summary

| Request type                                                        | Status today                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Delete one CRM record, document, conversation, company, deal, event | IMPLEMENTED + WIRED (soft delete; some purged after 30 days, see §3) |
| Remove a team member from an organization                           | IMPLEMENTED + WIRED (OWNER/ADMIN)                                    |
| Delete a whole organization                                         | IMPLEMENTED but **NOT WIRED**; effectively MANUAL (§4)               |
| Export an organization's data                                       | NOT IMPLEMENTED                                                      |
| Delete a person's user account                                      | NOT IMPLEMENTED                                                      |
| Export a person's own data                                          | NOT IMPLEMENTED                                                      |
| Delete data held by processors                                      | PROVIDER VERIFICATION REQUIRED (§6)                                  |
| Audit-log retention by plan                                         | NOT IMPLEMENTED (display only)                                       |

**Practical consequence for the pilot:** the pilot agreement should say that organization deletion
and data export are handled manually by Syveka on request, with the timeline Ehab can actually
keep, and should not promise self-service deletion or export.

## 2. Where personal data lives (current main)

| Store                                                      | What                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres (Supabase)                                        | `users`, `organizations`, `organization_members`, `invitations`, Business DNA, CRM (contacts, companies, deals, activities, notes), bookings, calendar events and connections (encrypted OAuth tokens), conversations and messages, inbox threads/messages/drafts, workflow runs, voice calls (transcripts), notifications, audit logs, usage records, entitlement grants, Stripe ids |
| Supabase Auth                                              | login identities (`auth.users`), app metadata                                                                                                                                                                                                                                                                                                                                         |
| Supabase Storage (7 buckets, `prisma/sql/004_storage.sql`) | `documents`, `voice-recordings`, `exports`, `creator-reference-assets`, `creator-generated-media`, `avatars`, `org-logos` (the last two are not written by current code)                                                                                                                                                                                                              |
| Upstash Redis                                              | rate-limit counters, idempotency keys, pending AI actions (10-minute TTL), entitlement cache (60 s)                                                                                                                                                                                                                                                                                   |
| Processors                                                 | see §6                                                                                                                                                                                                                                                                                                                                                                                |

## 3. Per-record deletion (what members can do themselves)

| Record                        | Delete path                                                                                 | Purge                                                          | Status                              |
| ----------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| CRM contact                   | soft delete (`deletedAt`)                                                                   | hard-deleted by the `usage-rollup` job when older than 30 days | IMPLEMENTED + WIRED                 |
| Knowledge document            | soft delete; the file and its chunks are removed at once                                    | row purged after 30 days by the same job                       | IMPLEMENTED + WIRED                 |
| Conversation                  | soft delete                                                                                 | purged after 30 days by the same job                           | IMPLEMENTED + WIRED                 |
| Company, deal, calendar event | soft delete                                                                                 | **no purge job**; rows stay until the organization is deleted  | IMPLEMENTED + WIRED (retention gap) |
| Booking                       | cancel/delete through the booking flow                                                      | no purge job                                                   | WIRED (retention gap)               |
| Team member                   | OWNER/ADMIN removes the membership; their calendar connections in that org are disconnected | the person's user account and authored records remain          | IMPLEMENTED + WIRED                 |

The 30-day purge runs only if the `usage-rollup` job is scheduled (QStash). **Needs verification**
that the schedule is registered in the environment used for the pilot.

Contacts carry a `gdprConsentAt` timestamp set at creation; there is no consent-withdrawal flow.

## 4. Organization deletion (the "delete everything" request)

What exists: a Supabase Edge Function `supabase/functions/gdpr-erasure` (merged in #290). It:

- accepts only a service-role bearer token;
- refuses unless `organizations.deleted_at` is set **and** at least 30 days old;
- first purges the organization's objects in the five org buckets (`documents`,
  `voice-recordings`, `exports`, `creator-reference-assets`, `creator-generated-media`), aborting
  before any database change if a Storage call fails;
- then deletes the organization row; every tenant table cascades (memberships, Business DNA, CRM,
  bookings, calendar, conversations, inbox, workflow runs, voice calls, notifications, usage,
  grants, **and audit logs**).

What does not exist:

- **nothing sets `deleted_at`** — no settings page, no superadmin button, no action. The function's
  precondition can only be met by a manual database update;
- **nothing calls the function** — there is no scheduled job, script or UI; whether it is even
  deployed to the target Supabase project is **not visible in the repository**;
- the `users` rows and Supabase Auth accounts of the members are not removed;
- the Stripe customer, if one exists, is not touched;
- no erasure receipt or evidence record is written (the audit log is deleted with the org).

**Manual procedure today (operator with database and Supabase access; every step must be verified
on staging first — none of this has been run in this session):**

1. Record the request (who, when, which organization) outside the system, because the
   organization's audit log will not survive the erasure.
2. Set `organizations.deleted_at` for the organization (SQL, by an operator). From that moment the
   application treats the organization as inactive.
3. After 30 days, invoke the Edge Function with the service-role key for that organization id
   (only if it is deployed to that project — verify first).
4. Separately remove the members' Supabase Auth users if they belong to no other organization
   (Supabase dashboard; the application has no code for this).
5. Handle processors per §6.

Until the plan in `docs/gdpr-readiness-plan.md` is built, promise customers a **manual** deletion
with a realistic lead time, not a self-service one.

## 5. Export

- Organization export: NOT IMPLEMENTED. The `exports` bucket exists but no code writes to it.
- Personal data export for one user: NOT IMPLEMENTED.
- Workaround today: an operator with database access can produce a manual extract. Treat this as a
  manual service with a lead time, and do not promise a specific format.

## 6. Processors used by current main

| Processor                             | What it receives or holds                                                               | Repository cleanup                                                                                  | Status                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Supabase (Auth, Postgres, Storage)    | everything in §2                                                                        | org erasure covers Postgres + 5 buckets; Auth users untouched                                       | partly IMPLEMENTED; Auth: NOT IMPLEMENTED |
| Anthropic                             | prompts and tool results at runtime (chat, inbox drafts, deal insights, workflow steps) | none                                                                                                | PROVIDER VERIFICATION REQUIRED            |
| OpenAI                                | text for embeddings and moderation; embeddings are stored locally and cascade           | none                                                                                                | PROVIDER VERIFICATION REQUIRED            |
| Vapi (voice; OFF in pilot)            | hosts call recordings; transcripts are copied locally                                   | no delete calls in code                                                                             | PROVIDER VERIFICATION REQUIRED            |
| Stripe (billing; OFF in pilot)        | customer record when billing is used                                                    | none                                                                                                | PROVIDER VERIFICATION REQUIRED            |
| Resend                                | outbound email (invitations, notifications), inbound inbox webhook                      | none                                                                                                | PROVIDER VERIFICATION REQUIRED            |
| Google / Microsoft calendar           | OAuth tokens (encrypted) and synced events                                              | per-connection disconnect revokes the grant (best effort) and clears tokens; not run by org erasure | IMPLEMENTED for disconnect only           |
| fal.ai (Creator Studio; OFF in pilot) | prompts and reference assets; outputs copied to Storage                                 | none at provider                                                                                    | PROVIDER VERIFICATION REQUIRED            |
| Upstash Redis                         | counters, idempotency keys, pending AI actions, caches                                  | all TTL-bounded                                                                                     | IMPLEMENTED (TTL)                         |
| Sentry                                | error events, scrubbed before sending                                                   | retention is provider-side                                                                          | PROVIDER VERIFICATION REQUIRED            |
| Vercel                                | request logs                                                                            | retention is provider-side                                                                          | PROVIDER VERIFICATION REQUIRED            |

The public legal pages list subprocessors (`src/app/[locale]/(marketing)/legal`). There is no
request-intake form; requests arrive by email.

## 7. Retention that is only a label

`auditRetentionDays` (FREE 0, STARTER 30, PRO/ENTERPRISE 730) is shown on the plan cards and is
grantable, but no code deletes audit rows by it. Audit logs are kept until the organization is
erased. Say so if asked.

## 8. What to tell a pilot customer (safe wording)

- Members can delete individual contacts, documents, conversations, companies, deals and calendar
  entries themselves; some are purged after 30 days, the rest when the organization is deleted.
- Deleting the whole organization, or exporting its data, is done by Syveka on request, manually,
  within an agreed time.
- Deleting a personal login account is done by Syveka on request, manually.
- AI providers process conversation text to answer; what they retain is governed by their terms
  (verify and name them before promising anything).

Do not say "GDPR compliant", "automatic deletion", "self-service export", or quote a deletion
deadline that the manual procedure above cannot meet.
