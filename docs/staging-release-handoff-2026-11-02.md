# Staging release handoff — 2026-11-02 (updated)

Status of the staging release of the merged Android Arabic acceptance fixes (#386) and the Business
DNA follow-up (#385), the workflow reliability PR #388, the inbound-email setup investigation, and
plans for the deferred acceptance items.

No merge, deployment, workflow dispatch, environment approval, remote SQL, configuration change or
paid provider call has been made by this work.

## 1. Current state (verified 2026-11-02)

| Item                                  | State                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `main`                                | `62af0635be6751f7d32735d6fda0329e96f8c592`: the #385 merge, including #386 (`af75e17`)   |
| CI on `main`                          | [run 41363216530](https://github.com/syveka/syveka-ai/actions/runs/41363216530): success |
| Staging `/api/health`                 | healthy, build `19581f274e87e876343d0eb3be8cf51547485569`: has neither #386 nor #385     |
| Migrations between staging and `main` | none (`git diff 19581f2 62af063 -- prisma supabase` is empty)                            |
| #388 (workflow reliability)           | draft, not merged; main merged in normally; see §5                                       |
| Deploy-only workflow pin              | `611fd74…` (PR #371): cannot deploy `main`                                               |

**Why staging is behind.** `.github/workflows/staging-deploy-only.yml` deploys only its hardcoded
`PINNED_SOURCE_SHA`:

- the dispatch input must equal the pin;
- checkout, build, `NEXT_PUBLIC_BUILD_SHA` and both health gates all use it.

`staging-release.yml`, the other way to deploy `main`, writes to the staging database
(`prisma migrate deploy`, Storage SQL, the E2E fixture and password steps), and it was excluded as
a substitute.

**Prepared as draft [#390](https://github.com/syveka/syveka-ai/pull/390): moving the pin to `62af063`.**

- **Branch:** `ci/staging-deploy-only-pin-62af063`, worktree `C:\Users\lenovo\Desktop\syveka-deploy-pin`.
- **Committed there:** the test change, at `eb49351026ec0da512d70457bdbac8b5542590d5`.
- **Not committed:** the one-line workflow change. The repository's command guard reserves
  `.github/workflows/*` changes for a human, so it is ready, uncommitted, in that worktree for the
  owner to commit (§7).
- **What the change is:** `PINNED_SOURCE_SHA` set to `62af0635…`, plus a comment naming the
  candidate. All 30 workflow tests pass with it locally.
- **New executed tests (bash, synthetic inputs):**
  - wrong, short or branch-name source ids are refused;
  - a wrong or malformed project ref is refused;
  - a run outside `main` is refused;
  - staging equal to production is refused;
  - a pinned commit outside `main`'s history, or not the checked-out one, is refused;
  - the pin is one full 40-character id.
- **Kept unchanged:**
  - input-to-pin equality and the ancestry check;
  - staging/production separation and credential isolation;
  - the preview and stable-alias health gates that check the build id;
  - `concurrency: staging-release` and `environment: staging`;
  - no migration or SQL step.
- **Candidate contents.** `62af063` contains #386 and #385 and **excludes #388**.
- **Build-relevant changes since the old pin `611fd74`:**
  - the workflow's two repository scripts (`verify-prisma-engine.mjs`, `validate-staging-config.mjs`)
    are unchanged;
  - one reviewed dependency was added (`react-markdown`, merged with CI green);
  - there are no migrations.

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
+          npx vitest run tests/unit/invitation-seat-limit.postgres.test.ts tests/unit/post-call-concurrency.postgres.test.ts tests/unit/organization-settings.postgres.test.ts tests/unit/workflow-run-reclaim.postgres.test.ts tests/unit/run-workflow.postgres.test.ts --reporter=default --reporter=json --outputFile=opt-in-postgres.json
```

- The job's "must run, not skip" check stays as is.
- `workflow-run-reclaim.postgres.test.ts` and `run-workflow.postgres.test.ts` come with #388. Apply
  this diff only after #388 is merged.
- The route suite refuses any non-local database URL. The CI scratch URL is local to the job; check
  that before wiring.
- Until then, **neither workflow PostgreSQL suite runs in CI**; they ran locally only.

## 5. #388: workflow failure record (draft, not merged or deployed)

[#388](https://github.com/syveka/syveka-ai/pull/388), branch `fix/workflow-failure-record-atomic`.
`main` (`62af063`) was merged in normally, with no rebase or force-push. Its diff against `main` is
the job route, `run-failure.ts` and tests only. The final head and exact-head CI are in the PR.

**What it fixes**, all in `src/app/api/v1/jobs/run-workflow/route.ts`:

- **Atomic failure record.** The run's FAILED state and the creator's `workflow.failed`
  notification commit in one transaction. Before, a failed notification write after a terminal
  failure was lost forever: the redelivery skips terminal runs since #386.
- **Fenced.** The failure record only fails the run this delivery claimed (its `startedAt`),
  while it is RUNNING or WAITING, in this organization:
  - a run reclaimed by another delivery is left alone (`run_superseded`);
  - a SUCCEEDED or CANCELED result is never overwritten;
  - a commit that succeeded but whose reply was lost is not written or notified twice;
  - a run already WAITING when its resume could not be enqueued is failed retryably.
- **Fallback.** If the record can't be written, a retryable failure is recorded so the redelivery
  runs the step again. On the final attempt, the creator is told in the same fenced transaction.
- **`failStep`** only fails a step still CLAIMED. A step whose own transaction committed but whose
  reply was lost is skipped on redelivery, not repeated (no duplicate activity). This was
  pre-existing.
- **`WORKFLOW_RUNS` usage** is best-effort, so a usage write can't turn a success into a failure.
  This was pre-existing.
- **A run left WAITING with no resume is recovered.** This is the case where the resume enqueue
  failed and the database was then unreachable, so neither the wait step's failure nor the run's
  failure could be recorded. Before, every redelivery of the event acknowledged it and it stayed
  WAITING for good. A fresh-event redelivery now decides on the run's latest step claim:
  - **SUCCEEDED**, or a claim past the first wait step (the resume message recovers that part
    itself): acknowledged.
  - **CLAIMED within 6 minutes:** 409 with `Retry-After`.
  - **FAILED or stale:** reclaimed by an update fenced on the state read.
- **The resume enqueue carries a deterministic `deduplicationId`.**
- **Every 409 that waits for a claim to go stale carries `Retry-After`.** QStash doesn't document
  whether its first default retry comes after 12 s or 1 s. If it is 1 s, all three retries can fall
  inside the 6-minute window.

**Evidence (local, disposable PostgreSQL `pgvector/pgvector:pg15` with the full migration history):**

- **`run-workflow.postgres.test.ts` (41 tests)** drives the real route on PostgreSQL with real
  QStash signature checks (test-only keys). Its faults:
  - a PostgreSQL trigger refuses a notification insert;
  - commit-then-error and fail-before-start transactions, and a query error, injected at the Prisma
    client boundary;
  - after an enqueue, failing transactions or an unreachable database.

  Its cases:
  - repeated terminal deliveries, both fresh event and `runId`;
  - an invalid-recipient terminal failure;
  - rollback, then recovery;
  - a committed but errored failure record;
  - a committed but errored step;
  - transient recovery;
  - the final attempt, including a failed record;
  - a non-member creator;
  - a WAITING run with a failed enqueue and a failed record;
  - a usage failure after success;
  - a superseded run;
  - five deliveries released together at the run claim, for a failing event and a successful one;
  - two `runId` resumes released together at the step claim;
  - a cross-organization `runId`;
  - WAITING recovery:
    - nothing recorded: 409 with `Retry-After`, then a reclaim once stale;
    - a FAILED wait step;
    - two redeliveries released together at the reclaim;
    - a lost completion write, re-enqueued under the same `deduplicationId`;
    - a leftover claim on an earlier wait;
    - a claim past the first wait, left to the resume message;
    - a resume taking the run between the read and the reclaim;
    - `Retry-After` on the run-level and step-level 409s;
    - a scheduled resume, which is acknowledged only.

- **Fail-first.** The new cases fail on the previous implementation:
  - 5 fail on `3c5edd2`;
  - 6 fail on `main`'s route.

  The other cases pass on both, because they pin behaviour `main` already had.

  For the WAITING work:
  - 7 of the new tests fail on `5cf6e77`, the head before this work;
  - for each review finding, its test fails on the revision the finding was raised against (3 on
    `a5e4fb5`, 1 on `16375f5`).

- **`workflow-run-reclaim.postgres.test.ts` (7 tests).**
  - The reclaim predicate agrees with `isTerminalRunError()` for every stored error kind,
    including SQL NULL. A check shows the NULL branch is required.
  - The resume condition.
  - A conditional reclaim is taken once.
  - Reclaims blocked on a terminal failure's row lock are proven with `pg_blocking_pids` of the
    holding transaction, which is kept open by a barrier rather than a sleep. A control shows the
    pre-#386 condition would take the run.
  - A non-stale RUNNING run, and a stale RUNNING run that waits and then takes nothing.
- **Neither suite runs in CI** (§4.3). The fake-database unit suites (16 files) run in CI.

**Independent reviews:**

- **Transactions and recovery:** approve. Its WAITING, final-attempt, fencing and `failStep`
  findings are fixed.
- **Tenant isolation and privacy:** no blocking issues. Org binding is added to the failure writes;
  the test database is guarded as local-only and cleanup is narrowed.
- **Test fidelity:** approve on condition of accurate claims. The lock probe, stale case, names,
  barrier scope and fake rollback are fixed, and the CI claims are corrected here and in the PR.
- **Concurrency review of the WAITING recovery:** approve after two rounds. Its findings are fixed:
  - the decision used the oldest unfinished step;
  - the WAITING reclaim shared an `OR` with the RUNNING-stale branch;
  - one 409 had no `Retry-After`;
  - the event message reclaimed beyond its first wait.
- **Independent review of the ownership and duplicate-resume fix:** approve after three rounds.
  Its findings are fixed:
  - a lost completion write left the first wait CLAIMED while its resume ran;
  - a re-park by a stale delivery could block the success write;
  - a refused park was acknowledged while the run was unfinished.

**Ownership and duplicate resumes, without QStash deduplication** (`c311f8e`, `83e777d`,
`ecb446b`):

- **Ownership.** A resume keeps the run's first `startedAt`, so an active resume looked stale and a
  fresh duplicate could reclaim it. The event's message now gives up the run once the step ledger
  shows its first wait SUCCEEDED or any claim on a later step.
- **No reopening, no running behind.** A `runId` resume never reopens a finished run, and a resume
  behind an already-succeeded later wait is a duplicate.
- **Fenced status writes.**
  - Parking is fenced on RUNNING and the delivery's `startedAt`. A refused park is retried unless
    the run finished.
  - The success write only moves an unfinished run to SUCCEEDED, and `WORKFLOW_RUNS` usage is
    recorded only for that transition.
- **Tests.** Ten real-PostgreSQL tests with barriers prove the following:
  - an active resume can't be reclaimed;
  - duplicate resumes, with no deduplication, run no step twice and count usage once, and leave
    the right final status;
  - abandoned runs, before and after the first wait, are still recovered.
- **A duplicate's failure never fails a run another delivery took over** (`67ed688`, `f92f9d3`).
  - The failure record first takes a lock-holding no-op write on the step this delivery failed. It
    records nothing if another delivery reclaimed that step.
  - The success write and parking take over a retryable failure recorded before the takeover, but
    never the administrative `step_not_allowed` stop.
  - On `ecb446b` the reproduced interleaving ended FAILED with one false notice, although every step
    succeeded.

**Limits (not exactly-once):**

- **Database outage.** If the database is unreachable for the fallback too, the run keeps its status
  and the job answers 500. Recovery then comes from the same message's redelivery:
  - **RUNNING:** reclaimed once stale.
  - **WAITING with no resume:** the event's redelivery reclaims it, or the resume's redelivery if
    the claim is past the first wait.

  The 409 before that carries `Retry-After` for the time until the claim is stale. The database must
  be back within the message's retries, or the message ends in the DLQ; replaying it recovers the run
  the same way. `Retry-After` and deduplication are QStash's documented mechanisms, but neither was
  tested against live QStash.

- **Remaining narrow windows.** All were reviewed and are bounded; each step still runs once.
  - A resume between its run update and its first step claim looks unowned to a fresh duplicate.
  - **Residual notice.** A duplicate resume's final-attempt failure recorded **before** the other
    resume takes over the failed step leaves the run SUCCEEDED, but the notice is not withdrawn.
    Withdrawing it needs a run id on `Notification`, which is a schema change. If the takeover
    comes first, nothing is recorded or notified (fixed in `67ed688` and `f92f9d3`).
  - A superseded duplicate that is not on its final attempt acknowledges and relies on the other
    delivery; a DLQ replay recovers the run if that one exhausts its retries.
  - Deactivation during a resume ends the run CANCELED.
  - `stepResults` checkpoints are unconditional.
- **One check for CI.** Confirm in CI PostgreSQL that Prisma puts the relation filters in the
  UPDATE statement itself.
- **Concurrent resumes.** Two concurrent `runId` deliveries are separated by the step ledger, not at
  the run level, and a resumed run rebuilds variables from `stepResults`.
- **Edited workflows** use the current step list for the decision.

## 6. PR #385

#385 merged as `62af063` (current `main`), with CI green. Its shared files with #386
(`messages/*.json`, `chat-thread.tsx`) merged without conflict. #388's diff against `main` touches
none of them. Draft #389 (another session: tests and docs) doesn't overlap these files.

## 7. Release sequence and the decisions it needs

Recommended order, one decision at a time:

1. **Choose the candidate.**
   - **(a) Release `62af063` now:** #386 and #385, without #388.
   - **(b) Merge #388 first**, after reviewing it, then release its merge commit.
   - #388 changes only job reliability, and staging already runs without it. **(a)** gets the
     acceptance fixes onto staging soonest; **(b)** needs one more merge decision first.
2. **Commit the pin (owner, because of the guard).** For (a), in a terminal opened in
   `C:\Users\lenovo\Desktop\syveka-deploy-pin`:

   ```
   git add .github/workflows/staging-deploy-only.yml
   git commit -m "ci(staging): deploy-only builds the reviewed 62af063 candidate"
   git push -u origin ci/staging-deploy-only-pin-62af063
   ```

   For (b), first set `PINNED_SOURCE_SHA` and `PINNED` in the test to #388's merge commit, once it
   exists.

3. **Review #390.** CI must be green on its exact head.
4. **Authorize merging the workflow PR.** `workflow_dispatch` runs the workflow file from `main`, so
   the pin must be on `main`. The workflow revision is then that merge commit; the application
   source it builds is the pin.
5. **Authorize the dispatch and the `staging` environment approval.** Existing input names (not run):

   ```
   gh workflow run staging-deploy-only.yml -R syveka/syveka-ai --ref main \
     -f staging_project_ref=<the 20-character staging Supabase ref> \
     -f source_sha=62af0635be6751f7d32735d6fda0329e96f8c592
   ```

6. **Verify.**
   - The workflow's own gates: the preview health with build id, then promotion, then the
     stable-alias health with build id.
   - Then independently: `https://syveka-ai-staging.vercel.app/api/health` reports the pin.
   - Deploy-only runs no smoke tests or auth journeys. Behaviour checks are the manual device
     checklist in `docs/android-ar-acceptance-2026-11-01.md`.

**Rollback.** Deploy-only can redeploy any reviewed `main` commit through the same pin process.
For example, `19581f2`, which staging serves today and which needs no migrations.

**Separate from code (owner actions, unchanged):**

- the inbound mailbox mapping and Resend routing (§2);
- Stripe annual price confirmation (§3);
- phone assistant: plan restriction and issue #380;
- physical Android Listen and screen-reader checks.
