# Launch handoff (2026-11-11, final)

**Verdict:**

- **Merging #431–#442: GO.**
- **Staging: GO** once those are merged and #443 is unblocked, released together.
- **Pilot: NOT READY,** with specific blockers (section I).

This document supersedes `docs/overnight-handoff-2026-11-11.md` (#439) for status.

Nothing was merged, deployed, or changed in any dashboard or live database. No paid API was
called and no secret was read. Every result below is from a local run or GitHub CI on the SHA
named.

## A. Main

`main` = `aaf36c47` (merge of #433); its CI `push` run is green.

## B. Merge order, with exact heads

The order is the sequence the combined tree was built and tested in. Some PRs touch the same files
(`booking.ts` and the manage route: #440 and #437; `send-reminder`: #429 and #437; `messages/*.json`:
#429 and #436; the chat route: #440 and #436; the quota test: #435 and #440). All merge cleanly
in this order. None of 1–9 touches `prisma/`, dependencies or workflows.

| #   | PR   | Head       | Change                                                                            | CI                                        | Independent review                                                    | Status                          |
| --- | ---- | ---------- | --------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| 1   | #431 | `0fc0a762` | Reopened conversations hydrate without React #418                                 | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 2   | #432 | `614ef540` | Admin pages settle their states; denied `/admin` visits are logged                | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 3   | #435 | `68abfadc` | Quota concurrency tests stop failing under load                                   | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 4   | #429 | `b230b523` | Only transient ingestion failures are retried; reminder failures are shown        | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 5   | #440 | `e406e95a` | Invitations accepted by the session's email; join audited in the same transaction | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 6   | #436 | `c8a539d8` | Chat refuses clearly when moderation is unavailable; every error code has text    | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 7   | #437 | `4f8784ce` | Caps email to strangers from bookings, reschedules and reminders                  | confirm on the PR page                    | two today: 1 blocking fixed, then none                                | READY TO MERGE once CI is green |
| 8   | #434 | `c62ab9a9` | Script that checks a staging candidate is main's tip with green CI                | 21/21                                     | overnight                                                             | READY TO MERGE                  |
| 9   | #442 | `4d553e89` | Email links work on another device (`token_hash`)                                 | confirm on the PR page                    | two today: 1 blocking fixed, then none                                | READY TO MERGE once CI is green |
| 10  | #443 | `90632826` | **P0:** revoke Data API table privileges                                          | red only at `migrations:check` (expected) | two today: no code blockers; exploit and fix reproduced independently | BLOCKED on owner actions 1–3    |

- **Not to merge:** #430, #438 and #441 (superseded), and #439 (history; close it once #444 is
  merged).
- **Rollback:** each of 1–9 is a plain `git revert -m 1 <merge>`. #443: section G.

## C. Combined tree

Tree `0e85eda5` contains:

- main;
- 1–9 at the heads above, except #442 at `949b59fb`;
- #443 at `5cb57edc`.

The later commits are documentation, plus a comment-only edit in #443's migration.

| Check                                                                                                                      | Result                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`, `lint`, `typecheck`, `i18n:check`                                                                          | PASS                                                                                                                                                                                                                             |
| `migrations:check`                                                                                                         | FAIL as expected (`Migration order mismatch`). With the owner's one-line patch: PASS on this tree                                                                                                                                |
| Full unit suite, Linux                                                                                                     | 5,560 passed, 58 skipped, 1 failed: `hook-command-guard` › "no timeout binary on PATH". The test hides `timeout` by setting `PATH` to Node's directory, which in this image is `/usr/bin`. Environment-only; no PR touches hooks |
| Browser tests, Linux                                                                                                       | 30/30                                                                                                                                                                                                                            |
| Production build, cold, Linux                                                                                              | PASS. One `supabase-js` Edge-runtime warning, also in main's CI build                                                                                                                                                            |
| CI `rls` job steps (migrations, invariants, three RLS suites, integrity, reconciliation, `match_chunks`, invariants again) | PASS (`pgvector:pg15`, fixture with hosted DML defaults)                                                                                                                                                                         |
| #443's own CI                                                                                                              | All database jobs pass (RLS, non-superuser RLS, legacy/drift, baseline idempotency, opt-in Postgres); only the migration-order check and the `CI required` aggregate fail                                                        |
| Not run                                                                                                                    | e2e against a running app (the staging release runs it); the Redis suites locally (CI covers them); `invitation-accept-revoke.postgres.test.ts` runs nowhere                                                                     |

## D. Security status

**P0, open until #443 is applied to each database.**

- **The issue.** Hosted Supabase grants `anon` and `authenticated` every privilege on public
  tables, and the Data API serves them. `users_self_update` checks only `id = auth.uid()`.
- **The attack.** A signed-in user can set their own `public.users.email` to an address nobody
  has used. When that person signs up, `handle_new_user()` moves the attacker's profile and
  memberships onto the new account.
- **Reproduced twice, independently,** on `supabase/postgres:17.6.1.167`: the new account came
  out as OWNER of the attacker's organization.
- **#443's effect.** With the migration the update is refused, `notifications` stays readable,
  re-applying it is a no-op, and its documented rollback reopens the path as described.
- **Live exposure is unverified:** run D1 on each database.

**Staging for internal testing before #443: NO,** unless D1 on staging shows no `UPDATE` for
`authenticated` on `users`. The fastest safe path is to release #443 with 1–9 in the first staging
release.

**Kept dormant.** The custom access token hook is unregistered. Registering it as written would
break PostgREST and Realtime, and switch on inert policy gaps (writes by any member,
organization-wide reads of conversations, invitation tokens and secrets).

**Accepted P2 risks for a small invite-only pilot:**

- login CSRF through `token_hash` links;
- a concurrent burst, or a sequential book-and-cancel loop, can use up a booking page's hourly
  cap;
- a per-IP limit can't protect Supabase's shared verification quota;
- workflow `email.send` has no per-organization cap (unreachable on FREE);
- per-organization budgets add up across organizations, and FREE organizations are cheap to
  create;
- future SECURITY DEFINER functions are executable by default (rule in #443's doc);
- `avatars` uploads by any signed-in user.

**No cross-tenant path** was found.

## E. Staging release procedure

1. Owner actions 1–4 (section H).
2. Merge PRs 1–10 in order. Wait for a green main `push` run after each.
3. Apply patch A from `docs/staging-release-hardening-2026-11-11.md`, or do its checks by hand:
   - main CI is green on the exact SHA;
   - no merge is in flight.
4. Confirm staging's backup or PITR, read `git diff <released>..<candidate> -- prisma/` (it shows
   only #443's migration), and know the rollback target.
5. Actions → **Staging release validation** → Run from `main` → approve `staging`.
6. **Check:**
   - all steps are green, including the release invariants, which now prove #443's privilege
     state;
   - `/api/health` reports the SHA;
   - D1 on staging shows only `authenticated SELECT notifications`.
7. Pilot acceptance (section F).

**Production** is a separate, separately authorized `deploy.yml` run. It comes after staging
acceptance and one restore drill.

## F. Pilot acceptance (staging; EN, FI, AR; one phone)

- [ ] Sign up and confirm on a **different device**, after the template change; create an
      organization.
- [ ] Invite a MEMBER and accept as that address. Another account can't accept it.
- [ ] Business DNA: create and edit; a VIEWER can't edit.
- [ ] CRM: company and contact; a contact created through chat, then confirmed.
- [ ] Chat: reload during a streaming reply, reopen it. No hydration error in Sentry.
- [ ] Knowledge base: upload a PDF, ask a question it answers, see the citation.
- [ ] Booking: book, then reschedule and cancel from the email; calendar and CRM follow.
- [ ] A reminder email arrives: an event about 25 h ahead, with yourself as attendee.
- [ ] Password reset: requested on a laptop, opened on a phone.
- [ ] Settings → Billing doesn't reach a live Stripe checkout.
- [ ] `/admin` as a non-superadmin is denied, and the denial is logged.
- [ ] Sentry shows no new issue during the run.

## G. Rollback and recovery

| What          | How                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRs 1–9       | `git revert -m 1 <merge>`, PR, merge, release                                                                                                                                         |
| #443          | A forward migration restoring the saved D1/D2 output, with its invariant checks removed in the same change. Verified to reopen the path, so use it only to unblock something specific |
| Staging build | Dispatch `staging-deploy-only.yml` (pinned `b129d416`), or a reviewed re-pin                                                                                                          |
| Database      | Restore or PITR into a **separate** project first (`docs/recovery-drill-runbook.md`). No restore has ever been performed                                                              |

## H. Owner checklist

**Legend:**

- **RO:** read-only. **MOD:** changes something.
- **Approval:** whether it needs explicit authorization for that instance.
- **No step asks for a secret.** Look at prefixes only where a key is involved.

### Supabase (staging first, then production)

| #   | Path                                                          | Action                                                                                                                                                    | RO/MOD                                          | Expected evidence                                                                                                      | Risk                                                                      | Prerequisites                                                           | Approval         |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------- |
| 1   | Project → SQL Editor                                          | Run D1–D7 from `docs/security/data-api-table-privileges-2026-11-11.md` (in #443) on staging and production. Save the output                               | RO                                              | Matches the "expected before" column. D3 shows no rows; D6 shows `0, 0`                                                | None                                                                      | None                                                                    | No               |
| 2   | Authentication → Hooks                                        | "Customize Access Token (JWT) Claims" is **off**; leave it off                                                                                            | RO                                              | Off                                                                                                                    | None                                                                      | None                                                                    | No               |
| 3   | Authentication → Sign In / Providers → Email                  | **Confirm email** and **Secure email change** are on                                                                                                      | RO                                              | Both on                                                                                                                | None                                                                      | None                                                                    | No               |
| 4   | Database → Backups (and Point in Time Recovery), staging      | Note retention and whether PITR is on                                                                                                                     | RO                                              | A backup newer than 24 h, or PITR                                                                                      | None                                                                      | None                                                                    | No               |
| 5   | Database → Backups, production, then a new disposable project | Restore drill (`docs/recovery-drill-runbook.md`), from commit `aaf36c47` (or any commit before #443) while production lacks #443                          | MOD (new project; read-only dump of production) | A restored copy with matching row counts; `s6` reports `20261014…` pending (D7 on production tells which case applies) | Medium: personal data in a disposable project; delete it afterwards (§10) | Owner decisions in the drill README (outbound email isolation, storage) | Yes (§4–§7, §10) |
| 6   | Authentication → URL Configuration                            | Redirect URLs include `https://<app-host>/api/auth/callback**` for each environment                                                                       | RO                                              | Present                                                                                                                | None                                                                      | None                                                                    | No               |
| 7   | Authentication → Email Templates                              | Change Confirm signup, Reset password and Magic link as in `docs/auth-email-links.md` (#442). Staging first, then the doc's verify steps, then production | MOD                                             | A reset requested on a laptop works on a phone                                                                         | Low; revert the template                                                  | #442 deployed there; item 6                                             | Yes              |
| 8   | SQL Editor, staging, after the release                        | Re-run D1                                                                                                                                                 | RO                                              | One row: `notifications`, `authenticated`, `SELECT`                                                                    | None                                                                      | The staging release                                                     | No               |

### GitHub (syveka/syveka-ai)

| #   | Path                                                                             | Action                                                                                                                                                                                                                                                                                                            | RO/MOD          | Expected evidence                                       | Risk                                                            | Prerequisites                      | Approval    |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- | ----------- |
| 9   | PRs #431, #432, #435, #429, #440, #436, #437, #434, #442                         | Confirm each head matches section B and CI is green, then authorize merging in that order, one at a time                                                                                                                                                                                                          | MOD             | Nine merge commits; green main `push` CI after each     | Low; each is revertable                                         | None                               | Yes, per PR |
| 10  | `scripts/check-migration-history.mjs`, on `fix/revoke-data-api-table-privileges` | Authorize this one line, after `"20261014000000_secure_prisma_migrations_table",` in `expectedOrder`: `  "20261111000000_revoke_data_api_table_privileges",`. Ready-made patch: `check-migration-history.patch` in the session's scratchpad (`owner-patch` folder), or let the next session add exactly that line | MOD (protected) | #443 CI fully green                                     | Low                                                             | Item 1 on staging                  | Yes         |
| 11  | PR #443                                                                          | Authorize merging it after item 9                                                                                                                                                                                                                                                                                 | MOD             | Merge commit; main CI green                             | Low until released; the release applies a grants-only migration | Items 1, 4, 10                     | Yes         |
| 12  | `.github/workflows/staging-release.yml`                                          | Apply patch A (B and C optional) from `docs/staging-release-hardening-2026-11-11.md`                                                                                                                                                                                                                              | MOD (protected) | A dispatch with a wrong typed SHA fails before approval | Low                                                             | #434 merged                        | Yes         |
| 13  | Actions → Staging release validation                                             | Dispatch from `main` and approve `staging` (section E)                                                                                                                                                                                                                                                            | MOD (deploy)    | All steps green; health reports the SHA                 | Medium: migrations apply to staging                             | Items 4, 9, 11 (and 12 if applied) | Yes         |
| 14  | `.github/workflows/ci.yml`                                                       | Add `invitation-accept-revoke.postgres.test.ts` to the opt-in Postgres job                                                                                                                                                                                                                                        | MOD (protected) | The job lists it                                        | Low                                                             | None                               | Yes         |
| 15  | PRs #430, #438, #441, #439                                                       | Close them once this document is merged                                                                                                                                                                                                                                                                           | MOD             | Closed                                                  | None                                                            | #444 merged                        | Yes         |

### Vercel (`syveka-ai-staging` and the pilot project)

| #   | Path                                                 | Action                                                                                                 | RO/MOD | Expected evidence             | Risk                                                                                           | Prerequisites | Approval |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------- | -------- |
| 16  | Settings → Build and Deployment → Framework Settings | Build Command is the default; Node.js 22                                                               | RO     | Default; 22.x                 | None                                                                                           | None          | No       |
| 17  | Settings → Environment Variables                     | `EMAIL_FROM` is on `mail.syveka.com`; `STRIPE_SECRET_KEY` is absent or starts `sk_test_` (prefix only) | RO     | Both as stated                | None. A live key would let the billing page take real money; without one, billing fails closed | None          | No       |
| 18  | Settings → Build and Deployment → Deployment Checks  | Remove the native TypeCheck/Lint checks, or accept them as noise on CLI deployments                    | MOD    | No red TypeCheck on a release | Low                                                                                            | None          | Yes      |

### Resend

| #   | Path                        | Action                         | RO/MOD | Expected evidence | Risk | Prerequisites | Approval |
| --- | --------------------------- | ------------------------------ | ------ | ----------------- | ---- | ------------- | -------- |
| 19  | Domains → `mail.syveka.com` | Status is Verified (SPF, DKIM) | RO     | Verified          | None | None          | No       |

### Upstash QStash (EU)

| #   | Path         | Action                                                                                          | RO/MOD | Expected evidence          | Risk                                          | Prerequisites              | Approval |
| --- | ------------ | ----------------------------------------------------------------------------------------------- | ------ | -------------------------- | --------------------------------------------- | -------------------------- | -------- |
| 20  | Signing Keys | The current/next signing keys match the environment's names (compare the first characters only) | RO     | Match                      | None                                          | None                       | No       |
| 21  | Schedules    | Create `POST <app URL>/api/v1/jobs/usage-rollup`, cron `0 2 * * *`, body `{}`                   | MOD    | First delivery answers 200 | Low; runs the 30-day purge and usage warnings | Staging released (item 13) | Yes      |

Reminders and ingestion need no schedule.

### Sentry, and uptime

| #   | Path                            | Action                                                                             | RO/MOD    | Expected evidence               | Risk | Prerequisites | Approval |
| --- | ------------------------------- | ---------------------------------------------------------------------------------- | --------- | ------------------------------- | ---- | ------------- | -------- |
| 22  | Alerts → Create alert           | Alert on new issues, for staging and production; send one test event               | MOD       | An alert email or Slack message | Low  | None          | Yes      |
| 23  | Sentry Uptime (or Better Stack) | `GET https://<host>/api/health` every 1–5 min; alert on non-200                    | MOD (new) | An alert when the check fails   | Low  | None          | Yes      |
| 24  | Alerts                          | Alert on sustained `middleware_session_check_failed` (the only Auth-outage signal) | MOD       | An alert on a test              | Low  | None          | Yes      |

### Product decisions (yours)

- **Pilot sign-up:** invite-only (recommended), or open.
- **Accept the P2 risks** in section D.

### This machine

- **C: has about 3.4 GB free.** Docker Desktop's disk (`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`,
  45.8 GB) grew during the local verification.
- My notes from 2026-11-05 record Docker stopping when C: filled.
- Reclaim the space by compacting or pruning Docker's disk. Its images and volumes are not this
  session's, so nothing was deleted.

## I. GO / NO-GO

| Decision          | Recommendation                              | Why                                                                                                                                             |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge 1–9         | **GO**                                      | Each is reviewed and mergeable. The combined tree passes everything except one environment-only test. Confirm CI on #437 and #442's last pushes |
| Merge #443        | **GO after items 1, 4 and 10**              | Fix reproduced independently twice; CI's database jobs pass; one protected line missing                                                         |
| Staging release   | **GO after the merges, with #443 included** | Then staging is safe for internal testing; without #443, internal testing on staging is **NO**                                                  |
| Production deploy | **NO-GO for now**                           | After staging acceptance and one restore drill (item 5); separate authorization                                                                 |
| First pilot       | **NOT READY**                               | Needs: #443 applied to the pilot's database; restore drill; items 7, 17, 22–23; acceptance (section F)                                          |

## J. Next-session prompt

> Continue the Syveka launch from `docs/launch-handoff-2026-11-11.md` (#444).
>
> 1. Verify live state (`git fetch`, `gh pr list`, main CI). Re-check the PR heads against section
>    B before trusting them.
> 2. For each merge the owner authorized: confirm main's `push` CI is green.
> 3. If the owner authorized item 10, add exactly that line on
>    `fix/revoke-data-api-table-privileges`, then run `npm run migrations:check` and confirm #443's
>    CI is fully green.
> 4. Compare any D1–D7 output the owner shares (text only, never secrets) with the expected table
>    in #443's doc.
> 5. Remaining code work, in order:
>    - P2: a confirm-then-POST page for `token_hash` links;
>    - a per-user cap on FREE organization creation;
>    - a per-organization cap for workflow `email.send`;
>    - redesign the access token hook before any browser path to tenant tables;
>    - compare `auth.users.email` in the invitation and notification paths;
>    - limit `avatars` uploads to the user's own folder;
>    - correct the stale docs (overnight handoff §2).
> 6. Rules:
>    - no merges, deploys, dashboard changes or live database writes without explicit
>      authorization for that instance;
>    - check C: free space before any Docker work.
