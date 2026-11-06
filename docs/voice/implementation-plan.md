# Voice metering, limits and disclosure: release plan

Written for the owner and reviewers. It describes integration candidate #415 at `aea51796`, and draft PRs #408 at `ce55d110`, #411 at `a35094c2` and #410 at `af1c7f9c`, against `origin/main` at `40f71ae7`. Updated 2026-11-06. [Decisions](#decisions) separates what the owner authorized directly from what still needs confirming. **Nothing here has been merged, deployed, or tried on a real call, and #415 approves no pending decision.** Merging, deploying, paid calls, live Vapi writes, approved-language activation, schedules and production settings each need separate authorization. Prices and commercial allowances stay pending owner decisions.

## Status

| Work                                               | Done                                                                                                                                                              | Still needed                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #408                                               | CI passes at `ce55d110`, including the real suites                                                                                                                | Owner's merge decision                           |
| #411                                               | CI passes at `a35094c2`, including the real suites. Independent review of its last code commit found no blocker                                                   | Owner's merge decision, after #408               |
| #410                                               | Audit, recovery drill and release path fixed. CI passes at `af1c7f9c`, with the guard patch applied                                                               | Recording decision confirmed, PITR, restore test |
| `CI required` as a required check                  | **Applied 2026-11-06.** Three control PRs show it fails as it should                                                                                              | Nothing                                          |
| #415 integration candidate                         | #408, #411, #410, #409, #407 and fixes from an audit of the combination, at `aea51796`. [CI](https://github.com/syveka/syveka-ai/actions/runs/42207703375) passes | The decisions below, then merging                |
| Real calls, Vapi behaviour, production usage query | None run                                                                                                                                                          | Each needs its own authorization                 |

Three levels of evidence, which shouldn't be mixed:

- **Mocks and fake executables:** the unit tests, including the Vapi calls and the fake `docker` and `npx` in the `s7` tests.
- **Real databases, synthetic data:** the Redis and PostgreSQL suites in GitHub Actions and locally, and the recovery rehearsal on local containers with no network.
- **Real calls and production:** none yet.

## What releases

**#408 is the release candidate.** It holds the metering, limits and notice work together, because reconciliation has to honour both limits and the notice, and those changes conflict when kept apart.

| PR               | Role for release                                                      | Why                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #408             | **Release this**                                                      | Contains every commit below                                                                                                                                           |
| #411             | **Release with #408,** after it                                       | Reconciliation and limit fixes from review. One commit on #408. Doesn't change the database                                                                           |
| #410             | **Release after #408,** once the recording decision is confirmed      | The recording setting. Stacked on #408, without #411. A trial merge with #411 had no conflict, and typecheck and 154 focused tests passed. Adds a migration           |
| #407             | **Separate dependency.** Release before or after #408                 | Reads AI replies by block type. Not in #408. Both change `tests/unit/post-call-idempotency.test.ts`, so whichever merges second has to resolve that one test conflict |
| #409             | Independent                                                           | Arabic call summaries, from separate work. Merges cleanly with #408                                                                                                   |
| #404, #405, #406 | **Superseded for release. Don't merge.** Keep open for review history | All their commits are inside #408, and #408 goes further                                                                                                              |
| #335             | **Superseded for release.** Keep for review history                   | Its notice commit is in #408. Its forced recording is removed there. It also supersedes #265 and #304                                                                 |
| #398             | Optional                                                              | Fixes Windows and load-related unit test failures, so it doesn't change the product                                                                                   |
| #403             | This plan, with no code                                               | Holds the CI patch for the owner                                                                                                                                      |

### Commits in #408

Oldest first. Merge commits are left out.

