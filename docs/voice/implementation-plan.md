# Voice metering, limits and disclosure: release plan

Written for the owner and reviewers. It describes integration candidate #415 at `2a20793b`, against `origin/main` at `40f71ae7`. Updated 2026-11-06. **Nothing here has been merged, deployed, or tried on a real call.** Merging, deploying, migrating a shared database, syncing Vapi, activating a language, QStash schedules, paid calls and purchases each need separate authorization. Prices and commercial allowances stay pending owner decisions.

## Status

| Work                                               | Done                                                                                                                                                              | Still needed                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #408                                               | CI passes at `ce55d110`, including the real suites                                                                                                                | Owner's merge decision                           |
| #411                                               | CI passes at `a35094c2`, including the real suites. Independent review of its last code commit found no blocker                                                   | Owner's merge decision, after #408               |
| #410                                               | Audit, recovery drill and release path fixed. CI passes at `af1c7f9c`, with the guard patch applied                                                               | PITR and a restore test, for production |
| `CI required` as a required check                  | **Applied 2026-11-06.** Three control PRs show it fails as it should                                                                                              | Nothing                                          |
| #415 integration candidate | #408, #411, #410, #409, #407 and fixes from audits of the combination, at `2a20793b`. [CI](https://github.com/syveka/syveka-ai/actions/runs/42228487243) passes | The owner's checklist in [Decisions](#decisions) |
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
| 6     | #415 | The conflict resolution and the audits' fixes: `36c729dc`, `aea51796`, `9aaa8f18`, `9225022d`, `2a20793b`                |

**Suggested way to merge,** once decided: **#415 alone.** It contains the commits of all the others, so what merges is what CI tested if `main` hasn't moved. The required check doesn't require a branch to be up to date. GitHub will then show #408, #411, #410, #409 and #407 as merged. #404, #405 and #406 are also fully inside it. #335 isn't an ancestor: its notice commit was taken into #408 with its forced recording removed, so close it by hand as superseded. Reviewers can still read #408 and #411 for history. **Rejecting #410 means rebuilding the candidate without it.** #398 only changes tests and docs, merges cleanly with the candidate, and can follow. #402 and #403 are documents.

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

