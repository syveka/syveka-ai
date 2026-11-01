# Staging release handoff — 2026-11-02

Status of the authorized staging release of PR #386, the inbound-email setup investigation, and
plans for the deferred acceptance items.

Nothing here changed staging, production, the database, CI policy or provider settings.

## 1. Release status: blocked by the deploy-only workflow's pinned source

| Item                                     | Evidence                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Authorized candidate                     | `af75e17414d6becfd03d2563403d806a619b8baa`: the PR #386 merge, and current `main`                     |
| Merge-commit CI                          | [run 41357275509](https://github.com/syveka/syveka-ai/actions/runs/41357275509): success on `af75e17` |
| Staging before and after                 | `/api/health` reports build `19581f274e87e876343d0eb3be8cf51547485569` (unchanged)                    |
| Migrations between staging and candidate | none (`git diff 19581f2 af75e17 -- prisma supabase` is empty)                                         |

**Blocker.** `.github/workflows/staging-deploy-only.yml` deploys only its hardcoded
`PINNED_SOURCE_SHA` (`611fd74…`, PR #371):

- the dispatch input must equal the pin;
- checkout, build, `NEXT_PUBLIC_BUILD_SHA` and both health gates all use the pin.

It cannot deploy `af75e17` without editing the workflow, which is a protected CI/workflow-policy
change.

**Not used.** The only other mechanism that deploys `main`, `staging-release.yml`, was not used.
It writes to the staging database:

- `prisma migrate deploy` (no migrations are pending);
- the rerunnable Storage SQL;
- the E2E organization fixture;
- the auth-journey password step.

The release authorization excluded using it as a substitute.

**One owner decision unblocks the release.** Either:

1. **Authorize `staging-release.yml` for `af75e17`.** This is how #383 and #384 were released.
   - It runs the full validation, RLS and storage checks, smoke tests and auth journeys.
   - It deploys only `main`'s HEAD, which is `af75e17` as long as `main` doesn't move.
2. **Authorize a workflow PR that changes `PINNED_SOURCE_SHA`** in `staging-deploy-only.yml` to
   `af75e17…`, then dispatch deploy-only.
   - This runs no migrations, fixtures or smoke tests.
   - Proof is limited to the health gate on the stable alias.

## 2. Inbound email: what is required and how to check it

**Mapping.**

- An organization receives email only through a row in `inbox_mailboxes`:
  - columns `organization_id`, `channel`, `address`;
  - unique on `(organization_id, channel)` and on `(channel, address)`;
  - foreign key to `organizations`, cascading on delete.
- The intended address is `{organization slug}@{INBOX_EMAIL_DOMAIN}`, lower-cased
  (`addressFor`, `src/server/services/inbox-mailbox.ts`).
- **Nothing in the application creates the row.**
  - `getOrCreateMailbox` is called only from tests.
  - Its comment says the settings UI calls it, but no code does.

**Routing and checks.**

- **Resend route** (`/api/v1/webhooks/inbox-email/resend`):
  - returns 503 without `RESEND_INBOUND_WEBHOOK_SECRET`;
  - verifies the svix signature on the raw body (401 if invalid);
  - accepts only `email.received`;
  - resolves the organization from each recipient address
    (`resolveOrgIdByMailboxAddress`: case-insensitive, organization not deleted), and returns 401
    when no recipient matches;
  - rate-limits per organization;
  - fetches the body with `RESEND_API_KEY`.
- **Generic route** (`/api/v1/webhooks/inbox-email`): a shared secret in `x-inbox-webhook-secret`
  (timing-safe compare), and organization only from `toAddress`.
- **Duplicates.** `inbox_messages.external_id` is unique. The same id in the same organization
  returns 200 `duplicate`; the same id under another organization returns 409.
- **Tests:**
  - `inbox-resend-webhook.test.ts`
  - `inbox-email-webhook.test.ts`
  - `inbox-mailbox.test.ts`
  - `inbox-service.test.ts`
  - `inbox-golden-path.e2e.test.ts`

**Read-only diagnostic (owner runs it on staging; not executed here).** It was validated against
a local scratch database with the full migration history.

```sql
SELECT m.address,
       m.created_at,
       o.deleted_at AS organization_deleted_at
FROM inbox_mailboxes AS m
JOIN organizations AS o
  ON o.id = m.organization_id
WHERE o.slug = 'syveka-pilot-acceptance-test'
  AND m.channel = 'EMAIL';
```

**If it returns no row, these are the owner actions, in order. Each needs its own authorization.**

1. **Decide the receiving domain.** This is the staging `INBOX_EMAIL_DOMAIN`. Its value is not in
   the repository and was not read.
2. **Create the mapping.** Either:
   - one authorized insert:
     `INSERT INTO inbox_mailboxes (organization_id, channel, address, updated_at) SELECT id, 'EMAIL', lower(slug || '@' || '<receiving domain>'), now() FROM organizations WHERE slug = 'syveka-pilot-acceptance-test' ON CONFLICT DO NOTHING;`
   - or a reviewed product change that adds an explicit "Set up receiving address" action for
     `org:update` users (with audit) calling `getOrCreateMailbox`. Not built; this is a product
     decision.
3. **Configure Resend inbound** for that domain:
   - point it to the Resend route above;
   - set `RESEND_INBOUND_WEBHOOK_SECRET` on staging.
4. **Manual receiving test.** From your own mailbox, send one email to the address the Inbox now
   shows. Expect a new Inbox thread and the status "Inbound email received". A missing thread means
   checking the Resend inbound log (401 = unknown recipient, 503 = secret missing).

## 3. Billing presentation: checked against the price constants

Source: `src/lib/billing/plan-catalog.ts`, `PLAN_MONTHLY_PRICE_EUR` and `ANNUAL_BILLED_MONTHS = 10`.

| Plan    | Monthly | Annual charge (10 × monthly) | Shown monthly equivalent | 12 × equivalent           |
| ------- | ------- | ---------------------------- | ------------------------ | ------------------------- |
| Starter | €29     | €290                         | €24.17                   | €290.04 (rounded display) |
| Pro     | €79     | €790                         | €65.83                   | €789.96 (rounded display) |

The charge itself is whatever `STRIPE_PRICE_STARTER_ANNUAL` / `STRIPE_PRICE_PRO_ANNUAL` hold in
Stripe.

**Outstanding owner action:** confirm in the Stripe dashboard that they are €290 / €790 per seat
per year. No read-only Stripe access was available, and no secret was read.

## 4. Deferred items: proposed designs (not implemented; need approval)

### 4.1 Booking notification date and time in the viewer's language

- **Problem.** A booking notification's body is a sentence formatted in the owner's profile
  language when the row is written. A row carries no booking id (`href: "/calendar"`).
- **Proposal (schema change, needs approval):**
  1. Add `notifications.data jsonb NULL`.
  2. `sendBookingLifecycleNotifications` stores `{ kind, bookingId, startsAt, endsAt, timeZone, bookingTypeName, guestName }`.
  3. `displayNotification` renders new rows from `data`, with message keys and the viewer's locale
     and time zone. Rows without `data` keep today's display.
- **Tests:** rendering in EN/FI/AR across a DST boundary, and the old-row fallback.
- No historical row is rewritten.

### 4.2 Audit log: readable action labels

- 88 literal action codes exist (`grep -rhoE 'action: "[a-z_]+\.[a-z_.]+"' src`).
- **Proposal:**
  1. A typed `AUDIT_ACTION_LABELS` map in `src/lib/audit/action-labels.ts`, with EN/FI/AR message
     keys `settingsAuditLog.actions.<code>`.
  2. A unit test that greps `src` for literal action codes and requires a label for each.
  3. The log shows the label next to the unchanged code, and filtering stays on the code.
  4. Computed codes fall back to the code.
- No schema change. This is ready to implement as its own PR when prioritized.

### 4.3 PostgreSQL suites in CI (protected `ci.yml` change)

The opt-in job runs only named files. Proposed diff, **not applied**:

```diff
       - name: Run the suites (they must run, not skip)
         env:
           SEAT_LIMIT_PG_URL: ${{ env.SCRATCH_URL }}
           VOICE_PG_URL: ${{ env.SCRATCH_URL }}
+          ORG_SETTINGS_PG_URL: ${{ env.SCRATCH_URL }}
+          WORKFLOW_PG_URL: ${{ env.SCRATCH_URL }}
         run: |
-          npx vitest run tests/unit/invitation-seat-limit.postgres.test.ts tests/unit/post-call-concurrency.postgres.test.ts --reporter=default --reporter=json --outputFile=opt-in-postgres.json
+          npx vitest run tests/unit/invitation-seat-limit.postgres.test.ts tests/unit/post-call-concurrency.postgres.test.ts tests/unit/organization-settings.postgres.test.ts tests/unit/workflow-run-reclaim.postgres.test.ts --reporter=default --reporter=json --outputFile=opt-in-postgres.json
```

- The job's "must run, not skip" check stays as is.
- `workflow-run-reclaim.postgres.test.ts` is added by the workflow failure-record PR (§5). Apply
  this diff only after that PR is merged.

## 5. Follow-up code (draft PR, not merged or deployed)

The run-workflow job recorded a failure in two separate writes:

1. It marked the run FAILED.
2. It then wrote the creator's notification.

Since #386, a terminal failure is never run again. So a notification write that failed after step
1 (or a failed membership read) was lost permanently: the redelivery skips the terminal run.

**Fix.** [#388](https://github.com/syveka/syveka-ai/pull/388), branch `fix/workflow-failure-record-atomic`, head `2d9376405b544d13ec2ab4b1a16a44a2e807c561`:

- The FAILED state and the notification commit in one transaction.
- If that fails, the run keeps a retryable error, so the redelivery runs the step again and records
  both. The fallback only touches a run that is still RUNNING, so a commit that succeeded but
  reported an error is never overwritten.
- An opt-in PostgreSQL suite (7/7 locally) proves the reclaim predicate's SQL behaviour, including
  NULL, three simultaneous reclaims, and a reclaim blocked on a row lock, with a control. It is not
  in CI until the §4.3 change is authorized.
- An independent reliability review approved it for human review; its findings are addressed.

**Limits.** This is not exactly-once delivery:

- If even the fallback write fails, the run stays RUNNING and is reclaimed once stale, like a crash.
- A final transient attempt whose record fails ends in the queue's dead-letter list with the run
  marked failed and no notification.

## 6. Coordination with PR #385 (owned by another session)

- **#385:** `claude/chat-business-dna-completion` at `9fcc93e5a9c555bfc355f2c7f2f6ddbbb56bcad6`,
  draft.
- **Shared files with what is now on `main` from #386:**
  - `messages/en.json`, `messages/fi.json`, `messages/ar.json`;
  - `src/components/chat/chat-thread.tsx`.
- **Status.** GitHub reports MERGEABLE/CLEAN, and a local `git merge-tree` of `main` and
  `9fcc93e` has no conflicts.
- **Before merging, its owner should rerun:**
  - `npm run i18n:check`;
  - the Listen tests (`speech-playback-voice-wait`, `use-speech-playback`), because #386 changed
    `chat-thread.tsx`'s Listen error rendering.
- #385 was not modified and is not part of any release here.
