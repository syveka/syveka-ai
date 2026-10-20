# Pilot data-requests runbook (as of main `7a8c354`)

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

| Request type                                                                | Status today                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Delete one CRM record, document, conversation, company, deal, event         | IMPLEMENTED + WIRED (soft delete of that record; some purged after 30 days, §3) |
| Erase **all** personal data about one individual (a data-subject's erasure) | NOT IMPLEMENTED; MANUAL across many tables (§3.1)                               |
| Remove a team member from an organization                                   | IMPLEMENTED + WIRED (OWNER/ADMIN)                                               |
| Delete a whole organization                                                 | IMPLEMENTED but **NOT WIRED**; effectively MANUAL (§4)                          |
| Export an organization's data                                               | NOT IMPLEMENTED                                                                 |
| Delete a person's user account                                              | NOT IMPLEMENTED                                                                 |
| Export a person's own data                                                  | NOT IMPLEMENTED                                                                 |
| Removal from backups and dumps                                              | NOT IMMEDIATE; follows backup/dump retention (§6)                               |
| Delete data held by processors                                              | PROVIDER VERIFICATION REQUIRED (§7)                                             |
| Audit-log retention by plan                                                 | NOT IMPLEMENTED (display only)                                                  |

**Practical consequence for the pilot:** the pilot agreement should say that erasure of an
individual's data, organization deletion and data export are handled manually by Syveka on request,
with the timeline Ehab can actually keep, and should not promise self-service deletion or export.

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

The 30-day purge runs only if the `usage-rollup` job (`src/app/api/v1/jobs/usage-rollup/route.ts`)
is scheduled (QStash). **Needs verification** that the schedule is registered in the environment
used for the pilot.

Contacts carry a `gdprConsentAt` timestamp set at creation; there is no consent-withdrawal flow.

### 3.1 Deleting a contact is not erasing a person

Deleting a contact removes **that CRM record**. It does not find or remove the other places where
the same person's data can be stored. Read from `prisma/schema.prisma` and the services on main:

- **Soft delete (the first 30 days):** only `contacts.deleted_at` is set. Nothing related changes.
- **Hard purge (after 30 days, by the job):** activities and tags attached to the contact are
  deleted with it (`onDelete: Cascade`). Everything else only loses its link, or is untouched:
  - **deals** keep their title, value, notes and stage; `deals.contact_id` becomes null
    (`SetNull`);
  - **inbox threads** lose `contact_id` (`SetNull`); their **messages keep** `from_address`,
    `to_address` and the full `body`;
  - **calendar event attendees** lose `contact_id` (`SetNull`) but keep their own `email` and
    `name` columns;
  - **bookings** are never linked to a contact at all and keep `guest_name`, `guest_email`,
    `guest_phone`, `guest_company` and `guest_notes` until the organization is erased (there is no
    booking purge);
  - **voice calls** (OFF in the pilot) keep `caller_number`, `transcript`, `summary`,
    `recording_url` and `contact_id` — that column has no database relation, so it is not even
    nulled;
  - **workflow runs** (OFF in the pilot) keep whatever the trigger carried in `trigger_data`;
  - **audit log** rows keep their `before`/`after` snapshots: the contact deletion itself writes the
    contact's first name and email into `before` (`contact.delete`), and earlier rows hold what was
    created or changed. Audit rows are kept until the organization is erased (§8).
- Activities that mention the person but are attached only to a company or a deal, and notes on
  those records, are not touched.

Erasing one individual therefore means an operator locating and clearing those rows by hand
(database access; bookings and inbox by email address, attendees by email, audit snapshots by
content) and then handling processors (§7) and backups (§6). **Nothing in the repository automates
this, and the per-record delete must not be described to a customer as erasing a person.**

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
5. Handle processors per §7, and note the backup/dump position in §6 when giving a completion date.

Until the plan in `docs/gdpr-readiness-plan.md` is built, promise customers a **manual** deletion
with a realistic lead time, not a self-service one.

## 5. Export

- Organization export: NOT IMPLEMENTED. The `exports` bucket exists but no code writes to it.
- Personal data export for one user: NOT IMPLEMENTED.
- Workaround today: an operator with database access can produce a manual extract. Treat this as a
  manual service with a lead time, and do not promise a specific format.

## 6. Backups and dumps (deleted data is not gone at once)

Every deletion above acts on the live database and Storage. Copies of the data can remain,
temporarily, in:

- **Supabase database backups** of the project — the daily physical backups and, where enabled,
  point-in-time recovery (`docs/release-runbook.md`, "Production preflight and backup"). The
  production dashboard states these exclude Storage objects (`docs/recovery-drill-runbook.md`).
- **Logical database dumps** taken by an operator for release preflight, recovery drills or the
  B / B-M release options (`supabase db dump` to an approved encrypted destination;
  `docs/release-runbook.md`, `docs/recovery-drill-runbook.md`). These contain full rows, including
  soft-deleted ones.
- **Any Storage backup copy**, if the design in `docs/storage-backup-design.md` is implemented;
  that document itself notes that erasure deletes live objects only and backup copies age out by
  retention.

Deleted application data stays in those copies **until the relevant backup expires under the
provider's retention, or the dump is deleted under the operator's retention decision.** The
repository does not fix either period: Supabase's backup retention depends on the project's plan
and settings (**PROVIDER VERIFICATION REQUIRED**), and the dump retention is called "the agreed
retention" / "a legal decision" in the runbooks (**OWNER DECISION REQUIRED**). Do not state a
figure, and do not promise immediate physical erasure from backups. Say that deletion applies to
the live system and that backup copies expire afterwards under a retention period that will be
confirmed in writing.

## 7. Processors used by current main

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
| Meta (Creator Studio; OFF in pilot)   | social-account OAuth and posts when a Meta account is connected                         | none at provider                                                                                    | PROVIDER VERIFICATION REQUIRED            |
| Upstash Redis                         | counters, idempotency keys, pending AI actions, caches                                  | all TTL-bounded                                                                                     | IMPLEMENTED (TTL)                         |
| Sentry                                | error events, scrubbed before sending                                                   | retention is provider-side                                                                          | PROVIDER VERIFICATION REQUIRED            |
| Vercel                                | request logs                                                                            | retention is provider-side                                                                          | PROVIDER VERIFICATION REQUIRED            |

**Public legal pages are placeholders.** `/legal/privacy`, `/legal/terms` and `/legal/dpa`
(`src/app/[locale]/(marketing)/legal/[doc]/page.tsx`) are one-paragraph placeholder texts whose
source comment says the final texts come from counsel. The privacy page names eight subprocessors
(Supabase, Vercel, Stripe, Anthropic, OpenAI, Vapi, Resend, Upstash) and omits others this table
shows in the code: fal.ai, Meta, Sentry, and the Google and Microsoft calendar integrations. The
DPA page says a subprocessor list is "described herein" but contains none. **The legal and
subprocessor documentation is still pending final review and must not be presented to pilot
customers as a complete, finalized subprocessor disclosure.** Do not link the pages as "our privacy
policy" or "our DPA" in the pilot agreement until counsel has replaced them.

There is no request-intake form; requests arrive by email.

## 8. Retention that is only a label

`auditRetentionDays` (FREE 0, STARTER 30, PRO/ENTERPRISE 730) is shown on the plan cards and is
grantable, but no code deletes audit rows by it. Audit logs are kept until the organization is
erased. Say so if asked.

## 9. What to tell a pilot customer (safe wording)

- Members can delete individual records themselves — contacts, documents, conversations,
  companies, deals and calendar entries. That removes the record; some records are purged from the
  live database after 30 days, the rest when the organization is deleted.
- Deleting a contact record does **not** erase everything about that person: bookings, deals,
  messages, calendar attendees and audit entries that mention them are separate records. A request
  to erase one person's data is handled by Syveka manually, on request, within an agreed time.
- Deleting the whole organization, or exporting its data, is done by Syveka on request, manually,
  within an agreed time.
- Deleting a personal login account is done by Syveka on request, manually.
- Deletion applies to the live system. Backup copies and recovery dumps expire afterwards under a
  retention period that Syveka will confirm in writing (§6); deleted data is not physically removed
  from backups at once.
- AI providers process conversation text to answer; what they retain is governed by their terms
  (verify and name them before promising anything).
- The privacy policy, terms and data processing agreement, including the subprocessor list, are
  being finalized and will be provided before or as part of the pilot agreement; the pages on the
  website today are not the final versions (§7).

Do not say "GDPR compliant", "automatic deletion", "complete erasure", "self-service export",
"removed from backups", "our subprocessor list is on the website", or quote a deletion deadline
that the manual procedure above cannot meet.