- `063e4b40` fix(voice): meter calls from documented times and recover lost webhooks
- `fe98e6f4` fix(voice): atomic per-tenant call slots, hard caps and no unlimited Enterprise
- `f71829a2` fix(voice): speak the AI and recording notice first, and request recording in Vapi's artifactPlan
- `6d4fff1e` fix(voice): enforce the spoken AI notice at each call, fail closed
- `4a1f16bb` docs(env): document VOICE_DISCLOSURE_APPROVED_LANGUAGES
- `ab3928f1` fix(voice): refuse tools and keep nothing for a call whose notice isn't confirmed
- `d380e838` fix(voice): settle more calls correctly and stop reconcile looping
- `da48f4e1` fix(voice): a retry can't end an admitted call; refused calls aren't charged
- `9f8526d1` fix(voice): bound the reconcile job's call list read
- `8bf945de` fix(voice): mark a refusal before hanging up; retries survive an outage
- `90e36150` fix(voice): keep a legitimate report when only its start was missed
- `f7a4d351` test(voice): give the Postgres binding suite the call slot script
- `036d0918` fix(voice): a notice refusal is final, and retries stay safe
- `c88f0aa4` fix(voice): decide nothing on unreadable state
- `42a00252` test(voice): remove an unused import
- `a0787ddf` test(voice): pin that an unreadable refusal alone makes the webhook wait
- `fae79e05` fix(voice): judge a missed start by its own record, and stop forcing recording
- `828ae4ed` feat(voice): show what stops an assistant taking calls, in FI, EN and AR
- `85aebd4c` fix(voice): a start only checks a call still running; evidence stays inside refusal memory
- `e7adf7e6` docs(voice): list the notice, re-sync, recording and schedule activation steps
- `cf0a69eb` fix(voice): word the phone-number action by state; test the panel's place in the real form
- `ee900899` fix(voice): a late start can't vouch for its call, and only real findings refuse for good
- `717fa975` fix(voice): a partial record or a finished call can't refuse a call for good
- `9ef1e8e3` fix(voice): keep the transcript that proved the notice; a running refusal needs evidence too
- `a3f85a74` style(voice): format a test, drop a leftover block, correct a comment
- `608237c9` fix(voice): a language counts only if approved when the call began
- `85670148` fix(voice): judge a late start's approval by when Vapi says the call began
- `3cf63d2b` fix(voice): test approval against the earliest stated start on every path
- `ce55d110` ci: run the real Redis and voice binding suites, and require them

`f71829a2` came from #335 and forced recording on. `fae79e05` removes that part and keeps the spoken notice.

## Integration candidate #415

**Not authorized to merge or deploy.** The branch `integration/voice-staging-2026-11-06` shows that these PRs work together. The original PRs stay open.

| Order | PR   | Note                                                                                                                     |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 1     | #408 | Includes #404, #405 and #406 in full, and #335's notice commit with its forced recording removed. Don't merge those four |
| 2     | #411 | One commit on #408, plus the merge of the CI patch                                                                       |
| 3     | #410 | Adds the migration and the guard patch                                                                                   |
| 4     | #409 | Merges cleanly                                                                                                           |
| 5     | #407 | Conflicts with #408 only in `post-call-idempotency.test.ts`. #415 keeps both sets of tests                               |
| 6     | #415 | The conflict resolution and the audit's fixes, in commits `36c729dc` and `aea51796`                                      |

**Suggested way to merge,** once decided: #408, #411, then #415, which brings the rest with its fixes. The fixes change code #410 adds, so **rejecting #410 means rebuilding the candidate without it.** #398 is independent and only changes tests. #402 and #403 are documents.

**Staging can't run from a branch.** `staging-release.yml` refuses anything but `main`, so a trial needs the merge decision first. Merging doesn't deploy production. A Vercel Preview of this branch reaches the staging database without the new column, so its voice pages would fail until the migration is applied. Don't test on such a Preview.

### What the audit of the combination fixed

Each has a regression test, seen failing first.

| Severity | Defect                                                                                                                   | Fix                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| High     | A failed Vapi sync said "try again", though the change was saved and Vapi might still record                             | Says it's saved, and that the service may use the old settings, in FI, EN and AR                                                        |
| High     | One provider error lost a call's summary for good                                                                        | QStash retries it, and only the last attempt finishes without one                                                                       |
| Medium   | A save and its audit row could separate                                                                                  | One transaction. On real PostgreSQL, a failed audit row rolls the change back                                                           |
| Medium   | A call could count twice against limits when post-call failed after recording usage, refusing calls wrongly              | A call with recorded usage no longer counts as uncertain                                                                                |
| Medium   | The summary prompt held the system turn and tool results, and cut off a long call's end                                  | Only spoken turns, and it keeps the end                                                                                                 |
| Medium   | A caller's words reached the prompt unmarked                                                                             | Wrapped as untrusted data, and they can't close the wrapper. A caller can still try to steer the summary's text. That call has no tools |
| Low      | `FI@old,FI@bad` left FI approved                                                                                         | Any invalid entry withdraws that language                                                                                               |
| Low      | A bare code fence or empty summary was mishandled, and a cut-off reply wasn't identified                                 | Parsed, refused and logged as `truncated`                                                                                               |
| Low      | Arabic assistants got the notice instruction in English                                                                  | Arabic, pending native review                                                                                                           |
| Low      | A failed Vapi delete wasn't in the audit row, a failed sync logged nothing, and `voice.errors.invalid_input` was missing | Added                                                                                                                                   |

### Open defects, by impact

