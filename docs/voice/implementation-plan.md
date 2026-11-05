# Voice metering, limits and disclosure: implementation plan

Written for the owner and reviewers, 2026-11-05, against `origin/main` at `40f71ae7`. It follows the
owner's decisions of the same day. **Everything stops before merge, deployment, purchases, paid calls and
production configuration.**

## What the audit changed

| Finding                                                                                                                                                                                                                                                                                  | Effect on the plan                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Possible under-billing.** The webhook bills from `message.durationSeconds ?? 0`, a field absent from Vapi's published `end-of-call-report` schema, which documents `startedAt` and `endedAt`. Post-call rounds 0 up to 1 minute. If Vapi omits the field, every call bills as 1 minute | Duration comes from the documented times. Missing duration is uncertain, never "1 minute"  |
| Vapi doesn't retry webhooks unless `server.backoffPlan` is set, and it isn't                                                                                                                                                                                                             | Set it, then recover anything still lost                                                   |
| Usage is dated when it's recorded, so a late report moves minutes into the next month                                                                                                                                                                                                    | Date usage from the call's start                                                           |
| Quota checks read and then act, so parallel calls all pass. A database or Redis error leaves the call running                                                                                                                                                                            | Atomic slots, checked in a fixed order, failing closed                                     |
| `.github/` and `scripts/check-migration-history.mjs` are protected, and the guard blocked the approved CI edit                                                                                                                                                                           | The CI patch waits for the owner (below). Everything else is designed to need no migration |
| The `opt-in-postgres` CI job isn't in `CI required`'s list                                                                                                                                                                                                                               | The new job must be. The Postgres gap is flagged for the owner                             |

## Work packages

| PR  | Branch                           | Scope                                                                      | Depends on                      | Migration |
| --- | -------------------------------- | -------------------------------------------------------------------------- | ------------------------------- | --------- |
| A   | `fix/voice-metering-reliability` | Duration, webhook retries, reconciliation, billable versus uncertain usage | None                            | No        |
| B   | `fix/voice-concurrency-caps`     | Atomic per-tenant slots, hard caps, fail closed, Enterprise default        | A (stacked)                     | No        |
| C   | `fix/voice-enforced-disclosure`  | Notice spoken first, checked on live config before a call may continue     | None. Replaces #335 if accepted | No        |
| D   | `fix/post-call-text-block`       | Read AI replies by block type, and mock-only Haiku 5.5 tests               | None                            | No        |
| E   | Owner applies the CI patch       | Real-Redis job in CI                                                       | Owner action                    | No        |
| F   | This PR                          | This plan, and unit economics                                              | None                            | No        |

## Acceptance criteria

### A: Metering

- Duration uses documented `startedAt` and `endedAt`, falling back to `durationSeconds` only if those are absent. Negative, unparsable or impossible values are refused.
- A call with no trustworthy duration records **no** usage, and the job leaves it unprocessed, so it can't look billed or settled.
- A replay or retry never charges twice, including the webhook racing the reconciliation job.
- Usage is dated from the call's start, so a late report lands in the correct month.
- Reconciliation finds calls still in progress past the 15-minute cap, ended calls with no duration, and processed-never calls. It also finds calls Syveka never saw, by asking Vapi per assistant.
- A Vapi call whose assistant doesn't match the Syveka row is never applied. Vapi being down changes nothing, and the next run retries.
- "Billable" (`UsageRecord`) and "uncertain" (unsettled calls) are separate queries. Uncertain minutes never reach a bill.

### B: Limits

- Under concurrent requests, exactly the allowed number of slots is granted. Proven on real Redis.
- One tenant at its limit can't affect another's slots.
- A hard cap counts billable + uncertain + other calls in flight, so parallel calls can't overshoot together. The most any tenant can overshoot is one call's remaining time.
- Remaining minutes never go negative.
- If limits can't be checked, the call is ended, and write tools are refused.
- A crash can't leak a slot permanently: slots expire.
- Enterprise has no unlimited voice. Without a contract grant it has 0 minutes.

### C: Disclosure

- Vapi always receives the fixed notice first in `firstMessage`, spoken in full, in the assistant's language.
- The live Vapi config is verified at call start. Anything else, including a dashboard edit, an old assistant or a failed check, ends the call and refuses write tools.
- A call can't proceed until its language's wording is approved, through `VOICE_DISCLOSURE_APPROVED_LANGUAGES`. No language is approved by default, so assistants can still be configured, but their calls end. A clear message in the assistant settings is a follow-up, since it needs FI, EN and AR text.
- No recording or objection behaviour changes, since those are legal decisions.

### D: AI replies

- A thinking block before the text no longer loses a summary.
- Mock tests pin how a Haiku 5.5 reply is handled and that Syveka sends no `temperature`. **No model is changed.**

## Enterprise caps: design

- **Minutes:** `ENTERPRISE.voiceMinutesMonth` becomes `0`. Each contract's minutes are added through the existing `VOICE_MINUTES_MONTH` grant, which needs no migration and is audited.
- **Concurrency:** a new `voiceConcurrentCalls` plan limit. A contract grant needs a new `VOICE_CONCURRENT_CALLS` metric, which **needs a migration**, so it's blocked with E. Until then Enterprise gets a technical floor of 1 call.
- **Starter and Pro:** 1 and 3 calls are technical safeguards chosen to bound risk, not commercial promises. The owner should confirm them before any launch.

