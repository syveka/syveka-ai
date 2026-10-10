# Recovery drill runbook (logical dump → sanitize → restore)

**Status: design only. No restore has been performed.** Each run needs the owner's explicit
approval, because it copies production data out of Supabase.

## Why this shape

Supabase Support (ticket **SU-494644**) confirmed there is currently **no project-wide setting
that blocks outbound network traffic before or during a restore**, and advised: for a safe drill
into a separate project, take a **logical dump, inspect/sanitize it, then restore**. A physical
"restore to a new project" starts any outbound extensions immediately and can't be paused, so it
is not used for drills.

The database itself has no outbound path today: the owner-run read-only preflight
(2026-10-04 18:18 UTC) found `pg_cron`, `pg_net`, `http`, `dblink`, `postgres_fdw` and `wrappers`
absent, `supabase_functions.hooks` missing, and zero outbound triggers, foreign servers and
subscriptions; Vault had 0 secrets. Re-run that preflight before every drill. The remaining risk
is **the data**: a restored copy holds working credentials and scheduled work that any app or
script pointed at it could act on.

## Outbound side-effect inventory (from the repository at `eca6822`)

| Path                                                                                                                                                                   | What could fire                                                                  | Where it lives                                                                    | Drill control                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| QStash jobs (`calendar-sync`, `embed-document`, `post-call`, `publish-creator-post`, `reconcile-creator-generations`, `run-workflow`, `send-reminder`, `usage-rollup`) | Delivered to the **production** URL by production QStash; enqueued by app writes | QStash (outside the DB), `src/server/jobs/queue.ts`                               | Never run the app against the restore with the production `QSTASH_TOKEN`; no schedules point at the drill |
| Reminders                                                                                                                                                              | Reminder emails                                                                  | `Reminder.sendAt`                                                                 | Sanitize: delete or mark sent                                                                             |
| Creator posts                                                                                                                                                          | Publishing to Instagram/Facebook                                                 | `CreatorPost.scheduledFor`, `SocialAccount.accessTokenEnc/refreshTokenEnc`        | Sanitize: null tokens, unschedule posts                                                                   |
| Calendar sync                                                                                                                                                          | Google/Microsoft calendar writes                                                 | `CalendarConnection.accessTokenEnc/refreshTokenEnc`, `CalendarSyncState`          | Sanitize: null tokens                                                                                     |
| Outbound workflow webhooks                                                                                                                                             | HTTP calls to customer URLs                                                      | `WebhookEndpoint.url/secret`, `Workflow`                                          | Sanitize: delete endpoints, deactivate workflows                                                          |
| Email (Resend)                                                                                                                                                         | Booking confirmations, invitations, notifications                                | App env `RESEND_API_KEY`; `Invitation.token`                                      | No Resend key in any drill app; expire invitations                                                        |
| Stripe                                                                                                                                                                 | Billing calls by customer id                                                     | `Organization.stripeCustomerId`, `Subscription.stripeSubscriptionId`              | Never use production Stripe keys; null ids                                                                |
| Vapi                                                                                                                                                                   | Calls, assistant updates (resync on Business DNA saves)                          | `VoiceAssistant.vapiAssistantId/phoneNumber`, `VoiceCall.vapiCallId/recordingUrl` | No Vapi key in any drill app; null ids                                                                    |
| AI providers (Anthropic, OpenAI, FAL)                                                                                                                                  | Paid generation                                                                  | App env                                                                           | No keys in any drill app                                                                                  |
| Inbound webhooks (Stripe, Resend, Vapi, calendar)                                                                                                                      | Providers keep sending to production URLs                                        | Provider consoles                                                                 | Unaffected (they never point at the drill)                                                                |
| Supabase Auth emails                                                                                                                                                   | Password recovery, signup confirmation                                           | Auth settings of the drill project                                                | Leave SMTP unconfigured in the drill project                                                              |
| `gdpr-erasure` Edge Function                                                                                                                                           | Hard deletes                                                                     | Supabase Edge Functions                                                           | Not deployed to the drill project                                                                         |

Encrypted tokens can only be decrypted with the production encryption keys; the drill never
receives them, which is a second line of defense, not the first.

## Procedure

1. **Approve and prepare.** Owner approves the run; create an empty disposable Supabase project
   (same Postgres major version) with no Auth SMTP, no Edge Functions, no integrations.
2. **Preflight.** Run the read-only outbound preflight (see `docs/release-runbook.md`) on
   production. Stop if any outbound-capable extension, hook, job or subscription appears.
3. **Logical dump.** From an approved operator session with the Supabase CLI:
   `supabase db dump` for roles, schema and data, written only to an approved encrypted
   destination. Record UTC time, size and SHA-256.
4. **Inspect.** `pg_restore --list` (or read the SQL) and confirm none of the extensions above
   and no `cron`/`net` schema objects are present.
5. **Restore into an isolated local Postgres first** (`docker run --network none` with
   pgvector), then **sanitize** there:
   - `UPDATE calendar_connections SET access_token_enc = NULL, refresh_token_enc = NULL`;
   - `UPDATE social_accounts SET access_token_enc = NULL, refresh_token_enc = NULL`;
   - delete `webhook_endpoints`; deactivate workflows;
   - delete or mark sent future `reminders`; unschedule future `creator_posts`;
   - null Stripe customer/subscription ids and Vapi ids/phone numbers;
   - expire `invitations` and `booking_tokens`.

   Use the column names from `prisma/schema.prisma` at the drill's commit; re-check them each
   run. Dump the sanitized database.

6. **Restore the sanitized dump** into the disposable Supabase project.
7. **Verify isolation and tenancy:** run `tests/staging/release-invariants.sql` and the RLS
   isolation scripts against it; confirm the sanitized columns are empty.
8. **Functional verification (optional):** a preview build of the same commit pointed at the
   drill project, with **no provider keys and no QStash token**: sign in as a known test user,
   open CRM, Calendar and Business DNA, compare row counts with the dump.
9. **Evidence to keep** (private change record): dump time, size, checksum, commit, row counts
   per table before/after, invariant output, who ran it.
10. **Destroy:** delete the disposable project and the local container; delete the dump per the
    retention decision; record the deletion time.

## Storage objects are not in database backups

The production dashboard states that database backups exclude Storage objects (only their
metadata rows are included). Syveka stores customer files in five private buckets:
`documents` (knowledge base, `orgId/<uuid>/<file>`), `creator-reference-assets`
(`orgId/<profile>/<uuid>/<file>`, likeness images under consent), `creator-generated-media`,
`voice-recordings` and `exports`.

**There is no backup of these objects today.** A database restore brings back rows whose
`storagePath` points at files that may no longer exist. Required (owner decision on cost and
retention):

- a scheduled copy of the five buckets to separate storage (for example an S3-compatible bucket
  with versioning and its own retention), using the Storage API or S3 protocol, keyed by object
  path so restores map back to the database rows;
- a periodic check that sampled `storagePath` rows resolve to objects;
- the same sanitization and access rules as the database dump (likeness assets are sensitive).
