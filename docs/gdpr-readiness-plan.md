# GDPR readiness: export and deletion (plan, as of `eca6822`)

**Status: plan only.** No export, deletion or account-deletion code exists yet. This maps what
exists, what is broken, and the smallest correct implementation.

## What exists

| Piece                                                                            | Location                                                                                                    | State                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Org hard-delete after a 30-day grace                                             | `supabase/functions/gdpr-erasure/index.ts` (Edge Function, service-role bearer)                             | **Defective** (below); deployment unverified; **nothing calls it**          |
| Org soft-delete (`organizations.deleted_at`)                                     | Respected by tenant context and jobs (soft-deleted orgs get no access; jobs skip them)                      | **No code sets it**: there is no deletion request flow                      |
| Retention purge of soft-deleted contacts, documents, conversations after 30 days | `src/app/api/v1/jobs/usage-rollup/route.ts`                                                                 | Runs only if the QStash schedule is registered (unverified per environment) |
| Tenant cascade                                                                   | Every organization foreign key in `prisma/schema.prisma` is `onDelete: Cascade` (74 cascades, 0 exceptions) | Deleting the org row removes all 61 models' tenant rows                     |
| Data export                                                                      | —                                                                                                           | **Missing**                                                                 |
| Account deletion                                                                 | —                                                                                                           | **Missing**                                                                 |

## Defects in `gdpr-erasure` (P2, latent while nothing calls it)

1. **Files are not deleted.** It calls `storage.from(bucket).list(orgId)` once and removes
   `orgId/<name>` for each entry. Objects are nested deeper, for example
   `documents/orgId/<uuid>/<file>` and `creator-reference-assets/orgId/<profile>/<uuid>/<file>`,
   so `list` returns folder entries and `remove` deletes nothing. The organization's rows are
   then hard-deleted, leaving files that can no longer be traced to an organization.
2. **Two buckets are missing.** It purges `documents`, `voice-recordings`, `exports`, but the
   app also stores `creator-reference-assets` (likeness images under consent) and
   `creator-generated-media`.
3. **At most 1,000 entries**, no pagination.
4. **Storage errors are ignored**: the database delete runs even if file removal failed.
5. **No external cleanup**: the Stripe customer id is selected but unused; Vapi assistants and
   phone numbers, and calendar/Meta OAuth grants, are left at the providers.
6. **No erasure evidence survives**: audit rows are tenant rows and cascade away with the org.

## Smallest correct implementation

**1. Move erasure into tested server code** (replacing the Edge Function, which has no tests).
A `purgeOrganization(orgId)` service, invoked by a QStash-verified job route:

- refuse unless `deleted_at` is at least 30 days old;
- for each of the five buckets, list `orgId/` recursively with pagination and remove every
  object; **abort before any database delete if any removal fails** (retry next run);
- provider cleanup, best-effort and logged: delete Vapi assistants and release numbers; revoke
  calendar OAuth tokens (Google/Microsoft revoke endpoints); drop Meta tokens. Keep the Stripe
  customer and invoices (bookkeeping retention), but clear personal metadata on the customer;
- delete the organization row (cascade);
- write a platform-level erasure record (org id, deletion request time, purge time, operator
  or job) that is not tenant-scoped, so evidence survives.

Schedule it from the existing nightly usage-rollup run (one place for retention work), or a
dedicated QStash schedule.

**2. Organization deletion request (OWNER only).** A settings action that requires typing the
organization name, sets `deleted_at`, cancels the Stripe subscription at period end, and writes
an audit entry. Access stops immediately (existing soft-delete handling); the purge follows after
30 days. An OWNER can cancel the request within the grace period.

**3. Organization export (OWNER only).** An async job that writes one JSON file per tenant model
(excluding secrets: `*_token_enc`, `ApiKey.keyHash`, `WebhookEndpoint.secret`,
`BookingToken.tokenHash`, `Invitation.token`) plus the organization's `documents` and creator
asset objects into the existing private `exports` bucket under `orgId/`, delivered as a signed
URL that expires in 7 days, audited, and rate-limited (one export in progress per org).

**4. Account deletion (self-service).** Refuse while the user is the sole OWNER of any
organization (they must transfer ownership or delete the organization first). Then delete the
Supabase Auth user (admin API) and the `public.users` row. Today's relations already handle most
references: memberships, notifications and upload intents cascade; audit log actor, messages,
activities, inbox items and entitlement grants are set to null. Several models keep a plain
`userId`/creator id **without** a foreign key; those remain as pseudonymous ids after deletion,
which must be either accepted in the privacy notice or explicitly nulled in the same transaction.

**5. Account export.** Profile, memberships, and messages the user authored, as JSON, same
delivery as the organization export.

## Tests each step needs

- erasure: nested paths across all five buckets are removed; a failing removal leaves the
  database untouched; a non-expired or non-deleted org is refused; the erasure record survives;
- deletion request: OWNER only; access ends immediately; cancel within grace restores access;
- export: excludes every secret column; another org's data never appears; expiry enforced;
- account deletion: refused for a sole OWNER; cascades and nulls as listed.

## Owner decisions

- Grace period (30 days today) and export link lifetime.
- Whether pseudonymous user ids may remain after account deletion.
- Stripe customer retention period (bookkeeping law) and what metadata is cleared.
- Storage backup retention (see `docs/recovery-drill-runbook.md`): deleted files must also
  expire from any backup copy.