Remaining risks are in [Risks in the candidate](#risks-in-the-candidate).

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
| Tool call, with no spoken record in it                                           | Vapi's record of the running call decides as in the two rows around this one. If nothing can say: no tools, and the call is ended only if over its minutes. Its report decides |
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
- **Approval is judged at the call's start,** as [the owner authorized](#decisions). Each entry in `VOICE_DISCLOSURE_APPROVED_LANGUAGES` carries the time it takes effect, such as `FI@2026-11-12T08:00:00Z`. A call is kept, billed or given tools only if its language's time is at or before the earliest start time stated for it, by the start message, the tool call, the report or Vapi's record. An entry without a valid time, including the old bare `FI`, approves nothing. **The one way around this is a time set earlier than the deploy that applies it,** so the time must never be earlier than that deploy. A language re-approved with a later time also stops covering calls made between the two times.
- **Rare double failures:** if the hang-up fails after a limit refusal and the write changing the record to "running" also fails, the call stays unbilled although it ran. A notice refusal that can't be remembered is still hung up, and the call's own record then decides. A concurrent "running" write can overwrite a "notice", which only sends the call back through the evidence rule.
- **A refused row closed by reconciliation** keeps its fields and status. It needs a race to exist, and counts for nothing.
- **Reconciliation's cursor** moves past an assistant that ran out of time, so its remaining calls wait for the next scheduled run, and could pass the 24-hour window under sustained overload.

## Behaviour to plan for

### Redis outage

- **Start:** the webhook answers 503 and Vapi retries. **The call continues during this,** with no slot and no limit check.
- **Tools:** refused with `limits_unavailable`. The call isn't ended, so a caller keeps talking to an assistant that can't act. A later call can take the free slot beside it ([R1, R2](#risks-in-the-candidate)).
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

**#410 adds an explicit setting,** as [the owner authorized](#decisions). It isn't in #408.

- **New assistants:** recording is off. So is a Vapi assistant re-created after deactivation, because Vapi's own default records and there's no dashboard setting left to keep.
- **Assistants made before #410:** the migration gives them `NULL`. Their page shows "not set here", a sync sends no recording field, and their Vapi dashboard choice stands until the owner picks on or off.
- **Once chosen:** it's sent as `artifactPlan.recordingEnabled` on every sync, so a dashboard edit doesn't last. The audit log records the change before the sync.
- **What's asked for and what Vapi accepted are separate.** Each send records an attempt and its result in the append-only audit log, and the settings page works them out on every visit, so a failure outlives navigation, reload and a new session. It shows: accepted, may not be applied, not confirmed, being sent, unreadable, or differs from what Vapi reports. A retry button sends again. A saved setting is never shown as proof.
- **An older send can't confirm a newer setting.** If attempts with different values could have overlapped, the state is "not confirmed" until a later send, whichever order the results came in.
- **Why no new column:** a column would add a migration and require another owner patch to protected guard scripts, and it couldn't show more than the log does. Trade-off: the state depends on audit rows, and a lost row only makes the answer less sure. No schema or release requirement changes.
- **A send that dies with no result,** a full minute before a newer one, is assumed unable to land. That follows from Vapi's 20-second timeout and hasn't been tested.
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

The concurrent-call limits of 1 (Starter) and 3 (Pro) are built, and [authorized for testing only](#decisions). They are technical safeguards, not commercial promises. Any organization with minutes gets at least 1, and a contract concurrency grant would need a migration.

## Rollout

Each step needs its own authorization.

### Staging validation

Staging proves the mechanics on one environment. It doesn't make production ready. The steps are in the [staging test package](#staging-test-package).

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

1. **To stop calls at once:** press Deactivate on each assistant. Emptying `VOICE_DISCLOSURE_APPROVED_LANGUAGES` also hangs up every call, but only after a redeploy.
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

## Risks in the candidate

A review with no new blocker doesn't remove these. **Source and mocks** establish what Syveka's code does. Only a **real provider test** can show what Vapi does.

| # | Risk and scenario | Evidence | Practical impact | State | Blocks trial / production |
| --- | --- | --- | --- | --- | --- |
| R1 | **Redis read failure at call start.** Reads fail, so the start answers 503 and Vapi retries (3 retries, about 14 seconds, as configured). With Redis still down, the call runs on | `voice-disclosure-webhook`: "in a full Redis outage a call runs on". Mocks. Vapi's retries unverified | No slot, row or tools. Each such call can cost up to about $4.66 and may be recorded as set at Vapi. Nothing is kept unless its record shows the notice. Number of calls limited only by Vapi's lines | **Open, a policy choice:** Syveka could hang up instead, ending good calls in any Redis blip. See decision 4 | No, under the stop rules / **Yes** |
| R2 | **A later call exceeds the concurrency limit.** A call from R1 holds no slot. When Redis returns, a new call takes the free slot and both run | `voice-call-admission`: "a call that ran through a Redis outage". Mocks, with slots proven on real Redis | Starter can briefly hold 2 or more calls, for at most 15 minutes after an outage, adding Vapi cost and using shared lines. Limits work again for later calls | **Open,** same decision | No / **Yes** |
| R3 | **Vapi doesn't enforce 15 minutes.** Each sync sends `maxDurationSeconds` 900. [Vapi documents](https://docs.vapi.ai/assistants/assistant-hooks) it as a hard cutoff, and a [maximum of 43,200](https://docs.vapi.ai/api-reference/assistants/create) | **Fixed where code can:** the page flags a live value above 900, and the webhook logs `voice_call_over_max_duration`. Both tested with mocks. Enforcement itself is untested | After 20 minutes a slot lapses, so another call can start beside it. Billed for real length. In the extreme, a 12-hour call costs about $224 at the cautious rate | **Open until T11** | No, T11 tests it / **Yes** |
| R4 | **Tool call without `artifact.messages` after a missed start.** It used to end a possibly good call | **Fixed.** It reads Vapi's record of the call. Shown the notice: tools run. Shown something else: ended. No evidence: tools refused, call runs, and its report decides. Mocks. The old code failed these tests | A caller may talk to an assistant that can't act, for up to 15 minutes. Nothing is kept without evidence. A call whose notice failed but whose record is silent can run that long | **Fixed, real payload unverified.** T1 records what arrives | No / No, once T1 is read |
| R5 | **Failed Vapi delete.** The link was cleared, leaving an assistant nothing could reach | **Fixed.** The link stays, the page says so and offers Deactivate again, and "already gone" counts as deleted. Mocks. Vapi's handling of an attached number after a delete is unverified | While it stays failed, Vapi may answer the number. Syveka tries to hang up those calls, and keeps and bills nothing from one with no row. Each costs Vapi time, and Vapi holds its own copy. Nothing retries automatically: a person must press the button. **Accepted edge:** a good call with no row, reported after a deactivation whose delete failed, is lost and unbilled, even if the assistant is reactivated. A limit-refused call that ran on loses its bill the same way. Both fail toward keeping and billing nothing. Telling them apart needs a recorded deactivation time | **Fixed, one manual step remains** | No / No |
| R6 | **Recording sync.** See [Recording](#recording) | **Fixed,** on real PostgreSQL. Vapi's real handling is unverified | Failed and uncertain states stay visible. A send that dies with no result counts as overlapping for a minute, and not after | **Fixed.** T7, T8 check Vapi | No / No |
| R7 | **Billed though Syveka hung up.** The hang-up works, then the "ended" marker can't be written, or Redis loses the key inside 48 hours | `voice-disclosure-evidence`: "a call Syveka hung up is kept and billed". Mocks | Needs Redis to fail at that exact moment. One customer's allowance loses about 1 minute. No cash, since no overage billing exists. **Privacy:** its transcript is kept and summarized by an AI provider, for a call that was meant to keep nothing, though the notice was shown spoken | **Open:** fixing it needs a durable refusal record, so a migration | No / Decide, see 4 |
| R8 | **A refused call runs unbilled.** Limits refuse it, the "ended" marker lands, then the hang-up and the "running" write both fail | `voice-disclosure-evidence`: "a call that ran on". Mocks | Needs two failures at once. Syveka absorbs up to about $4.66 and the customer pays nothing. No tools, nothing kept | **Open,** accepted direction: it errs against Syveka | No / No |
| R9 | **Two starts at once** can leave a row for a refused call. Reconciliation closes it, but could bill it if the schedule hasn't run within 48 hours, when the refusal expires | Source. Closing is tested in `voice-metering-reliability` | About 1 minute of allowance, with the same privacy effect as R7. Doesn't arise once the schedule runs | **Open, handled by requiring the schedule** | No, the trial runs it / No, once it runs |
| R10 | **Unconfirmed calls** count as 15 minutes against limits for 48 hours, and never reach a bill | `voice-metering-reliability`. Mocks and real PostgreSQL | Long outage: a customer can be refused early, by up to one month's allowance for 48 hours. They aren't charged | **Open,** decision 4 | No / **Yes** |
| R11 | **The notice is judged from configuration or text, not audio.** A call that passes at its start isn't compared with what was then spoken | Source | If speech fails silently, the call is kept and billed with no notice heard. See [Disclosure scripts](#disclosure-scripts) | **Open.** T1 checks by ear | No / Legal |
| R12 | **What Vapi keeps of refused calls.** Syveka keeps nothing, and Vapi's retention is unknown | Source | A refused call may stay in Vapi's account, and be recorded on an assistant never set in Syveka | **Open,** decision 5 | No, testers only / **Yes** |

**Smaller:** a summary can be paid for twice on a retry and requeue, under $0.01. Usage has no unique constraint behind its advisory lock, which `post-call-concurrency` proves on real PostgreSQL. The usage query grows with stuck rows, and fails closed at an extreme count. An unfamiliar speech role silently skips a summary, and T1 shows the real roles. FI and EN follow-ups aren't pinned to a language, and activity text is in English.

## Disclosure scripts

**Draft wording for the owner's review. Nothing here is legally approved.** No language is activated, and no live assistant has been changed. The approved list stays empty until someone sets it.

**Approving wording isn't caller consent.** `VOICE_DISCLOSURE_APPROVED_LANGUAGES` records that the operator approved a language's wording. Callers are told, and never asked. Consent or objection handling would be new work, on a legal decision.

### What callers hear first

| Language | Exact text |
| --- | --- |
| FI | Puhut tekoälyavustajan kanssa, ja puhelu voidaan tallentaa. |
| EN | You are speaking with an AI assistant, and this call may be recorded. |
| AR | تتم هذه المكالمة مع مساعد يعمل بالذكاء الاصطناعي، وقد يتم تسجيلها. |

The Arabic avoids gendered address, and needs native review. **"May be recorded" is said even with recording off.** That's cautious rather than false, but it's a question for counsel.

### When it plays

- **First, every time.** Vapi speaks the notice and then the assistant's greeting as one first message, before the model runs.
- **It can't be interrupted.** `firstMessageInterruptionsEnabled` is false, and each sync restores that.
- **It follows the assistant's language,** not the caller's.

### If playback fails

| Situation | What happens |
| --- | --- |
| Assistant's configuration lacks the notice | Hung up at the start, recorded as a refusal, nothing kept |
| Language not approved when the call began | Hung up, nothing kept or billed. **A caller may hear part of the notice first,** because the check doesn't hold the audio |
| The start check can't be completed | Hung up, nothing kept |
| Speech fails, with a good configuration | **Syveka can't detect this from audio.** Vapi's record is the only signal: if it shows no notice, nothing is kept. A call that passed its start check is kept regardless (R11). What Vapi does when speech fails is unverified |
| Caller hangs up during the notice | Kept and billed if the start passed, rounded up to a minute if connected |
| Caller objects | No instruction exists. The model answers as it sees fit |

### Other fixed lines

Spoken before a refused call ends, also for review:

| Language | Exact text |
| --- | --- |
| FI | Valitettavasti tämä linja ei voi juuri nyt ottaa vastaan puheluita. Näkemiin. |
| EN | Sorry, this line can't take more calls right now. Goodbye. |
| AR | عذرًا، لا يمكن لهذا الخط استقبال مكالمات أخرى الآن. مع السلامة. |

The model's instruction, which callers don't hear directly, says the notice was given, and to repeat it if asked or if unsure the caller heard it. It's in `syncToVapi`, in the same three languages.

## Staging test package

For approval after merging. **Nothing here has run.** Synthetic data, and only numbers Syveka or its testers control.

### What's deployed

- **Candidate:** PR #415 at `2a20793b`. It contains #408 `ce55d110`, #411 `a35094c2`, #410 `af1c7f9c`, #409 `17ee85b3` and #407 `bd314642`, and through #408, #404, #405 and #406.
- **What actually runs:** the merge commit on `main`. Its tree equals the candidate's if `main` hasn't moved, and the workflow records its SHA. A later `main` means checking CI again.
- **Also shipped:** everything on `main` since staging's last full release, `19581f27` on 2026-11-01. That's 36 commits with no change under `prisma/`.
- **Target:** the Supabase project named by the GitHub variable `STAGING_SUPABASE_PROJECT_REF`, and the separate Vercel staging project. The workflow refuses a production match. Staging is the GitHub `staging` environment, which requires a reviewer's approval.

### Backup and recovery, from the actual migration

- **Migration:** one `ALTER TABLE voice_assistants ADD COLUMN recording_enabled BOOLEAN`. It's nullable with no default, changes no row, and holds its lock only briefly. The recording-sync work adds none. Comparing the repository, it should be the only migration pending on staging. The workflow's `prisma migrate status` confirms that. Nobody has read staging's history directly.
- **Before running:** the [runbook](../release-runbook.md) requires a backup or verified PITR before a migration on staging. That applies here, though the risk is low: staging holds fixtures and earlier pilot rows worth keeping. **Unverified, because this environment has no access.** See the owner's step E.
- **Restore test:** not required for staging. Undoing this needs no restore: the column can stay, because old code ignores it. Production still requires PITR and a restore test under Option A.
- **Applied once:** `prisma migrate deploy` runs only in `staging-release.yml`. Don't run it separately.

### Steps, in order

1. Owner confirms the backup, and sets on the Vercel staging project: `VAPI_*`, the `QSTASH_*` values, and `VOICE_DISCLOSURE_APPROVED_LANGUAGES` as `FI@<A>,EN@<B>`. **A** is after the deploy will finish, and **B** is 30 minutes after A. A future time is valid and approves nothing until it arrives, so one deploy covers T4 and T5, and no second release is needed. Run T4 between A and B, and T2 after B.
2. Owner runs **Staging release validation** from `main`, typing the project ref, and approves the environment. It validates, runs the read-only preflight, migrates, checks invariants, deploys, and runs its E2E smoke tests.
3. Record the deployment and SHA, for rollback.
4. Register the QStash schedule for `reconcile-voice-calls`, every 15 minutes. Remove it when the trial ends.
5. Create one Starter test organization with synthetic data, and one assistant in each language under test, with the number the owner provides. For T8, use an assistant made before the migration, if staging has one.
6. Save each assistant, which is a live Vapi write, and confirm its recording panel says Vapi accepted the setting. Testers agree beforehand that calls may be recorded.
7. Run the scenarios in order. Check the stop rules after every call.

### Scenarios

| # | Scenario | Calls, minutes | Expected | Why mocks can't show it |
| --- | --- | --- | --- | --- |
| T1 | FI, approved, books a meeting. **Listen for the notice** | 1, 3 | Heard first and in full. Row, usage, transcript, booking and a Finnish summary | Vapi's record at the start, the real shape of `artifact.messages`, tool payloads, speech quality |
| T2 | EN, after time B | 1, 2 | Kept | The same in English |
| T3 | AR, only if its wording is approved | 1, 2 | Kept, notice matched in Arabic, Arabic summary | Real Arabic transcription against the notice, and summary quality |
| T4 | EN **before** time B | 1, 1 | Hung up within seconds. No row, usage or tools | Live Call Control really ending a call, and what Vapi keeps |
| T5 | After time B, run reconciliation | None | T4 still isn't kept | Mocks show this. It's checked here on real data |
| T6 | Two calls at once, Starter | 2, 3 | The second is hung up | Real timing between two webhooks |
| T7 | Recording off, new assistant | 1, 2 | No recording at Vapi, `artifact.messages` present, other `artifactPlan` fields kept | Only Vapi shows whether audio is really off |
| T8 | Recording unknown, older assistant, if one exists | 1, 2 | Page says unknown. Dashboard setting unchanged after a save | PATCH leaving an omitted field alone |
| T9 | Reconciliation again, and T1's post-call job again | None | One usage row, one activity, one notification | Checked on real data |
| T10 | Deactivate an assistant | None | Gone from Vapi. A call to its number doesn't connect to it | What Vapi does with the number |
| T11 | One call left running to the limit | 1, 15 | Ended at 15 minutes, reason `exceeded-max-duration` or similar. Billed for what ran | Only Vapi can enforce it |

**Total: 9 calls, about 30 minutes,** or 8 calls and 28 minutes without Arabic.

**Not run on staging:** a failed Vapi save, because it needs a bad key, and a long provider or Redis outage, which needs a shared service broken. Those stay proven only by mocks.

### Containing concurrency and recording uncertainty

- **Concurrency:** one test organization on Starter, which allows 1. Calls run one at a time, except T6. Before each call, check that the Upstash dashboard shows no errors. **If Redis fails, stop placing calls,** because limits don't hold then (R1, R2).
- **Shared lines:** whether staging's Vapi key is separate from production's isn't verified. If shared, a stuck call uses a production line, so step E confirms it first.
- **Recording:** no call until the panel says Vapi accepted the setting. After T7, check in Vapi's dashboard that no recording exists before going on. Only testers call, using synthetic details. Anything Vapi kept stays there until someone deletes it, which is a separate step, listed in the record of the trial.

### Monitoring and stop rules

Watch Vapi's call log and spend after every call, Vercel's logs for `voice_call_refused`, `voice_assistant_sync_failed` and `voice_call_over_max_duration`, and Upstash's errors.

**Stop at once if:** spend reaches the [limit](#cost), any call passes 16 minutes, one that should be hung up passes 2 minutes, a good call is hung up, a refused call leaves a row or usage, usage repeats, recording exists after T7, the notice isn't heard, or Redis fails. Fix through a reviewed change before continuing. Don't retry a failed scenario more than once.

### Rollback

1. **To stop calls now:** press Deactivate on the assistant. Emptying `VOICE_DISCLOSURE_APPROVED_LANGUAGES` needs a redeploy to take effect, so it isn't the fast path. If Vapi can't be reached, remove the number from the assistant in Vapi's dashboard.
2. Remove the QStash schedule.
3. Run `vercel rollback` to the recorded staging deployment. Leave the column: it's nullable and old code ignores it.
4. Check each assistant's recording in Vapi, because code before #408 sends an undocumented `recordingEnabled: true`.

### Permissions needed

Owner or a named reviewer: merge, environment approval, Vercel staging values, QStash schedule, Vapi and Twilio dashboards, and the number. Claude can read logs and CI, and record results. It can't do the rest.

### Passes when

Every run scenario has a recorded result that matches, and billed minutes match Vapi's durations.

## Cost

**Estimates, not measurements, and not an all-inclusive quote.** None were bought or tested.

### Per minute

| Item | Estimate | Source and assumption |
| --- | --- | --- |
| Vapi hosting | $0.05 | [Vapi pricing](https://vapi.ai/pricing). Prorated per second, per [its support forum](https://support.vapi.ai/t/18904396/per-minute-cost-the-same-on-inbound-and-outbound-calls) |
| Model, Haiku 4.5 | $0.013 | $1 and $5 per million tokens, assuming 12,000 input and 200 output tokens a minute (#399). Real use is unmeasured, and [one report](https://support.vapi.ai/t/28057677/outbound-calls-pricing) shows wide swings |
| Speech to text, Deepgram | $0.0058 to $0.0092 | Third-party listings conflict, so the top is used. Not checked on Deepgram's own page today |
| Speech, Azure | $0.0054 | $15 per million characters, assuming 360 characters a minute (#399). Not rechecked today |
| Twilio, Finnish mobile number, incoming | $0.0107 | [Twilio's Finland page](https://www.twilio.com/en-us/voice/pricing/fi). **A local number's rate isn't listed.** Toll-free is $0.3558, so don't use one |
| **Total** | **about $0.088** | **$0.31 is the cautious figure:** $0.30, plus Twilio |

### This test

| Case | Minutes | Variable cost |
| --- | --- | --- |
| Planned | 30 | About **$2.65**, or **$9.32** at the cautious rate |
| Every call runs to its 15-minute cap | 135 | About **$42** at the cautious rate |
| Summaries, 9 calls | n/a | About $0.03, estimate |

### Fixed, only if not already held

| Item | Cost | Status |
| --- | --- | --- |
| Finnish mobile number on Twilio | $5 a month | **Unknown** whether staging has one. Local-number price not listed. Finland has its own regulatory requirements |
| Vapi plan | $29 a month, from `unit-economics.md` | **Unknown** which plan Syveka holds, and whether the test needs one |

### Unknown, and excluded

Testers' own phone charges. VAT. A Finnish local number's real rate. Deepgram's and Azure's current list prices. QStash and Upstash charges on staging's plan, expected to be small: the schedule sends 96 messages a day. Real tokens per minute.

### The limit

**Proposed: $50 of variable spend, and up to $34 fixed if neither is already held, so up to $84, excluding the unknowns above.**

**Enforcement is largely manual:**

| Control | What it enforces | Limit |
| --- | --- | --- |
| Assistant's maximum, 15 minutes | Length of each call, if Vapi enforces it (T11) | Technical, unverified |
| Starter's 100 minutes and 1 call | Minutes for the test organization, plus up to 15 of overshoot, while Redis works. About $36 at the cautious rate | Technical, but counts minutes rather than money |
| Calls placed only by testers | How many calls happen | Manual. Anyone who has the number can call it, so keep it private |
| Vapi or Twilio prepaid balance, with auto-reload off | May stop spending when it runs out | **Not verified.** Vapi's docs found don't say what happens at zero. Check both dashboards at step E |
| Checking spend after each call | The $50 limit | Manual |

**So $50 is a stop rule, not a hard cap,** unless step E confirms that a prepaid balance stops calls.

## Owner steps

**Done on 2026-11-06.** The owner ran the reviewed script, which applied the CI patch to #408, merged it into #411 and #410, and applied the guard patch to #410. Claude then opened the control PRs, checked the runs and required the check.

Nothing else here needs an owner command. The next steps are the decisions below.

## Decisions

### What the owner has authorized

In the owner's own message of 2026-11-06. It attributes them to 2026-11-05, and the local transcripts of that day don't hold this wording: they say recording "require[s] legal decisions" and ask to "document the required product decision". Today's message is the record relied on. **None of these approve final wording, production limits, merging, deployment or paid calls.**

| Authorized | Implementation | Match |
| --- | --- | --- |
| Recording off by default for new assistants | New rows store off. Vapi's own default is on, per [its docs](https://docs.vapi.ai/assistants/call-recording) | Yes |
| Existing explicit choices kept. Unknown legacy state shown as unknown, needing review | A stored choice is resent as it is. `NULL` stays `NULL`, sends nothing, and now shows as unknown and needing review. It used to read "not set here" | Yes, after this change. **One thing to know:** deactivating deletes the Vapi assistant and its setting, so reactivating one that was never set creates it with recording off |
| Language approval valid at call start, not retroactive | Each entry has a time, tested against the earliest time stated for the call | Yes. The only way around it is writing a time earlier than the deploy, which the rollout forbids |
| Starter 1, Pro 3, for testing only | Enforced in `plan-catalog.ts` | Yes for testing. **The constants don't know it's a test:** they'd apply in production if deployed, so production readiness still requires confirming them |

Also authorized and done: the CI patch and making `CI required` a required check, on 2026-11-05, applied 2026-11-06.

### Still the owner's

| # | Decision | What the code does now | Recommendation | If not decided | Blocks |
| --- | --- | --- | --- | --- | --- |
| 1 | Test wording, FI and EN, optionally AR | No language is approved, so every call is refused | Approve FI and EN for the test. AR after native review | Only refusals can be tested | Trial |
| 2 | Whether "may be recorded" is right with recording off | Said either way | Keep for the test, and ask counsel | n/a | Production |
| 3 | Production concurrency | 1 and 3, for testing only | Revisit with trial results | Can't release | Production |
| 4 | Redis failure, and a durable refusal record (R1, R2, R7, R10) | Call runs on, no slot and no tools | Keep for the trial. Before production, choose: hang up on Redis failure, or accept up to 15 minutes a call. Add a refuse threshold and the durable record | Can't release | Production |
| 5 | What Vapi keeps of refused calls (R12) | Syveka keeps nothing, Vapi unknown | Counsel decides, using T4 and T7 | Can't release | Production |
| 6 | Enterprise caps and prices | 0 minutes without a grant. Prices unchanged | No price change before measuring. Grants per contract | Enterprise has no voice | Production |
| 7 | Consent or objection handling (R11) | Told, not asked. No objection script | Counsel decides | Can't release | Production |

**Unverified, because this environment has no authorized access.** An owner can check each:

- **Staging backup:** Supabase dashboard, the staging project, Database, then Backups. Needed before the migration on staging.
- **Staging's Vapi account:** whether its key is separate from production's, its plan and balance, and what happens at zero. Whether a number already exists.
- **Vercel staging values:** whether `VAPI_*` and `QSTASH_*` are set.
- **Production only: PITR.** Same dashboard, on production, with a window covering the release.
- **Production only: `authenticated` on `voice_assistants`.** Run this read-only query in the SQL Editor. If it returns UPDATE, a Member could change `recording_enabled` without audit through PostgREST, because that policy isn't role-gated, and that must be fixed before production.

```sql
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'voice_assistants' and grantee in ('anon', 'authenticated');
```

**Needing later authorization, each separately:** merging, the staging deploy and its migration, staging environment values, the QStash schedule, saving assistants (a live Vapi write), paid calls, any purchase, any production step, and legal wording.

## Handoff

- **Where work is:** branch `integration/voice-staging-2026-11-06`, PR #415, at `2a20793b`. This plan is the single status document.
- **Controls:** #412, #413 and #414 stay open as evidence for the CI gate. Don't merge them.
- **Windows:** at the candidate, `npm test` has 12 to 16 failures: `handler-guard-coverage` (11), `recovery-drill-scripts` (1), and under load `voice-conversation-flow` (4). All 132 tests in those three files pass on the candidate with #398's versions of them, so they're test issues on Windows, not product ones. #398 isn't in the candidate.
- **Local only:** nothing built locally, because dependencies are on an exFAT drive. CI's production build is the evidence. E2E needs a running app with credentials, and hasn't run. The new panel has been rendered only in tests, so its look at narrow width, in dark mode and in RTL still needs a person.
