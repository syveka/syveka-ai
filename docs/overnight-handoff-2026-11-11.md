# Overnight handoff, 2026-11-11

**Verdict: NOT READY FOR PILOT. Specific blockers are listed below.** The code for a first pilot is
close. Every fix found tonight is on a draft PR, and the draft PRs merge cleanly together. What
stands between this and a pilot is owner actions: merge authorizations, one staging release, a
restore drill, monitoring, a database grant check, and a few dashboard settings. Staging can be
released once the PRs below are merged (section 5).

- **Mission window.** Started 2026-11-11T00:09:08Z. Wall-clock end was 07:09Z; this report was
  finished at about 09:10Z.
  - Active work ran roughly 00:09–02:50Z, then about 08:55–09:10Z.
  - The gap was idle time after a usage limit stopped the sub-agents at about 01:45Z and the session
    waited.
  - Work after 07:09Z was limited to finishing and verifying changes already in progress, plus this
    report. No new task was started.
- **One merge was authorized and done:** #433.
- **Nothing was deployed.** No dashboard, database or live service was changed. No paid API was
  called.

## 1. What was done

### Merged (authorized)

| PR                                                       | Merge commit | Evidence                                                                                                                          |
| -------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| #433 test(ci): pin what type-checks prebuilt deployments | `aaf36c47`   | Head `44778d28` matched, 0 behind main, no review threads, `CI required` green. Main CI after the merge: run 42929145767, success |

### Draft PRs: new or updated tonight (none merged)

> **Use #440 instead of #430, and #442 instead of #438 (and #441).** Both old PRs fail the secret scan on a
> false positive: a random-looking synthetic UUID in a test (rule `generic-api-key`). The scan
> checks every commit in a PR, so a later commit can't clear it, and rewriting the branches would
> need a force-push, which was not authorized. No scanner exception was added.
>
> - #440 has the same content as #430 on current `main`; its tree was checked identical.
> - #442 is #438 with both synthetic test values made low-entropy, as one commit (`f63e8c53`); #441 was a first replacement that the scan still flagged.
> - The old PRs carry a comment pointing to their replacement. Close them when the replacement is
>   accepted.

| PR                                  | Head       | What changed tonight                                                                                                                                                                                                                                                       | CI on head                                                                                                                          |
| ----------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #430 guest/invite edge cases        | `9fefd56f` | **Security:** an invitation is accepted by the verified session's email, no longer by the user-writable `public.users.email` (a member could otherwise take a pending ADMIN invitation). **Integrity:** the `member.join` audit row is written inside the join transaction | `63b3c37e` failed only the secret scan, a false positive on a synthetic test UUID; `9fefd56f` replaces it, see PR. `32194cee` green |
| #432 page guards                    | `614ef540` | A signed-in non-superadmin reaching `/admin` is logged (`superadmin_access_denied`, user id only). The `/admin` index is guarded; a test requires every admin page to be                                                                                                   | green                                                                                                                               |
| #429 job failures                   | `b230b523` | `Upstash-Retried` confirmed from Upstash docs. Ingestion retries only failures positively identified as transient, so a failure that can't succeed no longer re-pays embeddings four times. U+0000 is stripped before chunking                                             | green                                                                                                                               |
| #431 chat hydration                 | `0fc0a762` | The last render-time clock read is removed: an action expiring between server render and hydration no longer causes React #418                                                                                                                                             | green                                                                                                                               |
| #434 (new) staging candidate check  | `c62ab9a9` | `scripts/verify-staging-candidate.ts`: the release commit must be the typed SHA, the tip of main, with green main CI. The workflow patch is documented, not applied (workflows are protected)                                                                              | green                                                                                                                               |
| #435 (new) flaky quota test         | `68abfadc` | Test-only. The concurrency tests no longer fail under load; the assertions are unchanged and still catch a broken reservation (mutation-checked)                                                                                                                           | green                                                                                                                               |
| #436 (new) moderation outage        | `c8a539d8` | Chat fails closed with a translated 503 when moderation can't be checked; the user never sees a raw `chat.errors.*` key                                                                                                                                                    | green                                                                                                                               |
| #437 (new) email abuse caps         | `99f29361` | Public bookings and email-link reschedules are capped per guest (per organization) and per booking page, counting only attempts for an offered slot. Event reminders are budgeted per organization by the addresses a save sends to, including moves                       | see PR                                                                                                                              |
| #438 (new) cross-device email links | `9256ec84` | The auth callback also accepts `token_hash` links (`verifyOtp`), so reset and sign-up emails work on another device. Users see no change until the Supabase templates change                                                                                               | see PR                                                                                                                              |