| Impact | Defect                                                                                                                                                                                                   | Why it's open                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Medium | After leaving the page, nothing shows a failed recording sync. The page says "off" while Vapi may still record. Only `voice_assistant.sync_failed` in the audit log remains, and a later save repairs it | A live comparison needs Vapi's real response. Check on the trial |
| Medium | A tool call with no `artifact.messages`, after a missed start, ends a possibly good call                                                                                                                 | Depends on Vapi's real payload. Real-call check 3                |
| Medium | A failed Vapi delete can leave an assistant at Vapi that Syveka can't reach                                                                                                                              | Now audited, but nothing retries it                              |
| Low    | A call Syveka hung up can be billed if the "ended" marker write fails, or if Redis loses keys. Refusals have no PostgreSQL copy                                                                          | Needs a durable refusal record, which means a migration          |
| Low    | If the hang-up and the "running" write both fail, a call can run unbilled                                                                                                                                | Same                                                             |
| Low    | Two simultaneous starts can leave a refused call with a row, which only reconciliation closes, and it could bill it if the schedule isn't running within 48 hours                                        | Depends on the schedule                                          |
| Low    | A slower resync can overwrite a newer recording choice at Vapi. A retry and a requeue can both pay for a summary, and the stored text can then differ from the CRM activity                              | Rare                                                             |
| Low    | Usage has no unique constraint behind its advisory lock. The lock is proven on real PostgreSQL by `post-call-concurrency`                                                                                | A partial unique index needs a migration                         |
| Low    | The usage query grows with stuck rows, and fails closed at an extreme count                                                                                                                              | Rare                                                             |
| Low    | If Vapi uses a role other than `user`, `bot` or `assistant` for speech, the summary is silently skipped                                                                                                  | T1 shows the real roles                                          |
| Low    | The retry test doesn't assert usage or contact across attempts, though the code is idempotent by reading                                                                                                 | Test depth                                                       |
| Low    | FI and EN follow-ups aren't pinned to a language, and activity and notification text is English                                                                                                          | Copy                                                             |

## How a call is judged

A configuration read after a call started can't show what its caller heard. So there is one rule: nothing about a call is kept, billed, sent to the CRM or sent to an AI provider without evidence bound to that call. Three kinds of evidence count:

1. **A check at the start.** Vapi's record must say the call hasn't ended. Within 30 seconds of the call beginning, a fresh read of the assistant can stand for its start.
2. **The signed start message's own description of the assistant,** if complete, at any time while the call runs.
3. **The call's own record.** Vapi's `artifact.messages` must show the assistant opening with the notice, for a call begun within the last 36 hours. Those messages then become the call's transcript.

### At the start

| Situation                                                                      | Outcome                                                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Check passes                                                                   | Confirmation and row written, slot taken, call continues                                                                           |
| Configuration doesn't have the notice                                          | Notice refusal recorded for good, hung up                                                                                          |
| Start arrives after the call ended, or is replayed                             | Nothing written, no slot taken                                                                                                     |
| Language not approved, or the assistant can't be read                          | Hung up as Syveka's own ending ("ended"), so not kept or billed. If the hang-up fails, nothing is recorded and the webhook retries |
| Vapi's record of the call can't be read, and the start's signed time is recent | The same                                                                                                                           |
| Vapi's record of the call can't be read, and the start is older or has no time | Hung up, nothing recorded, webhook retries, because a hang-up may not have ended anything                                          |
| More than 30 seconds in, and what the call has said shows the notice           | As a passed check                                                                                                                  |
| More than 30 seconds in, and what it has said is something else                | Hung up. Nothing is recorded, because a running record may lack its opening. The report decides                                    |
| More than 30 seconds in, and nothing can say                                   | Held to the limits with a slot and no row. Its tool calls and report judge it                                                      |

### What a caller hears, in an example

**Callers are never asked for consent.** "Approval" means the operator approved a language's wording, in `VOICE_DISCLOSURE_APPROVED_LANGUAGES`. Whether to add consent or objection handling is a [decision](#decisions), not a bug.

Suppose it holds `FI@2026-11-12T08:00:00Z`, for a Finnish assistant:

| When                                      | What happens                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call at 09:00                             | Vapi speaks "Puhut tekoälyavustajan kanssa, ja puhelu voidaan tallentaa.", then the greeting, and it can't be interrupted. The call is checked, then kept and billed |
| Call at 07:59, or a report of it later    | Began before approval, so it's refused. It's hung up at the start, and nothing is kept or billed, even if approval comes while it runs                               |
| Later change to `FI@2026-11-01T08:00:00Z` | A time earlier than the deploy can vouch for earlier calls, which is why the plan requires a time no earlier than the deploy                                         |
| An English assistant at 09:00             | English isn't listed, so it's hung up. The caller may hear some of the notice first, because the check doesn't hold the audio                                        |
| Caller objects                            | The prompt has no instruction for this. The model answers as it sees fit                                                                                             |
| Caller hangs up during the notice         | With a checked start, it's kept and billed, rounded up to a minute if connected. With a missed start, a partial notice counts as absent, so it isn't kept            |
| Connection lost mid-call                  | Settled from the report, or from Vapi by reconciliation. An unknown length stays unbilled                                                                            |

