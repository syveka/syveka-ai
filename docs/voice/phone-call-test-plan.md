# Finnish +358 phone call test plan

**Status: proposed. Nothing here has been run, and no number or paid service has been set up. Every
paid step needs the owner's signature below.** It uses the existing Vapi stack and staging only.

## Purpose

Syveka has no evidence of a real phone call in the repo. This plan establishes the baseline that every
later decision needs: latency, language quality, booking, disclosure timing, usage metering and real
cost per minute.

## Cost estimate

Vendor prices read 2026-11-05. Per-minute cost is the estimate in `pricing-and-profitability.md`.

| Item                                                                            | Quantity                                      | Estimate                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Baseline calls: FI 16, AR 12, EN 4, limits 6, at 3 min                          | 114 min                                       | $10.07                                                      |
| Retries, 30%                                                                    | 34 min                                        | $3.02                                                       |
| Haiku 5.5 phase, optional: 20 calls at 3 min                                    | 60 min                                        | $4.62 at $0.0770                                            |
| Twilio Finnish mobile number                                                    | $6.60/month, 2 months for provisioning delays | $13.20                                                      |
| Vapi Core, if the account isn't already on a plan. Needed for more than 4 lines | 1 month                                       | $0–29                                                       |
| Testers' own phone charges to a Finnish mobile number                           | About 200 min                                 | Depends on their plan. Usually covered, otherwise about €10 |
| **Expected total**                                                              |                                               | **About $30–60**                                            |
| **Proposed hard limit**                                                         |                                               | **$100**                                                    |

Vapi may require prepaid credit, and Twilio an account balance, so more money may be held than is
spent. Actual cost comes from Vapi's `cost` value per call, stored as `costCents`. **Stop at $100 and
report, rather than continuing.**

## Preconditions

| #   | Requirement                                                                                                                                                                                        | Owner          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Written approval of this plan, its budget and tester list                                                                                                                                          | Owner          |
| 2   | Phase 1 only: #335's notice on staging, with counsel-reviewed wording. Phase 0 doesn't need it (see below)                                                                                         | Owner, counsel |
| 3   | A Twilio Finnish number. Twilio asks for a Trade Register extract, proof of address, Y-tunnus, a website and a representative; the address must be in Finland. A search summary reported 2–4 weeks | Owner          |
| 4   | **Use the Twilio import path, not BYO SIP.** The BYO path looks broken: it sends a SIP URI as `credentialId` (`vapi.ts:204-209`), and Vapi's schema wants a credential id                          | Engineering    |
| 5   | Vapi account's concurrency and plan confirmed. The free package allows 4 lines                                                                                                                     | Owner          |
| 6   | A dedicated staging organization with made-up Business DNA and test calendar. No customer data                                                                                                     | Engineering    |
| 7   | Testers told, in writing, that the calls are recorded and sent to the listed vendors. Testers use only invented names and details                                                                  | Owner          |
| 8   | Native Finnish and Arabic reviewers named                                                                                                                                                          | Owner          |
| 9   | Recordings and transcripts to be deleted after review. Confirm how, for Vapi and Syveka                                                                                                            | Engineering    |

Importing a number hands Twilio credentials to Vapi for that single request. They aren't stored by
Syveka (`services/voice.ts:232-235`). Use a dedicated Twilio sub-account, so it can be closed afterwards.
Don't enable any production assistant or point a real customer at this number. Twilio's Finland
guidelines also say that automated outbound calling isn't allowed, and this plan is inbound only.

## Phases

**Phase 0, a few calls before counsel's final answer.** Counsel's answers depend on facts only a call can
show: whether recording starts before the notice, and whether it continues after a transfer. So run about
5 calls first, on staging with #335's mechanism, using internal testers who've been told everything in
writing, and invented details only. It proves timing, not wording. No outside caller hears this notice.

**Phase 1, the matrix below,** after counsel has reviewed the wording.

## Test matrix

| Group   | Calls | Scenarios                                                                                                                                                                                             |
| ------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finnish | 16    | Greeting, business question, availability, booking, numbers and addresses, names, mixed Finnish and English, interruption, background noise, mobile network, asking if it's an AI, asking for a human |
| Arabic  | 12    | The same core. Modern Standard Arabic, plus a speaker of Gulf Arabic and one of Egyptian or Levantine, since no dialect is configured                                                                 |
| English | 4     | Control group for comparison                                                                                                                                                                          |
| Limits  | 6     | Over quota at call start, over quota during a tool call, parallel calls, write caps on bookings, hang up during a tool call, webhook failure with the report delayed                                  |

## What to measure

| Measure                                                                               | How                                                                                    | Pass                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Is the notice first, complete and in the right language?**                          | Listen to the call                                                                     | Every call                                                              |
| **Does the recording contain anything before the notice?** Answers the legal question | Compare recording start with notice timing, and check whether the transcript covers it | Report the facts to counsel                                             |
| Does recording continue after transfer to a human?                                    | One transfer call                                                                      | Report to counsel                                                       |
| Time from end of caller's speech to start of reply                                    | Vapi's call logs, if available; otherwise timed from the recording                     | Report median and p95. Target under 1.5 s, to be confirmed by the owner |
| Interruption handling                                                                 | Interrupt mid-reply                                                                    | Stops promptly, and doesn't repeat itself                               |
| Transcript accuracy                                                                   | Native reviewer compares against a script                                              | Report word errors on key details: names, numbers, dates                |
| Pronunciation and naturalness                                                         | Native reviewer scores 1–5, blind                                                      | Report; the owner sets the bar                                          |
| Booking accuracy                                                                      | Compare with the test calendar                                                         | Correct slot, no duplicates, only offered slots                         |
| Usage metering                                                                        | Compare `UsageRecord` with Vapi's call duration                                        | Every call counted once                                                 |
| End-of-call report delivery                                                           | Compare calls in Vapi with `VoiceCall` rows                                            | No missing rows, or a finding for item 1 of the pricing plan            |
| Real cost per minute                                                                  | `costCents` and Vapi's `costs[]`                                                       | Replaces the estimates                                                  |
| Quota and concurrency behaviour                                                       | Limit scenarios                                                                        | Matches the pricing review, or a new finding                            |

## Stopping conditions

Stop at once and report if any of these occurs: spend reaches $100, a real person's data appears, the
notice is missing or wrong, a call reaches production data, a write lands in the wrong organization, or
a caller hears internal errors or secrets.

## Rollback and cleanup

Detach and release the number, close the Twilio sub-account, deactivate the test assistants
(`deactivateAssistant` deletes them from Vapi), delete recordings and transcripts as agreed, and keep
only the anonymised result sheet. This plan changes no production configuration.

## Output

A report with the measurements above, real cost per minute, findings for counsel, and a go or no-go
recommendation for a pilot customer.

## Approval

Not approved until completed by the owner:

- [ ] Plan and test matrix approved
- [ ] Budget limit: \_\_\_\_\_\_ (proposed $100)
- [ ] Testers and reviewers named: \_\_\_\_\_\_
- [ ] Haiku 5.5 phase included: yes / no
- [ ] Signed: \_\_\_\_\_\_ Date: \_\_\_\_\_\_