Each PR description has its own evidence table: fail-first results, focused tests, full-suite counts
and review outcome.

### Verification of the combined tree

#431, #432, #435, #429, #430 (at `63b3c37e`), #436 (at `4afac08e`), #437 (at `43536f88`) and #434
were merged in memory onto `aaf36c47`, in that order. The result is local commit `07684b39`, not
pushed. Results on Windows with Node 22:

| Check                                                                 | Result                                                                                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`, `lint`, `typecheck`, `i18n:check`, `migrations:check` | PASS                                                                                                                                                                                                |
| `npm run build` (CI placeholder env)                                  | PASS                                                                                                                                                                                                |
| `npm test` (full)                                                     | 5,488 passed, 12 failed, 57 skipped. The 12 are `handler-guard-coverage` (11, backslash paths) and `recovery-drill-scripts` (1, timeout). They fail identically on clean `main` and #398 fixes them |
| `npm run test:browser`                                                | 30/30 PASS                                                                                                                                                                                          |
| `npm run test:e2e`                                                    | NOT RUN: needs a deployed environment                                                                                                                                                               |
| PostgreSQL and RLS suites                                             | NOT RUN locally (Docker not running). They run in each PR's CI                                                                                                                                      |

**Not covered by that combined run, verified per branch only:**

- #430: `9fefd56f` (test token change only);
- #436: `c8a539d8` (review follow-ups);
- #437: `d1cb02dc`, `98e383c5` and `99f29361` (blocking review fix, two bypass fixes, formatting);
- #438 (all of it).

`git merge-tree` shows the current heads of #429, #430, #436 and #437 still merge cleanly with each
other. Re-run the combined check on the final heads before the first merge. Each full-suite count is
in the PR.

### Independent reviews run tonight

| Change                                      | Reviewer                                                       | Result                                                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #429–#432 combined (before tonight's fixes) | security, code                                                 | No blocking issue; should-fix items became tonight's fixes                                                                                                                                                                    |
| #430 audit atomicity, #432 denial log       | security                                                       | No blocking issue                                                                                                                                                                                                             |
| #431 hydration, #435 flaky test             | code                                                           | No blocking issue                                                                                                                                                                                                             |
| #429 retry classifier                       | code, read against the installed Prisma, storage-js and openai | No blocking issue; two should-fix items applied                                                                                                                                                                               |
| #430 session email (`63b3c37e`)             | security                                                       | No blocking issue. It depends on Supabase "Confirm email" and "Secure email change" being on (owner action 8)                                                                                                                 |
| #437 email caps (`43536f88`)                | security                                                       | **Blocking:** anyone could switch off a booking page with junk requests. Fixed in `d1cb02dc` (only bookable attempts count). Two should-fix bypasses (moves, reschedules) fixed in `98e383c5`. The fixes were not re-reviewed |
| #436 moderation outage (`4afac08e`)         | code                                                           | No blocking issue; its two should-fix items and the wording notes were applied in `c8a539d8`                                                                                                                                  |
| #438 cross-device links                     | —                                                              | NOT RUN                                                                                                                                                                                                                       |

## 2. What remains

### P0: security, tenant isolation, data integrity

- **The database lets a signed-in user write more than the app intends** (pre-existing, found by
  tonight's audit). Policy text verified; live grants not verified.
  - 14 tenant tables have INSERT/UPDATE policies for any `authenticated` member with no role check.
  - `public.users` has an UPDATE policy with no column limit.
  - Conversations and messages are readable organization-wide.
  - Invitation tokens, `webhook_endpoints.secret` and `api_keys.key_hash` are readable by every member.
  - The app reaches Supabase from the browser only for Realtime on `notifications`.

  If Supabase's default table grants to `authenticated` are live, a member with the public anon key
  and their own session can bypass app RBAC, audit and quotas inside their organization. **No
  cross-tenant path was found.** The application-layer escalation (invitations) is fixed in #430, now #440.

  The fix is a correction migration that revokes table privileges from `anon` and `authenticated`
  except what Realtime needs. That is a migration and needs your authorization. First run the
  read-only grant query in owner action 4.

### P1: blocks a reliable first pilot

1. **None of the fixes are deployed.** The last staging deploy (2026-11-03, by run history; the live
   alias was not queried) was `b129d416`, 50 commits behind main, before the 9 draft PRs.
2. **Backups and restore are unproven.** No restore has ever been performed
   (`docs/recovery-drill-runbook.md`).
3. **No uptime monitoring or alerting.**
   - `/api/health` checks only the database and Redis.
   - A sustained Supabase Auth outage shows only as the log line `middleware_session_check_failed`.
4. **Cross-device email links fail.** A password-reset or sign-up email opened on a different device
   or browser lands on "link failed", because the callback needs the PKCE verifier from the browser
   that asked. Code fix: #442 (replaces #438). Owner action: change the Supabase email templates after it is
   deployed (owner action 9).
5. **A pilot owner can reach a real Stripe checkout.** Settings → Billing has no pilot guard. Leave
   the Stripe keys unset on the pilot environment, or set test-mode keys (owner action 6).

### P2: important, not blocking a small trusted pilot

- **QStash has zero schedules.** Three jobs need one:
  - `usage-rollup` (`0 2 * * *`): 30-day purge of soft-deleted data, 80% usage warnings;
  - `calendar-sync` (`0 */6 * * *`): only with Google/Microsoft calendars;
  - `reconcile-creator-generations` (`*/5 * * * *`): only with Creator Studio.

  Reminders and document ingestion do **not** need schedules; they are delayed one-off publishes.
  Quotas do not depend on `usage-rollup`.

- **`schedule.cron` workflows** can be saved through the server action but nothing runs them. The
  builder doesn't offer them, and FREE plans can't activate workflows.
- **Organization farming:** one account can create many FREE organizations, each with its own AI
  allowance and its own email budgets (10 creations a minute).
- **Workflow `email.send` has no per-organization cap.** It is unreachable on FREE, where active
  workflows are 0. Cap it before granting workflows to anyone.
- **`public.users.email` is user-writable.** It is still used to decide "already a member" when
  inviting, and as the owner's notification address. A user could block invitations to an address,
  or a victim's sign-up, via the unique constraint. Same fix as the P0 grant correction.
- **Login and reset emails are limited per IP only;** Supabase's own limits are the backstop.
- **Knowledge base:** only file upload has a UI (no notes or URLs). A failed document has no retry
  button.
- **Inbox and voice nav items stay visible** when those features are off.
- **Windows/load test failures** (`handler-guard-coverage`, `recovery-drill-scripts`,
  `staging-deploy-only-workflow`, `voice-conversation-flow`) fail locally only. #398 fixes them, is
  green, and merges cleanly.

### Technical debt noted, not fixed

- The provider timeout (`APIConnectionTimeoutError`) is not treated as transient in
  `src/server/ai/retry.ts`.
- `subscribeNever` and the hydration-flag idiom are duplicated in four files.
- Owner booking emails, usage warnings and some knowledge-base labels are English only.
- Stale docs:
  - several say reminders need QStash schedules;
  - the feature inventory says Sentry is not integrated;
  - the readiness matrix says chat has an OpenAI fallback; it doesn't, and OpenAI moderation is a
    hard dependency.

## 3. Owner actions, in order

None of these needs a secret pasted anywhere. Do the "before staging" items first.

| #   | Where                                                   | Path                                                                                                      | What to do                                                                                                                                                                                                                                                                      | Why                                                                                                    | Expected result                                                        | Risk                                              | Needs authorization         | When                                    |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------- | --------------------------------------- |
| 1   | GitHub                                                  | `syveka/syveka-ai` → Pull requests                                                                        | Review, then authorize merging in the order of section 4, one at a time, waiting for main CI to be green after each                                                                                                                                                             | Nothing reaches staging until merged                                                                   | 9 merges, main CI green after each                                     | Low: each is a clean merge and revertable         | Yes, per PR                 | Before staging                          |
| 2   | Vercel                                                  | `syveka-ai-staging` → Settings → Build and Deployment → Framework Settings                                | Confirm **Build Command** is the default, not overridden. Also note the Node.js Version setting                                                                                                                                                                                 | An override would replace `prisma generate && next build`, the build that type-checks every deployment | Default build command                                                  | None (read-only)                                  | No                          | Before staging                          |
| 3   | Vercel                                                  | `syveka-ai-staging` → Settings → Build and Deployment → Deployment Checks                                 | Remove the native **TypeCheck** and **Lint** checks, or accept their failure on CLI deployments as noise                                                                                                                                                                        | They can't run on prebuilt uploads (`docs/vercel-typecheck-check-cli-deployments.md`)                  | No red TypeCheck on releases                                           | Low                                               | Yes (settings change)       | Before staging                          |
| 4   | Supabase (staging, then production)                     | Project → SQL Editor                                                                                      | Run read-only: `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') order by 1,2,3;` and keep the output                                                                 | Decides how serious the P0 above is                                                                    | Ideally no INSERT/UPDATE/DELETE for `authenticated`                    | None (read-only)                                  | No                          | Before pilot                            |
| 5   | Supabase                                                | Project → Database → Backups (and Point in Time Recovery)                                                 | Confirm the plan's backup retention and whether PITR is on. Then run the drill in `docs/recovery-drill-runbook.md` once into a disposable project                                                                                                                               | No restore has ever been performed                                                                     | A restored copy with core tables and row counts matching               | Medium (do it on a copy, never in place)          | Yes (the drill)             | Before staging migrations; before pilot |
| 6   | Vercel                                                  | `syveka-ai-staging` (and the pilot environment) → Settings → Environment Variables                        | Check that `EMAIL_FROM` exists and its address is on `mail.syveka.com`. Check whether `STRIPE_SECRET_KEY` is absent or test-mode (look at the prefix only, never copy the value)                                                                                                | Mail from an unverified domain fails; a live Stripe key makes the billing page take real money         | `EMAIL_FROM` on the verified domain; Stripe absent or test             | None (read-only)                                  | No                          | Before pilot                            |
| 7   | Resend                                                  | Domains → `mail.syveka.com`                                                                               | Confirm it still shows Verified (SPF, DKIM)                                                                                                                                                                                                                                     | Invitations and booking emails use it                                                                  | Verified                                                               | None                                              | No                          | Before pilot                            |
| 8   | Supabase                                                | Authentication → Sign In / Providers → Email                                                              | Confirm **Confirm email** is on and **Secure email change** is on                                                                                                                                                                                                               | #430 trusts the session's email; both settings keep it a confirmed address                             | Both on                                                                | None (read-only)                                  | No                          | Before pilot                            |
| 9   | Supabase                                                | Authentication → Email Templates, and → URL Configuration                                                 | After #442 is merged and deployed, change the Confirm signup, Reset password and Magic link templates as in `docs/auth-email-links.md` (in #442). Confirm `https://<app host>/api/auth/callback**` is in the redirect URLs                                                      | Links opened on another device fail today                                                              | A reset requested on a laptop and opened on a phone works              | Low (revert the template)                         | Yes                         | Before pilot                            |
| 10  | GitHub                                                  | Actions → Staging release validation → Run workflow (from `main`), then approve the `staging` environment | Release main to staging after merges 1–9. Use the checklist in `docs/staging-release-hardening-2026-11-11.md` (#434): confirm main CI is green on that exact SHA first                                                                                                          | Puts the fixes where a pilot runs                                                                      | 43 steps green; `/api/health` on the stable alias reports the SHA      | Medium (migrations run first; none pending today) | Yes (dispatch and approval) | Staging                                 |
| 11  | Staging site                                            | Sign in as owner; then as a member                                                                        | Acceptance: sign-up, invite a second account and accept it, Business DNA, chat (including reopening a conversation with replies), create a contact through chat and confirm, a public booking end to end, reschedule and cancel from the email link, in EN, FI and AR on mobile | Nothing in the pilot scope has been observed on a deployed build since 2026-11-03                      | Every journey completes; Sentry stays quiet on the reopened-chat route | Low                                               | No                          | After staging                           |
| 12  | Sentry                                                  | Alerts → Create alert                                                                                     | An alert on new issues in the staging and production projects. Confirm one test event arrives from the pilot environment. Resolve SYVEKA-STAGING-1/-3/-4/-5/-7/-8 only after step 11 shows them quiet                                                                           | Errors are only useful if someone is told                                                              | An email or Slack alert on a test event                                | Low                                               | Yes (settings)              | Before pilot                            |
| 13  | Uptime monitor (Sentry Uptime, Better Stack or similar) | New HTTP monitor                                                                                          | `GET https://<pilot host>/api/health` every 1–5 minutes; alert on non-200. Optionally assert the body's `build` equals the released SHA                                                                                                                                         | No one is told when the app is down                                                                    | An alert when the check fails                                          | Low                                               | Yes (new service)           | Before pilot                            |
| 14  | Upstash                                                 | QStash (EU) → Schedules                                                                                   | Create `POST <app URL>/api/v1/jobs/usage-rollup`, cron `0 2 * * *`, body `{}`. Not the other two unless calendar sync or Creator Studio is on. Confirm this account's signing keys are the ones in the environment, and note the plan's maximum delay (Pay as you go: 1 year)   | 30-day data purge and usage warnings never run                                                         | One active schedule; its first delivery answers 200                    | Low                                               | Yes (configuration)         | Before pilot (purge), or later          |
| 15  | Product decision                                        | —                                                                                                         | Pilot sign-up: invite-only, or open? Until #437 is merged, open sign-up allows bulk mail through event reminders                                                                                                                                                                | Abuse exposure                                                                                         | A decision                                                             | —                                                 | Yours                       | Before pilot                            |

## 4. Merge order

The order runs from the smallest behaviour change to the largest.

1. #431 hydration
2. #432 page guards
3. #435 flaky test
4. #429 job failures
5. #440 invitations and audit (replaces #430)
6. #436 moderation outage
7. #437 email caps
8. #434 staging check
9. #442 cross-device links (replaces #438)

#398 (Windows test fixes) can go anywhere.

- **Merges checked.** The first eight were checked together in memory (section 1). The current heads
  of #429, #430, #436 and #437 were also checked against each other.
- **#438** merges cleanly with #429, #430, #436 and #437. It touches only the auth callback, a test
  and a doc.
- **Dependencies.** None. #430 and #436 touch `src/app/api/v1/ai/chat/route.ts` in separate hunks.
  #430 and #437 touch `src/server/services/booking.ts` in separate hunks.
- **Re-review.** #437's last three commits were not re-reviewed independently. A security re-read of
  `d1cb02dc..99f29361` before merging it is recommended.
- **For each merge:**
  - confirm the head SHA in the table above;
  - mark ready and merge with a merge commit;
  - wait for the `push` CI run on main;
  - start the next only when it is green.
- **Rollback.** None of the eight carries a migration, an environment change or a dependency change,
  so each is a plain `git revert -m 1 <merge commit>`.

## 5. Launch assessment

- **Can staging be released safely?** Yes, after the merges.
  - The release workflow gates every step and there are no pending migrations.
  - Confirm main CI on the exact SHA (owner action 10) and backups first (owner action 5).
  - Rollback to the current build is a dispatch of `staging-deploy-only.yml` (pinned to `b129d416`).
- **Can the first pilot customer be onboarded safely?** Not yet. These must be done first:
  - the staging release and acceptance run;
  - one restore drill;
  - an uptime monitor and an error alert;
  - the grant check, and the correction migration if needed;
  - the Stripe key check;
  - the cross-device link fix with its template change (or tell the pilot to open links on the
    same device).
- **What is genuinely ready** (code and tests, not yet observed on a deployment):

  | Status                 | Modules                                                                                                                                                                                                                                       |
  | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Ready with limitations | Authentication, onboarding, team and invitations, Business DNA, CRM, booking and the internal calendar, transactional email, background jobs, quotas and pilot grants, notifications and settings, AI chat, knowledge base (file upload only) |
  | Partial (keep off)     | Workflows                                                                                                                                                                                                                                     |
  | Off for the pilot      | Creator Studio, voice, paid billing, external calendar sync, inbox                                                                                                                                                                            |

- **Smallest realistic launch.** One or two trusted organizations on FREE with grants, invite-only.
  - Booking, CRM, Business DNA and team.
  - AI chat (typed) and the knowledge base (file upload) with stated limits.
  - Everything else off.
  - Booking into CRM is the journey that survives every optional dependency: it still completes with
    email or QStash down.
- **Next session:**
  1. Re-run the combined check on the final heads, and get a security re-read of #437's last three
     commits and a review of #442.
  2. The database grant correction migration (after owner action 4), with RLS tests.
  3. A pilot guard on Settings → Billing.
  4. A per-user cap on FREE organization creation.
  5. A staging e2e journey for booking → CRM.
  6. Correct the stale docs listed above.