The spoken wording is the same with recording off, and it follows the assistant's language, not the language the caller speaks.

### After a missed start

| Situation                                                                        | Outcome                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Record shows the notice first                                                    | Kept and billed                                                                          |
| Tool call, and what the call has said shows something else                       | Tools refused and the call ended. Nothing lasting is recorded                            |
| Report or ended record shows something else first                                | Notice refusal recorded for good, nothing kept                                           |
| Record can't say. This includes part of the notice, or another language's notice | Nothing kept, nothing refused. Reconciliation tries again for 24 hours                   |
| Record unreadable, or Redis failing                                              | Webhook retried, or left for the next reconciliation run                                 |
| Language not approved today                                                      | Nothing kept, nothing refused                                                            |
| Call older than 36 hours                                                         | Its record no longer counts, so a replay can't outlive a refusal remembered for 48 hours |

A row already written can't outlast a recorded refusal: reconciliation closes such a row, with no job and no usage. A call refused by limits whose hang-up failed still has to pass the same evidence rule before it's billed.

### Limits of this rule

- **The start check reads configuration, not speech.** A call that passed at its start isn't compared with what was then spoken.
- **A configuration edit inside the 30-second window** could be read as if it applied at the start.
- **A row written before this release** counts as already checked.
- **A missed-start call is compared with today's notice text.** Changing the wording within the 36 hours could turn a good call into a refusal for good. Another language's notice is treated as no evidence, so a language edit can't.
- **Transcripts may not match the notice exactly.** Punctuation, spacing and Arabic marks are ignored, but other differences read as contradiction. No real payload has been checked (see real-call validation).
- **Approval is judged at the call's start, pending [confirmation](#decisions).** Each entry in `VOICE_DISCLOSURE_APPROVED_LANGUAGES` carries the time it takes effect, such as `FI@2026-11-12T08:00:00Z`. A call is kept, billed or given tools only if its language's time is at or before the earliest start time stated for it, by the start message, the tool call, the report or Vapi's record. An entry without a valid time, including the old bare `FI`, approves nothing. **The one way around this is a time set earlier than the deploy that applies it,** so the time must never be earlier than that deploy. A language re-approved with a later time also stops covering calls made between the two times.
- **Rare double failures:** if the hang-up fails after a limit refusal and the write changing the record to "running" also fails, the call stays unbilled although it ran. A notice refusal that can't be remembered is still hung up, and the call's own record then decides. A concurrent "running" write can overwrite a "notice", which only sends the call back through the evidence rule.
- **A refused row closed by reconciliation** keeps its fields and status. It needs a race to exist, and counts for nothing.
- **Reconciliation's cursor** moves past an assistant that ran out of time, so its remaining calls wait for the next scheduled run, and could pass the 24-hour window under sustained overload.

## Behaviour to plan for

### Redis outage

- **Start:** the webhook answers 503 and Vapi retries. **The call continues during this,** with no slot and no limit check.
- **Tools:** refused with `limits_unavailable`. The call isn't ended, so a caller keeps talking to an assistant that can't act.
- **Report:** answers 503 and Vapi retries. Whatever is still lost goes to reconciliation, which skips any call it can't read state for.
- **Vapi's API failing rather than Redis:** a new call is hung up, because its start can't be checked. **So a Vapi read failure ends good calls.** This is a deliberate fail-closed choice, and the owner may want to weigh it after real-call results.
- **During an outage, the number of calls is limited only by Vapi's own lines,** at up to 15 minutes each. Once Redis returns, these calls are kept only with evidence from their own record, and billed if kept.
- **Redis failing only on writes:** a limit refusal that can't be remembered isn't carried out. The webhook answers 503 and the retry decides. A notice refusal hangs up regardless.

### Maximum call overshoot

- **Normal operation:** a call admitted just below the cap can run past it, by **up to 15 minutes**. Other live calls already count as their full 15 minutes.
- **Refused call whose hang-up fails:** can run up to 15 minutes and gets no tools. It's billed if its notice is confirmed, because it really ran.
- **Late start with no evidence yet:** runs under the limits with a slot, and is kept and billed only if its record later shows the notice.
- **Redis outage:** as above, not bounded by the cap.
- **Removing the overshoot** needs Vapi's `assistant-request`. That makes every call depend on Syveka answering within 7.5 seconds, so it's left for later.

Billable usage (`UsageRecord`) and uncertain usage (unsettled calls) stay separate. Uncertain minutes count against limits and never reach a bill.

### Recording

