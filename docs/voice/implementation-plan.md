# Voice metering, limits and disclosure: release plan

Written for the owner and reviewers. It describes draft PR #408 at `a3f85a74`, against `origin/main` at `40f71ae7`. **Nothing here has been merged, deployed, or tried on a real call.** Merging, deploying, paid calls, live Vapi writes, approved-language activation, schedules and production settings each need separate authorization. Prices and commercial allowances stay pending owner decisions.

## What releases

**#408 is the release candidate.** It holds the metering, limits and notice work together, because reconciliation has to honour both limits and the notice, and those changes conflict when kept apart.

| PR               | Role for release                                                      | Why                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #408             | **Release this**                                                      | Contains every commit below                                                                                                                                           |
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

`f71829a2` came from #335 and forced recording on. `fae79e05` removes that part and keeps the spoken notice.

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
- **A language approved within 36 hours of a missed-start call** that shows the notice means that call is kept. See decision 3.
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

Syveka has no recording setting in its database, settings page or validators. The only one is Vapi's own.

**What this change establishes, using mocks:** Syveka no longer sends `artifactPlan` or `recordingEnabled`, so a setting of off in Vapi's dashboard isn't overridden, including on repeated sync against a fake that merges PATCHes. The spoken notice doesn't depend on recording.

**What still needs checking with Vapi itself:**

- Whether a real PATCH leaves an omitted `artifactPlan` unchanged.
- Whether a new assistant records by default. The schema says `recordingEnabled` defaults to on.
- How long Vapi keeps recordings and transcripts, and what happens to the copy of a call Syveka refused.

The notice says calls "may be recorded" whichever way that setting is.

**Smallest proposal, not applied, for the owner's decision:** add `VoiceAssistant.recordingEnabled`, defaulting to off. It would be a migration through the protected script, a switch in the settings form with FI, EN and AR text, and an explicit `artifactPlan.recordingEnabled` on every sync. The notice would drop its recording clause when off, and that wording needs legal approval in each language.

## Prerequisites

| Prerequisite           | Why                                                                                                                                       | If skipped                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Enterprise grants**  | `ENTERPRISE.voiceMinutesMonth` becomes 0. Each contract's minutes come from a `VOICE_MINUTES_MONTH` grant                                 | That organization's calls are refused from deployment             |
| **Approved languages** | `VOICE_DISCLOSURE_APPROVED_LANGUAGES` is empty by default. A language goes in only after counsel and a native speaker approve its wording | Every call in an unlisted language is hung up                     |
| **Assistant sync**     | Saving an assistant sends the notice, live-call control and webhook retries                                                               | Its calls are refused, and its settings page says so              |
| **QStash schedule**    | `reconcile-voice-calls` runs only from a manually registered schedule, suggested every 15 minutes                                         | A call with lost webhooks stays uncertain and nothing recovers it |

The concurrent-call limits of 1 (Starter) and 3 (Pro) are technical safeguards, not commercial promises. Any organization with minutes gets at least 1, and a contract concurrency grant would need a migration.

## Rollout

Each step needs its own authorization.

### Staging validation

Staging proves the mechanics on one environment. It doesn't make production ready.

1. Apply the CI patch, or decide not to (below).
2. Merge #408 and #407, resolving the test conflict. Deploy to staging with `VOICE_DISCLOSURE_APPROVED_LANGUAGES` empty, so no call can continue yet.
3. Create Enterprise grants on staging, if any organization needs them.
4. Register the QStash schedule on staging.
5. Save each staging assistant. This is a live Vapi write. Its settings page should stop reporting out-of-date settings.
6. Set approved languages on staging to the language under test. Use wording approved for testing.
7. Run the separately approved real-call checks (below). They cost money and need approval.

**Staging passes when:** every real-call check has a recorded result, and any wrong assumption has been fixed through a reviewed change.

### Production readiness

All of these are needed, and staging results alone don't satisfy them:

- Staging passed on the same commit.
- Counsel and a native speaker approved the wording for each language to be enabled, and the owner decided on recording and objections.
- Production Enterprise organizations are identified and their grants ready.
- The owner confirmed the concurrency safeguards.
- Prices and allowances stay unpublished unless separately decided.

### Production release

1. Create Enterprise grants.
2. Deploy, with approved languages empty. **This stops all calls** until step 5, so choose the time.
3. Register the QStash schedule.
4. Save each assistant, and confirm its settings page.
5. Set approved languages.
6. Place one approved call in each enabled language, then check the row, the usage and the absence of tools on a refused call.

## Rollback

In this order:

1. **To stop calls at once:** empty `VOICE_DISCLOSURE_APPROVED_LANGUAGES`. Every call is then hung up.
2. Remove the QStash schedule, because its job goes away with the code.
3. Revert and deploy. There's no migration to undo.
4. Save assistants again on the reverted code, so Vapi holds what that code expects. The notice in `firstMessage` is harmless until then.
5. Leave Enterprise grants, or revoke them if they're no longer wanted.

Slots expire within 20 minutes, and markers and refusals within 48 hours. Old code ignores them. Usage dated from a call's start stays as written. Recording stays as set in Vapi's dashboard, since this release doesn't write it.

## CI

**Workflow gate versus repository rules.** These are separate, and only the first exists for this job:

- `CI required` is a job in `.github/workflows/ci.yml`. It fails unless every job it needs succeeded, so a skipped or cancelled job fails it too. Its failure path has been seen working: on #405, run 42038834522, Lint failed and `CI required` failed with it.
- Ruleset `Main Branch Protection` requires a pull request and blocks deletion and force-pushes. It lists **no required status checks and no required approvals,** and classic branch protection isn't set. So **GitHub won't block a merge even if `CI required` fails.** Requiring it is a repository setting, and an owner decision.

**Coverage today:** the real-Redis suites and `voice-call-binding.postgres` run in no CI job, and `opt-in-postgres` isn't in `CI required`.

**The patch:** [`ci-real-db-gate.patch`](ci-real-db-gate.patch) adds an `opt-in-redis` job and the binding suite to `opt-in-postgres`, puts both in `CI required`, and fails on a wrong file count, so a missing file or skipped test can't pass. The configuration guard blocks agents from editing `.github/`, so it isn't applied. It has been checked with `git apply --check` and parsed as YAML, but has **never run in GitHub Actions**. It must land with or after #408, because it names test files #408 adds.

**Owner action:** from the #408 branch, run `git apply docs/voice/ci-real-db-gate.patch` using a copy from this PR, then commit. Alternatively, start a session with `SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1`.

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

## Decisions for the owner

1. **CI:** apply the patch, and whether to require `CI required` in the ruleset.
2. **Recording:** whether calls are recorded, and whether to take the proposal above.
3. **Late approval:** whether a missed-start call within 36 hours may be kept once its language is approved later. Today it may. The alternative is storing an approval date.
4. **Legal:** notice wording in each language, objection handling, and what happens to Vapi's copy of a refused call.
5. **Limits:** confirm 1 and 3 concurrent calls.
6. **Enterprise:** which organizations need grants, and their allowances.
7. **Migrations:** lift the guard for a contract concurrency metric, a unique usage index, or the recording column.
8. **Pricing:** after reviewing [`unit-economics.md`](unit-economics.md).
