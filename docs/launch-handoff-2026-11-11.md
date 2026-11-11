# Launch handoff (2026-11-11, afternoon)

**Verdict: NOT READY FOR PILOT, with specific blockers.** Staging can be released once the PRs
below are merged. The pilot additionally needs the owner actions marked "before pilot", above all
the P0 database fix (#443) and a restore drill.

This document supersedes `docs/overnight-handoff-2026-11-11.md` (#439) for status. That one stays
useful as history.

Nothing was merged, deployed, or changed in any dashboard or live database in this session. No
paid API was called. All results below are from local runs or GitHub CI on the SHAs named.

## A. Main

`main` = `aaf36c47` (merge of #433). The CI `push` run on it is green.

## B. Merge order, with exact heads

| #   | PR   | Head       | What it does                                                                      | CI on head                          | Review                                   | Status                                                         |
| --- | ---- | ---------- | --------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 1   | #431 | `0fc0a762` | Reopened conversations hydrate without React #418                                 | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 2   | #432 | `614ef540` | Admin pages settle their states; denied `/admin` visits are logged                | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 3   | #435 | `68abfadc` | Quota concurrency tests stop failing under load                                   | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 4   | #429 | `b230b523` | Only transient ingestion failures are retried; reminder failures are shown        | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 5   | #440 | `e406e95a` | Invitations accepted by the session's email; join audited in the same transaction | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 6   | #436 | `c8a539d8` | Chat refuses clearly when moderation is unavailable; every error code has text    | green                               | done (overnight)                         | READY TO MERGE                                                 |
| 7   | #437 | `86d947b8` | Caps email to strangers from bookings, reschedules and reminders                  | green                               | **re-reviewed today**: 1 blocking, fixed | READY TO MERGE                                                 |
| 8   | #434 | `c62ab9a9` | Script that checks a staging candidate is the tip of main with green CI           | green                               | done (overnight); patch reviewed today   | READY TO MERGE                                                 |
| 9   | #442 | `c965aa93` | Email links work on another device (`token_hash`)                                 | green                               | **reviewed today**: 1 blocking, fixed    | READY TO MERGE                                                 |
| 10  | #443 | `5cb57edc` | **P0:** revoke Data API table privileges                                          | red at `migrations:check` by design | **reviewed today**: no code blockers     | BLOCKED on owner: one protected line, diagnostics, drill first |

- **Do not merge:** #430, #438 and #441, which are superseded by #440 and #442.
- **#439:** can be closed once this document is merged, or merged as history.
- **#398** (Windows test fixes) can go anywhere.
- **Dependencies:** none between 1–9. Each is a plain `git revert -m 1 <merge>`: none carries a
  migration, an environment change or a dependency change. #443 carries a migration (section G).
- **For each merge:** confirm the head SHA above, mark ready, merge with a merge commit, and wait
  for the `push` CI run on main to go green before starting the next.

### What today's reviews found

- **#442, blocking (fixed in `c965aa93`):** an open redirect. `safeInternalNext` returned
  `//evil.test/x` for `next=/.//evil.test/x`, because URL parsing removes dot segments after the
  checks ran, and `token_hash` links make it reachable by anyone. The returned path is now
  checked, and the token-hash path is rate-limited per address before `verifyOtp`.
  - Accepted and recorded: login CSRF, which is inherent to Supabase's `token_hash` flow.
    Invitations are not affected (#440).
- **#437, blocking (fixed in `86d947b8`):** case variants of one address (`a@x`, `A@x`, …) were
  charged once but each got its own reminder email. The send job now sends one email per mailbox.
  - Accepted and recorded: a concurrent burst for one offered slot can use up that page's hourly
    allowance. Moving the charge under the slot lock would hold the owner's calendar lock across
    up to 10 s of Redis timeouts.
- **#443 (P0):** see section D.

## C. Combined-tree results

Tree `37d11c3a` = `main` + the heads of rows 1–9 above + #443 at `a19c342b`. All nine merge
cleanly. #443's later commit `5cb57edc` changes only the invariants SQL and the doc, and was
re-verified by the two database runs below.

| Check                                                                                                                  | Where                                                           | Result                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`, `lint`, `typecheck`, `i18n:check`, `migrations:check`                                                  | Windows, at `c91735d8` (rows 1–9 at earlier heads of #437/#442) | PASS                                                                                                                                                                                                                                                                       |
| Production dependency audit (`--audit-level=high`)                                                                     | Windows                                                         | PASS (lower-severity advisories exist)                                                                                                                                                                                                                                     |
| Full unit suite                                                                                                        | Linux container                                                 | 5,545 passed, 58 skipped, **1 failed**: `hook-command-guard` › "no timeout binary on PATH". The test sets `PATH` to Node's directory, which in the Playwright image is `/usr/bin`, where `timeout` also lives. No PR touches hooks. Environment-specific, not a regression |
| Browser tests                                                                                                          | Linux container                                                 | 30/30 passed                                                                                                                                                                                                                                                               |
| Production build (cold)                                                                                                | Linux container                                                 | PASS. One warning (`supabase-js` uses `process.version` in the Edge runtime), also present in main's CI build                                                                                                                                                              |
| CI `rls` job steps (migrations, invariants, 3 RLS suites, integrity, reconciliation, `match_chunks`, invariants again) | Linux, `pgvector:pg15`                                          | PASS, with the fixture reproducing hosted DML defaults                                                                                                                                                                                                                     |
| #443 on Supabase's own image `supabase/postgres:17.6.1.167`                                                            | Linux                                                           | Exploit reproduced before the migration; refused after; invariants PASS                                                                                                                                                                                                    |
| `migrations:check` with #443                                                                                           | —                                                               | FAILS until the owner appends one line (section H, Supabase/GitHub)                                                                                                                                                                                                        |
| Playwright e2e against a running app                                                                                   | —                                                               | NOT RUN: needs a deployed or fully configured environment. The staging release runs them                                                                                                                                                                                   |
| Redis suites                                                                                                           | —                                                               | NOT RUN locally. Limiters are mocked in unit tests; CI's Redis job covers the real client                                                                                                                                                                                  |
| Opt-in Postgres suites (`*.postgres.test.ts`)                                                                          | —                                                               | NOT RUN locally; CI runs two of them. `invitation-accept-revoke.postgres.test.ts` runs nowhere (protected `ci.yml`)                                                                                                                                                        |

## D. Security assessment

### P0, open until #443 is deployed

**A signed-in user can take over another person's future account membership.** Hosted Supabase
grants `anon` and `authenticated` every privilege on public tables, and the Data API serves them.
`users_self_update` checks only `id = auth.uid()`, so the attack works like this:

1. User A sets their own `public.users.email` to an address B hasn't used yet.
2. When B signs up, `handle_new_user()` moves A's profile, and every membership, onto B.

This was reproduced on Supabase's image: the new account came out as OWNER of A's organization.
It also lets A confuse the "already a member" check and block B's invitation.

- **Fix:** #443 revokes the grants (the app never uses them) and adds release invariants.
- **Live state:** unverified. Run diagnostics D1–D6 in `docs/security/data-api-table-privileges-2026-11-11.md`.

### Dormant, must stay dormant

The custom access token hook is not registered. **Do not register it as written:**

- it overwrites the JWT `role` claim, which would break PostgREST and Realtime;
- it would switch on policy gaps that are inert today:
  - writes by any member with no role check;
  - organization-wide reads of conversations, invitation tokens, webhook secrets and key hashes.

#443 removes the grants those gaps would need anyway.

### P1 and P2 risks, accepted for a small trusted pilot

- **Login CSRF through `token_hash` links** (P2). Fix: a confirm-then-POST page, which would also
  stop mail scanners using up links.
- **Concurrent bursts can use up a booking page's hourly cap** (P2), at the cost of one real
  booking each.
- **Organization farming:** each FREE organization gets its own AI and email allowances (P2).
- **Workflow `email.send` has no per-organization cap.** It is unreachable on FREE.
- **Login and reset emails** are limited per IP only.
- **`storage_avatar_write`** lets any signed-in user upload to the public `avatars` bucket (P2).
- **No cross-tenant path was found** in policies or application code.

## E. Staging release procedure

1. Merge rows 1–9 in order. Each must show a green `push` CI run on main.
2. Apply patch A (and optionally B and C) from `docs/staging-release-hardening-2026-11-11.md`
   (#434), or do its checks by hand.
   - Patch A closes the two real gaps: CI isn't checked on the released SHA, and main can move
     during the approval wait. It is complete for that purpose.
   - It doesn't add a backup gate; that stays a manual checklist item.
3. Pre-release checklist (in that doc):
   - main CI green on the exact SHA;
   - no merge in flight;
   - backup or PITR confirmed;
   - `git diff <released>..<candidate> -- prisma/` read;
   - rollback target known;
   - Vercel Build Command not overridden.
4. Actions → **Staging release validation** → Run workflow from `main`, then approve the
   `staging` environment.
5. **After the run:**
   - all steps green;
   - `/api/health` on the stable alias reports the SHA;
   - no unexpected skipped e2e specs.
6. Run the pilot acceptance (section F).
7. **For #443 later:** owner adds the protected line, runs D1–D6, runs the drill from a pre-#443
   commit, merges, then releases again. The release invariants confirm the migration.

## F. Pilot acceptance checklist (on staging, EN, FI and AR, one phone)

- [ ] Sign up, confirm email (on a **different device** than the one that asked, after the
      template change), create an organization.
- [ ] Invite a second account as MEMBER; accept from the invitation email. A third account with a
      different email can't accept it.
- [ ] Business DNA: create, edit; a VIEWER can't edit.
- [ ] CRM: create a company and a contact; ask chat to create a contact, then confirm.
- [ ] Chat: a conversation, reload it while a reply streams, reopen it (no hydration error in
      Sentry).
- [ ] Knowledge base: upload a PDF, ask a question it answers, see the citation.
- [ ] Booking: public booking, then reschedule and cancel from the email link; the event appears
      and disappears in the calendar and CRM.
- [ ] Reminder email arrives (create an event about 25 h ahead, with yourself as attendee).
- [ ] Password reset requested on a laptop, opened on a phone.
- [ ] Settings → Billing doesn't reach a live Stripe checkout.
- [ ] `/admin` as a non-superadmin: denied, and the denial is logged.
- [ ] Sentry shows no new issue during the run.

## G. Rollback and recovery

| What             | How                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any of PRs 1–9   | `git revert -m 1 <merge commit>` on a branch, PR, merge, release                                                                                                                |
| Staging build    | Dispatch `staging-deploy-only.yml` for its pinned commit (`b129d416`), or a reviewed re-pin PR; `vercel promote <previous deployment>` is possible but undocumented for staging |
| #443's migration | A forward migration restoring the D1/D2 snapshots **and** removing its invariants in the same change; reopens the P0                                                            |
| Database         | Restore from backup or PITR into a **separate** project first (`docs/recovery-drill-runbook.md`); never in place without a drill. No restore has ever been performed            |

## H. Owner-only actions

Grouped by service. Each row says what it is, why, the evidence that it worked, whether it
changes anything, and when.

- **"Now":** can be done today.
- **"After merge" / "After deploy":** needs the release SHA.

### GitHub (syveka/syveka-ai)

| P   | Path                                                   | Action                                                                                                                                               | Why                                             | Evidence of success                                     | Changes config? | When                        |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- | --------------- | --------------------------- |
| P1  | Pull requests                                          | Authorize merging rows 1–9 of section B, in order, one at a time                                                                                     | Nothing reaches staging until merged            | 9 merge commits; green `push` CI after each             | Yes (merges)    | Now                         |
| P1  | `.github/workflows/staging-release.yml`                | Apply patch A from `docs/staging-release-hardening-2026-11-11.md` (B and C optional)                                                                 | Stops releasing an unverified or moved SHA      | A dispatch with a wrong typed SHA fails before approval | Yes (protected) | Before staging              |
| P0  | `scripts/check-migration-history.mjs` on #443's branch | Authorize appending `"20261111000000_revoke_data_api_table_privileges",` after `"20261014000000_secure_prisma_migrations_table",` in `expectedOrder` | Protected file; #443's CI can't pass without it | #443 CI fully green                                     | Yes (protected) | After the D1–D6 diagnostics |
| P2  | `.github/workflows/ci.yml`                             | Add `invitation-accept-revoke.postgres.test.ts` to the Postgres job                                                                                  | It runs nowhere                                 | The job lists it                                        | Yes (protected) | Later                       |
| P2  | Pull requests                                          | Close #430, #438, #441 (superseded) and #439 once this doc is merged                                                                                 | Avoids merging a superseded branch              | Closed                                                  | Yes             | After merges                |
| P1  | Actions → Staging release validation                   | Dispatch from `main` and approve `staging` (section E)                                                                                               | Puts the fixes where a pilot runs               | All steps green; health reports the SHA                 | Yes (deploy)    | After merges                |

### Supabase (staging first, then production)

| P   | Path                                                  | Action                                                                                                                                                                 | Why                                                                               | Evidence of success                                     | Changes config?   | When                            |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------- | ------------------------------- |
| P0  | Project → SQL Editor                                  | Run diagnostics D1–D6 from `docs/security/data-api-table-privileges-2026-11-11.md` (in #443) and keep the output                                                       | Confirms whether the P0 is open live; rollback reference                          | D1 output saved; D6 = 0 (or investigate)                | No (read-only)    | Now                             |
| P0  | Authentication → Hooks                                | Confirm "Customize Access Token (JWT) Claims" is **off**; leave it off                                                                                                 | The hook as written breaks PostgREST and opens dormant gaps                       | Off                                                     | No                | Now                             |
| P1  | Database → Backups (and PITR)                         | Note retention and PITR status; run the drill in `docs/recovery-drill-runbook.md` once into a disposable project, **from a commit before #443's merge**                | No restore has ever been performed; drill scripts expect only `20261014…` pending | Restored copy, row counts match, invariants as expected | Yes (new project) | Before #443 merge; before pilot |
| P1  | Authentication → Sign In / Providers → Email          | Confirm **Confirm email** and **Secure email change** are on                                                                                                           | #440 trusts the session's email                                                   | Both on                                                 | No                | Now                             |
| P1  | Authentication → Email Templates; → URL Configuration | After #442 is deployed: change Confirm signup, Reset password and Magic link as in `docs/auth-email-links.md`; confirm `https://<host>/api/auth/callback**` is allowed | Links opened on another device fail today                                         | A reset requested on a laptop works on a phone          | Yes               | After deploy                    |

### Vercel (`syveka-ai-staging`, and the pilot environment)

| P   | Path                                                 | Action                                                                                                      | Why                                                                                       | Evidence of success           | Changes config? | When           |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------- | --------------- | -------------- |
| P1  | Settings → Build and Deployment → Framework Settings | Confirm Build Command is the default (not overridden); note Node.js version (should be 22)                  | An override would skip `prisma generate && next build`'s type check                       | Default, Node 22              | No              | Now            |
| P2  | Settings → Build and Deployment → Deployment Checks  | Remove the native TypeCheck/Lint checks or accept them as noise on CLI deployments                          | They can't run on prebuilt uploads                                                        | No red TypeCheck on a release | Yes             | Before staging |
| P1  | Settings → Environment Variables                     | `EMAIL_FROM` is on `mail.syveka.com`; `STRIPE_SECRET_KEY` is absent or `sk_test_` (look at the prefix only) | Unverified sender fails; a live key takes real money (billing fails closed without a key) | Both as stated                | No              | Now            |

### Resend

| P   | Path                        | Action                       | Why                                    | Evidence | Changes config? | When |
| --- | --------------------------- | ---------------------------- | -------------------------------------- | -------- | --------------- | ---- |
| P1  | Domains → `mail.syveka.com` | Confirm Verified (SPF, DKIM) | Invitations, booking and reminder mail | Verified | No              | Now  |

### Upstash QStash (EU)

| P   | Path      | Action                                                                                                                        | Why                                                 | Evidence                   | Changes config? | When         |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------- | --------------- | ------------ |
| P2  | Schedules | Create `POST <app URL>/api/v1/jobs/usage-rollup`, cron `0 2 * * *`, body `{}`. Confirm the signing keys match the environment | 30-day purge and usage warnings never run otherwise | First delivery answers 200 | Yes             | Before pilot |

Reminders and ingestion need no schedules: they are delayed one-off publishes.

### Sentry, and uptime monitoring

| P   | Path                           | Action                                                                | Why                                                                                     | Evidence                          | Changes config? | When         |
| --- | ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------- | --------------- | ------------ |
| P1  | Sentry → Alerts → Create alert | Alert on new issues for staging and production; send one test event   | Errors help only if someone is told                                                     | Alert email/Slack on a test event | Yes             | Before pilot |
| P1  | Sentry Uptime or Better Stack  | `GET https://<pilot host>/api/health` every 1–5 min, alert on non-200 | Nobody is told when the app is down                                                     | An alert when the check fails     | Yes (new)       | Before pilot |
| P2  | Sentry → Alerts                | Alert on the log line `middleware_session_check_failed` (sustained)   | The only signal of a Supabase Auth outage; `/api/health` checks only database and Redis | Alert fires on a test             | Yes             | Before pilot |

### Product decisions

- **Pilot sign-up:** invite-only (recommended) or open.
- **Accept the two P2 trade-offs** in section D (login CSRF, burst on a booking page), or ask for
  the confirm page.

## I. GO / NO-GO

- **Merging rows 1–9: GO.** Each is reviewed, green and cleanly mergeable, and the combined tree
  passes everything except one environment-only test.
- **Staging release: GO after the merges,** with the pre-release checklist.
- **Pilot: NOT READY.** It needs:
  - #443 deployed (after the protected line, D1–D6 and a drill);
  - one restore drill;
  - an uptime monitor and error alert;
  - the Stripe key check;
  - the email template change;
  - an acceptance run on staging.

## J. Next-session prompt

> Continue the Syveka pilot launch from `docs/launch-handoff-2026-11-11.md` (branch
> `docs/launch-handoff-2026-11-11`).
>
> 1. Verify state with `git fetch`, `gh pr list` and main's CI. Do not trust the doc's SHAs
>    without checking.
> 2. For each PR the owner merged, confirm main's `push` CI is green.
> 3. If the owner authorized the `check-migration-history.mjs` line for #443, add it on
>    `fix/revoke-data-api-table-privileges`, run `migrations:check`, and confirm CI is fully green.
> 4. If the owner shared the D1/D6 results (as text, never secrets), compare them with the
>    expectations in the #443 doc.
> 5. Remaining code work, in order:
>    - P2: confirm-then-POST page for `token_hash` links;
>    - per-user cap on FREE organization creation;
>    - redesign the access token hook (custom `org_role` claim; SELECT for `supabase_auth_admin`)
>      before any browser path to tenant tables;
>    - compare `auth.users.email` instead of `public.users.email` in invitation and notification
>      paths;
>    - limit the `avatars` upload policy to the user's own folder;
>    - the stale docs listed in `docs/overnight-handoff-2026-11-11.md` §2.
> 6. Rules:
>    - no merges, deploys, dashboard changes or live database writes without explicit
>      authorization for that instance;
>    - local Linux runs follow the method in the doc's section C.