**#410 adds an explicit setting,** which needs [confirming](#decisions). It isn't in #408.

- **New assistants:** recording is off. So is a Vapi assistant re-created after deactivation, because Vapi's own default records and there's no dashboard setting left to keep.
- **Assistants made before #410:** the migration gives them `NULL`. Their page shows "not set here", a sync sends no recording field, and their Vapi dashboard choice stands until the owner picks on or off.
- **Once chosen:** it's sent as `artifactPlan.recordingEnabled` on every sync, so a dashboard edit doesn't last. The audit log records the change before the sync. If the sync fails, a `voice_assistant.sync_failed` row says Vapi may hold the old setting, and the person saving sees an error.
- **The notice is unchanged.** It says calls "may be recorded" either way. Wording for recording off needs legal approval in each language.

**Established with mocks only.** Still to check with Vapi itself:

- Whether a real PATCH of `artifactPlan` replaces Vapi's other `artifactPlan` fields.
- Whether `artifact.messages`, which the notice evidence relies on, is still filled in with recording off. **This must hold before recording off is used.**
- Whether a PATCH leaves an omitted `artifactPlan` unchanged, for `NULL` assistants.
- How long Vapi keeps recordings and transcripts, and what happens to the copy of a call Syveka refused.

**The guard patch is applied.** [`recording-guard.patch`](recording-guard.patch) adds the migration to the two protected guard scripts. The owner applied it on 2026-11-06, and CI's migration and generator checks pass at `af1c7f9c`. The preflight contract `prisma/sql/006_legacy_baseline_preflight.sql` was edited by hand, and the generator test checks it.

**Release and recovery for #410:**

- **Backup path: Option A (PITR) only, for production.** Options B and B-M in the [release runbook](../release-runbook.md) exclude a column addition. PITR being enabled is unconfirmed, and it's for the owner to check.
- **Restore test: required by Option A,** because the schema changes. The drill stopped on #410's second pending migration while its unit tests passed. It now reads `scripts/recovery-drill/expected-pending-migrations.txt`, and a test fails if a migration lands without being listed. The list claims what production's history holds, which hasn't been checked against production.
- **Evidence:** the synthetic rehearsal failed at step A1 on `ff6f93b8`, and passed all 43 steps at `a9d3e299`. It uses local containers. A drill against a real Supabase project hasn't been run, and neither has `s7`'s real `prisma migrate deploy`.
- **Next maintenance:** once production has applied the listed migrations and the list is emptied, the `s7` deploy tests need a synthetic list. They fail loudly until then.

## Prerequisites

| Prerequisite           | Why                                                                                                                                                                                                                | If skipped                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Enterprise grants**  | `ENTERPRISE.voiceMinutesMonth` becomes 0. Each contract's minutes come from a `VOICE_MINUTES_MONTH` grant                                                                                                          | That organization's calls are refused from deployment             |
| **Approved languages** | `VOICE_DISCLOSURE_APPROVED_LANGUAGES` is empty by default. A language goes in, as `LANG@time`, only after counsel and a native speaker approve its wording. The time is no earlier than the deploy that applies it | Every call in an unlisted language is hung up                     |
| **Assistant sync**     | Saving an assistant sends the notice, live-call control and webhook retries                                                                                                                                        | Its calls are refused, and its settings page says so              |
| **QStash schedule**    | `reconcile-voice-calls` runs only from a manually registered schedule, suggested every 15 minutes                                                                                                                  | A call with lost webhooks stays uncertain and nothing recovers it |