No final commercial allowance is set anywhere.

## Why no migration is needed

| Need                 | Approach                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Uncertain usage      | Derived from `VoiceCall`: `postCallProcessedAt` null. No new state to drift                              |
| Duplicate protection | The existing per-call advisory lock and check, proven by the Postgres suite                              |
| Which notice is live | Read from Vapi's own config at call start, which also catches dashboard edits. A stored version wouldn't |
| Concurrent calls     | Redis sorted set, with expiring members                                                                  |

A partial unique index on usage per call would be stronger protection against duplicates. It needs the protected migration script, so it's listed as a follow-up.

## Owner action: the CI patch (E)

The approved edit is blocked by the protection hook, as the charter intends. **Smallest action:** start a session with `SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1`, or apply this directly.

In `.github/workflows/ci.yml`, add this job before `baseline-migration-repro`, and add `- opt-in-redis` to the `needs` list of `CI required`:

```yaml
opt-in-redis:
  name: Opt-in real-Redis suites (voice replay, call slots)
  runs-on: ubuntu-latest
  needs: [prisma-generate]
  services:
    redis:
      image: redis:7-alpine
      ports: ["6390:6379"]
      options: >-
        --health-cmd "redis-cli ping" --health-interval 5s
        --health-timeout 5s --health-retries 10
  steps:
    - name: Checkout
      uses: actions/checkout@v4
    - name: Setup Node
      uses: actions/setup-node@v4
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: npm
    - name: Install dependencies
      run: npm ci
    - name: Generate Prisma client
      run: npx prisma generate
    - name: Run the suites (they must run, not skip)
      env:
        VOICE_REDIS_TEST_URL: redis://127.0.0.1:6390
      run: |
        npx vitest run tests/unit/voice-conversation-redis.test.ts tests/unit/voice-call-slots-redis.test.ts --reporter=default --reporter=json --outputFile=opt-in-redis.json
        node -e '
          const r = require("./opt-in-redis.json");
          console.log(JSON.stringify({ total: r.numTotalTests, passed: r.numPassedTests, skipped: r.numPendingTests, failed: r.numFailedTests }));
          if (r.numTotalTests === 0 || r.numPassedTests !== r.numTotalTests) process.exit(1);
        '
```

`tests/unit/voice-call-slots-redis.test.ts` arrives with PR B. Until that merges, leave it out, or vitest fails on the missing file. You approved running this for voice, metering and billing changes. I'd run it on every PR, since the job takes about a minute and path filters on a required job add risk.

While there, decide whether `opt-in-postgres` should join `CI required` too. Today it can fail without blocking a merge.

## Rollout and rollback

Nothing below has been done. Each step needs its own authorization.

| Step | Action                                                                                                                                                      | Rollback                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | Merge D. No behaviour change on the current model                                                                                                           | Revert                                                                                      |
| 2    | Merge A, deploy to staging. Register a QStash schedule for `reconcile-voice-calls` every 15 minutes (a manual step, as for `reconcile-creator-generations`) | Remove the schedule, revert. No data migration                                              |
| 3    | Re-sync staging assistants, so `backoffPlan` applies. Live Vapi writes, separately authorized                                                               | Re-sync after revert                                                                        |
| 4    | Check for Enterprise organizations. Create their grants **before** B deploys, or their voice stops                                                          | Revoke grants                                                                               |
| 5    | Merge B, deploy to staging, and test limits on mocks plus real Redis                                                                                        | Revert. Slots expire by themselves within 20 minutes                                        |
| 6    | Legal and native-speaker approval of wording. Then merge C with approved languages set                                                                      | Revert. Until re-synced, old assistants' calls are ended, so plan this together with step 7 |
| 7    | Re-sync assistants on staging, and run the separately approved call test                                                                                    | Revert, re-sync                                                                             |
| 8    | Production, as its own release. Only after all the above, and with its own approval                                                                         | Revert, re-sync                                                                             |

## Risks

- **No real call has validated any of this.** All Vapi behaviour comes from its published schema. The call test's Phase 0 must confirm payload shapes, especially duration, before anyone relies on them.
- **Failing closed can end real calls** during a Redis or database outage. This follows the owner's direction, and an operator should know it's the trade-off.
- **Retries can arrive after Vapi has given up on a tool call.** A retried tool call returns `duplicate_tool_call`, and doesn't run twice, but the assistant may need to recover.
- **Overshoot remains possible, by up to one call:** a call that starts below the cap can run past it, up to the 15-minute limit. Removing this needs Vapi's `assistant-request`, a larger change that makes calls depend on Syveka's webhook within 7.5 seconds. It's proposed for later.
- **BYO SIP stays broken.** Tenant-owned numbers through Twilio work in code, and that's the pilot route you chose. Fixing BYO SIP is separate.

## Unresolved decisions

1. Apply the CI patch (E).
2. Lift the migration guard for the contract concurrency metric, and optionally the unique usage index.
3. Confirm the safeguard limits of 1 and 3 concurrent calls.
4. Legal: notice wording, recording, objection handling.
5. Whether any Enterprise organizations exist today (rollout step 4).
6. Pricing, after reviewing `unit-economics.md`.