The concurrent-call limits of 1 (Starter) and 3 (Pro) are built, and await [confirmation](#decisions). They are technical safeguards, not commercial promises. Any organization with minutes gets at least 1, and a contract concurrency grant would need a migration.

## Rollout

Each step needs its own authorization.

### Staging validation

Staging proves the mechanics on one environment. It doesn't make production ready.

1. Merge as in [Integration candidate #415](#integration-candidate-415). The migration runs on staging through `staging-release.yml`, against the staging database only.
2. Deploy to staging with `VOICE_DISCLOSURE_APPROVED_LANGUAGES` empty, so no call can continue yet.
3. Create Enterprise grants on staging, if any organization needs them.
4. Register the QStash schedule on staging.
5. Save each staging assistant. This is a live Vapi write. Its settings page should stop reporting out-of-date settings.
6. Set approved languages on staging to the language under test, as `LANG@time` with a time no earlier than this redeploy. Use wording approved for testing.
7. Run the [staging trial](#staging-trial) below. It costs money and needs its own approval.

**Staging passes when:** every real-call check has a recorded result, and any wrong assumption has been fixed through a reviewed change.

### Production readiness

All of these are needed, and staging results alone don't satisfy them:

- Staging passed on the same commit.
- If #410 is included: PITR confirmed under Option A, and a restore test at the release commit.
- Counsel and a native speaker approved the wording for each language to be enabled, and the owner decided on recording and objections.
- Production Enterprise organizations are identified and their grants ready.
- The owner confirmed the concurrency safeguards.
- Prices and allowances stay unpublished unless separately decided.

### Production release

1. Create Enterprise grants.
2. Deploy, with approved languages empty. **This stops all calls** until step 5, so choose the time.
3. Register the QStash schedule.
4. Save each assistant, and confirm its settings page.
5. Set approved languages, as `LANG@time` with a time no earlier than this deploy.
6. Place one approved call in each enabled language, then check the row, the usage and the absence of tools on a refused call.

## Rollback

In this order:

1. **To stop calls at once:** empty `VOICE_DISCLOSURE_APPROVED_LANGUAGES`. Every call is then hung up.
2. Remove the QStash schedule, because its job goes away with the code.
3. Revert and deploy. #408 has no migration. If #410 was released, use `vercel rollback <recorded deployment>`. Its column stays: it's nullable and old code ignores it. The runbook lists what to check in Vapi, because code before #408 sends an undocumented `recordingEnabled: true`, whose effect is unverified.
4. Save assistants again on the reverted code, so Vapi holds what that code expects. The notice in `firstMessage` is harmless until then.
5. Leave Enterprise grants, or revoke them if they're no longer wanted.

Slots expire within 20 minutes, and markers and refusals within 48 hours. Old code ignores them. Usage dated from a call's start stays as written. Without #410, recording stays as set in Vapi's dashboard. With #410, what it last sent stays in Vapi until changed there.

## CI

**`CI required` is now a required check.** Ruleset `Main Branch Protection` requires it, as well as a pull request, and blocks deletion and force-pushes. It requires no approvals and has no bypass actors. It applies to every PR to `main`.

- **Applied 2026-11-06,** under the owner's authorization of 2026-11-05, after the real jobs passed. The other rules and settings compare as unchanged.
- **To undo:** `gh api -X PUT repos/syveka/syveka-ai/rulesets/18750656 --input docs/voice/ruleset-before.json`.

**The real suites run in GitHub Actions,** from [`ci-real-db-gate.patch`](ci-real-db-gate.patch), applied by the owner.

| Head            | Run                                                                         | Real Redis                   | Real PostgreSQL              |
| --------------- | --------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| #408 `ce55d110` | [42200201406](https://github.com/syveka/syveka-ai/actions/runs/42200201406) | 29 of 29, 2 files, 0 skipped | 11 of 11, 3 files, 0 skipped |
| #411 `a35094c2` | [42200217342](https://github.com/syveka/syveka-ai/actions/runs/42200217342) | 29 of 29, 2 files, 0 skipped | 11 of 11, 3 files, 0 skipped |
| #410 `af1c7f9c` | [42200229830](https://github.com/syveka/syveka-ai/actions/runs/42200229830) | 29 of 29, 2 files, 0 skipped | 11 of 11, 3 files, 0 skipped |

**Controls, each failing `CI required`.** These draft PRs are for evidence only and must not be merged:

| PR                                                                        | Change                            | Failure in the log                                             |
| ------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| #412, [run](https://github.com/syveka/syveka-ai/actions/runs/42200744418) | A Redis image that doesn't exist  | Service pull fails: `redis:0-does-not-exist: not found`        |
| #413, [run](https://github.com/syveka/syveka-ai/actions/runs/42200749771) | `describe.skip` on a Redis suite  | 19 of 29 passed, 10 skipped, 0 failed, and the job still fails |
| #414, [run](https://github.com/syveka/syveka-ai/actions/runs/42200754198) | `voice-call-binding` file removed | 6 of 6 passed in 2 files, and the job fails on the file count  |

## Real-call validation

Nothing about Vapi has been tested on a real call. These need an approved test, using tenant-owned numbers as the owner chose. The Finnish test plan on #399 is the base.

1. **Start:** does `GET /call/{id}` answer, with a status other than ended, by the time `in-progress` arrives? If it lags, the check hangs up good calls. This is the highest risk in this release.
2. **Spoken record:** does `artifact.messages` hold the notice as a `bot` message in FI, EN and AR, close enough to match? Is it split across entries? Are `secondsFromStart` and `assistantId` set as the schema says? No real payload has been checked, and a mismatch would refuse missed-start calls.
3. **Tool calls:** do they carry `artifact.messages` and `call.createdAt` or `startedAt`? If not, a missed start can't recover and its tools end the call.
4. **Reports:** are `startedAt`, `endedAt` and `artifact.messages` present? How soon does `GET /call/{id}` have them?
5. **Retries:** does `server.backoffPlan` retry a 503 on each message type, and how often?
6. **Hang-up:** does Live Call Control end a call, with `monitorPlan` as sent?
7. **Recording:** the three questions under Recording.
8. **Metering:** do real durations and costs match? Run a refused call too, and confirm no row or usage appears.

## Staging trial

For approval after merging and deploying to staging. **Nothing here has run.** Every call uses the tenant-owned staging number, and nothing runs in production. Results go on #399.

### Scenarios

| #   | Scenario                                                                              | How                  | Expected                                                                                                               | Needs a real call?            |
| --- | ------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| T1  | Normal: FI, approved, books a meeting                                                 | Call, 3 minutes      | Kept: row, usage, transcript, booking, Finnish summary                                                                 | Yes                           |
| T2  | Normal: EN, approved                                                                  | Call, 2 minutes      | Kept                                                                                                                   | Yes                           |
| T3  | Normal: AR, only if test wording is approved                                          | Call, 2 minutes      | Kept, notice matched in Arabic, Arabic summary. The only way to judge a real Arabic summary                            | Yes                           |
| T4  | Refused: EN while EN isn't listed                                                     | Call, 1 minute       | Hung up within seconds. No row, usage or tools                                                                         | Yes                           |
| T5  | Late approval: list EN with a time after T4, redeploy, run reconciliation             | No call              | T4 still isn't kept                                                                                                    | No                            |
| T6  | Limits: two calls at once on a Starter test organization                              | Two calls, 2 minutes | The second is hung up                                                                                                  | Yes                           |
| T7  | Recording off, on a new assistant                                                     | Call, 2 minutes      | No recording at Vapi, `artifact.messages` still present, other `artifactPlan` fields kept                              | Yes                           |
| T8  | Recording never set, on an older assistant                                            | Call, 2 minutes      | Dashboard setting unchanged after a save                                                                               | Yes                           |
| T9  | Repeats: run reconciliation again, and resend T1's post-call job                      | No call              | One usage row for T1, one activity, one notification                                                                   | No                            |
| T10 | Provider failure during a save: needs a bad Vapi key on staging, so a settings change | No call              | The form says saved but not sent, and the audit log has both rows                                                      | No, but separately authorized |
| T11 | Long provider outage                                                                  | Not run on staging   | Proven only by tests with mocks. Vapi's retries, and whether it enforces the maximum length in an outage, stay unknown | Can't be staged               |

**Only a real call can show:** whether Vapi's record answers at call start, the shape of `artifact.messages` and the notice match, tool-call payloads, Live Call Control's hang-up, whether recording off really stops audio and what Vapi keeps, real costs and durations, and the quality of an Arabic summary. See [Real-call validation](#real-call-validation).

**Passes when** every run scenario has a recorded result that matches, and billed minutes match Vapi's durations. **Fails when** a refused call leaves a row or usage, a call runs past 5 minutes when it should be hung up, a good call is hung up, usage repeats, or recording stays on after T7. Fix any failure through a reviewed change before continuing.

**To roll back on staging:** empty `VOICE_DISCLOSURE_APPROVED_LANGUAGES`, which hangs up every call. Remove the QStash schedule. Run `vercel rollback` to the recorded staging deployment. Leave the column in place.

### Maximum cost

- **Planned:** 7 calls and about 14 minutes. **These are estimates, not measurements.** At the estimate of $0.0776 a minute in [`unit-economics.md`](unit-economics.md), about **$1.10**. At a cautious $0.30 a minute, **$4.20**.
- **Worst case:** each of the nine call legs runs to the 15-minute cap (`maxDurationSeconds` 900): 135 minutes, at $0.30 a minute, **$40.50, about €37**. The Starter test organization's own limit of 100 minutes a month, plus up to 15 minutes of overshoot, also bounds it.
- **Not included:** Twilio's charges on the tenant-owned number, per minute and per month, which weren't checked here, and the caller's own phone charges.
- **Stop rule:** end the trial if Vapi's dashboard shows more than **$45** spent that day, or any call runs past 5 minutes when it should have been hung up.

### What the owner provides

- Approval of the merges and of the staging deploy, which runs the migration on the staging database.
- Test wording approved for FI and EN, and for AR if T3 runs.
- On staging: `VOICE_DISCLOSURE_APPROVED_LANGUAGES` with times, the QStash schedule, and any Enterprise grants.
- Saving each staging assistant, which is a live Vapi write.
- The tenant-owned number on the staging assistant, and two phones for T6.
- Approval of the paid calls, within the budget above.
- Someone to review the Arabic wording, and each readiness state at narrow width and in dark mode.

## Owner steps

**Done on 2026-11-06.** The owner ran the reviewed script, which applied the CI patch to #408, merged it into #411 and #410, and applied the guard patch to #410. Claude then opened the control PRs, checked the runs and required the check.

Nothing else here needs an owner command. The next steps are the decisions below.

## Decisions

Authorized directly by the owner: the CI patch and making `CI required` a required check, on 2026-11-05. Done 2026-11-06.

Everything below is **pending**. Another session's documents recorded 1, 2 and 3 as decided, but the owner hasn't confirmed them in the main session.

| #   | Decision                               | What the code does now                                                                                                                                                                                                                                              | Recommendation, and why                                                                                                       | If yes / if no                                                                                                          | Blocks                                                 |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Recording, new and existing assistants | New: off. Existing: Vapi's setting stands until someone chooses                                                                                                                                                                                                     | Confirm. It records nothing by default and changes nothing silently                                                           | Yes: #410 goes in. No: rebuild the candidate without #410                                                               | Trial as built, and production                         |
| 2   | Late approval of a language            | Refused: a language must be approved when the call began                                                                                                                                                                                                            | Confirm. A later approval can't show what a caller heard                                                                      | Yes: no change. No: code change and legal review                                                                        | Production. The trial tests it as built                |
| 3   | Concurrent calls: Starter 1, Pro 3     | Enforced, and any organization with minutes gets at least 1                                                                                                                                                                                                         | Confirm for testing, and review with real use                                                                                 | Yes: no change. No: one constant each                                                                                   | Trial, because T6 tests it                             |
| 4   | Unconfirmed calls in a long outage     | Count 15 minutes each for 48 hours, then log only. Known minutes keep counting. A failed Redis read lets a call run with no slot and no row, and tools refused. A slot lasts 20 minutes against a 15-minute call, so it can't lapse while Vapi enforces the maximum | Keep for the trial. Before production, choose a refuse threshold, and whether a Redis failure should hang up                  | Risk: about one cap per 48 hours, and up to 15 minutes per call in a Redis outage, limited only by Vapi's account limit | Production                                             |
| 5   | What Vapi keeps of refused calls       | Syveka keeps nothing for them. Vapi's copy isn't touched, and retention is unknown                                                                                                                                                                                  | Have counsel decide, using what T4 and T7 show. Add deletion only if required                                                 | Deletion would be new work                                                                                              | Production. Trial callers should be testers who agreed |
| 6   | Enterprise caps and prices             | Enterprise voice is 0 minutes without a contract grant. Prices are unchanged                                                                                                                                                                                        | Change no price before measuring (`docs/research/voice-economics-decision.md` on #402, its option A). Set grants per contract | Yes: no change. Prices can't be judged from estimates                                                                   | Production                                             |
| 7   | Notice wording for testing             | `VOICE_DISCLOSURE_APPROVED_LANGUAGES` is empty, so every call is refused                                                                                                                                                                                            | Approve FI and EN test wording. AR only after native review, including the new sync message and instruction                   | Without it, only refusals can be tested                                                                                 | Trial                                                  |

**How the usage query informs 6.** `docs/research/usage-aggregate-query.sql` on #402 hasn't been run, and no production figure exists. By measured cost of a chat reply: below about $0.015, keep things as they are. From about $0.015 to $0.035, look at allowance use. Above about $0.035, options F, then B or C on #402. A small or internal sample supports no pricing conclusion. It measures AI usage, not call costs, which T1 to T8 start to measure.

**Unverified, because this environment has no authorized access. An owner can check these:**

- **PITR:** Supabase dashboard, production project, Database, then Backups. Point in Time must be enabled, with a window covering the release. Required for #410's production release, not for staging.
- **`authenticated` on `voice_assistants`:** run this read-only query in the SQL Editor. If it returns UPDATE, a Member could change `recording_enabled` without audit through PostgREST, because that policy isn't role-gated, and that must be fixed before production.

```sql
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'voice_assistants' and grantee in ('anon', 'authenticated');
```

**Needing later authorization, each separately:** merging, the staging deploy and its migration, staging environment values, the QStash schedule, saving assistants (a live Vapi write), T10's settings change, paid calls, any production step, and legal wording.

## Handoff

- **Where work is:** branch `integration/voice-staging-2026-11-06`, PR #415, at `aea51796`. This plan is the single status document.
- **Controls:** #412, #413 and #414 stay open as evidence for the CI gate. Don't merge them.
- **Windows:** `handler-guard-coverage` (11) fails on `main` too, and #398 fixes it. `recovery-drill-scripts` (1) passes alone and fails only under a full run's load, and #398 extends its timeout. #398 isn't in the candidate.
- **Local only:** nothing built locally, because dependencies are on an exFAT drive. CI's production build is the evidence. E2E needs a running app with credentials, and hasn't run.
