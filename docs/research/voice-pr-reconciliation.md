# Voice PR reconciliation

For whoever reviews #396–#402. Compared on 2026-11-05 against `origin/main` at `40f71ae7`. It lists what
was corrected in #402, and what's stale elsewhere and left alone. No other PR was edited.

## Standing owner decisions

- No Fish adoption, no Vapi replacement, no credits and no paid evaluation.
- **#401 stays a draft, isn't retargeted to `main`, and #395 isn't merged.**
- Fish items are parked. Written questions are prepared, unsent, in
  [fish-audio-vendor-questions.md](fish-audio-vendor-questions.md).

## Status of the PRs

| PR   | Head SHA    | Purpose                                            | Note                                                                                   |
| ---- | ----------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| #395 | `1e5ba5a8`  | Fish evaluation and pilot code                     | Not to be merged. Its evaluation file conflicts with #396 and #401                     |
| #396 | `05e0c09d`  | Fish report and owner decision                     | The record of the earlier decision                                                     |
| #397 | `1d04ba19`  | AI notice audit, sub-processor corrections         | For legal review. Reviews #335                                                         |
| #398 | `6bf979b5`  | Windows and load test fixes, disk report           | Its report still says CI "Pending"                                                     |
| #399 | `b993aa71`  | Pricing, Haiku 5.5 evaluation, call test plan      | **The better source for pricing decisions.** Its Arabic summary doesn't list #400–#402 |
| #401 | `e2293351`  | Pilot additions and Fish re-check, stacked on #395 | No CI. Reference only                                                                  |
| #402 | This branch | Video and voice research                           | Corrected as below                                                                     |

#396–#399 were all draft and mergeable, with their CI passing, when read. Those were read at the SHAs above.

## Corrected in #402

| Topic              | Was                            | Now                                                                      | Why                                              |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Current cost       | $0.0883/min as "current"       | $0.0776 with the tenant's Twilio (today), $0.0883 managed                | `vapi.ts` import takes tenant credentials (#399) |
| Vapi's share       | 57%                            | 57% managed, 64% tenant-carried                                          | Follows from the above                           |
| Haiku 5.5 saving   | $0.0117/min                    | $0.0113, allowing for its higher token count                             | #399                                             |
| Vapi and Haiku 5.5 | "Could not verify"             | Schema lists the id; no call has been made on it                         | #399, schema re-checked                          |
| Haiku 5.5 risk     | "No migration"                 | Temperature, latency and post-call summary risks; `voice` route only     | #399; `post-call/route.ts:221`                   |
| Vapi plan          | $29 at all volumes             | Same, with a caveat: Core has 10 lines and 5 numbers, Pro a $999 minimum | #399. How imports count is unknown               |
| Deepgram           | "Nova-2 price unverifiable"    | $0.0092 kept as conservative; Arabic uses Nova-3, others Nova-2          | #399; `vapi.ts`                                  |
| Plan prices        | "Not re-verified"              | Confirmed                                                                | `plan-catalog.ts:93-100`                         |
| Margins            | One-seat Pro "thinnest at 42%" | Labelled voice-only; with AI messages, negative                          | #399                                             |
| Margin basis       | Unlabelled                     | States it includes fixed fees, unlike #396 and #399                      | Different basis, not an error                    |
| 1,000-minute total | $130                           | $131                                                                     | Rounding of $130.50                              |
| Option E           | No operating cost              | Cites a 38–57 month payback with operating time                          | #396                                             |
| Fish blockers      | Key, paid test                 | Parked by owner decision                                                 | Owner decision                                   |
| Retargeting #401   | "After #395"                   | Removed                                                                  | Owner decision                                   |
| Next step          | "A real +358 baseline"         | Adds owner signature, Phase 0, counsel, Twilio documents                 | #399, #397                                       |
| C: disk drop       | "No cause found"               | Probably the pagefile; link unproven                                     | #398 measured it                                 |

## Where #402 and #401 are better evidenced than the others

These come from vendor pricing pages, and #395, #396 and #401's copy of `docs/voice/fish-audio-evaluation.md`
still show the older values:

| Item                    | Older                     | Better evidenced                                              |
| ----------------------- | ------------------------- | ------------------------------------------------------------- |
| Fish Agents per minute  | ~$0.098, "rate not found" | $0.06 (promotional), $0.0707 with carrier inbound             |
| GPU per hour            | Estimated $2              | AWS g5.xlarge $1.067 in eu-north-1 (fits S2-Pro only)         |
| Self-hosting break-even | 300,000–525,000 min       | 160,000–280,000 min, arithmetic only; two GPUs can't carry it |

None of these changes a recommendation.

## Stale elsewhere, left alone

| Where                        | What                                                                        | Current                                                                            |
| ---------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| #401, #396                   | "Confirm #335 covers Arabic"                                                | #397 reviewed it: order and language are fixed, with three high-severity gaps left |
| #401, #396                   | BYO SIP "inferred" or "unverified"                                          | #399 checked the schema, and `vapi.ts:208` sends `sipUri`                          |
| #401                         | "+358 by import"; recommends retesting Fish by 2026-11-30                   | Only Twilio import looks workable. Paid Fish tests aren't approved                 |
| #401                         | Option C "costed here" for BYO SIP; GDPR cell for A omits Vapi's US default | Carrier cost only; EU hosting is on Vapi's Premier plan only (#397)                |
| #396                         | Lists Twilio as an omitted sub-processor                                    | #397 says probably not. For counsel                                                |
| #398                         | Report says CI "Pending"                                                    | CI has since passed                                                                |
| #399                         | Summary lists #395–#399 only, and says CI pending                           | CI has since passed; #400–#402 now exist                                           |
| `docs/creator-studio.md:152` | Names Kling v1.5                                                            | Default is v2.1                                                                    |

## Generic work in #395 and #401

**Nothing in the Fish code merits extraction, because production would use none of it.** Unused code isn't
a useful PR.

| Candidate               | Used in production today?                                        | Recommendation                         |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Speech stream guard     | No. Vapi does phone TTS, and the browser uses device speech      | No PR                                  |
| Webhook tool extraction | Not implemented, and it'd be a refactor of a live security route | Defer until a provider move is decided |
| Usage and percentiles   | No. In-memory, and nothing records samples                       | No PR                                  |
| Intent matching         | No. A regex stand-in for an LLM                                  | No PR                                  |

**Fixes the audit found, independent of Fish:**

| Candidate                                            | Used today?                                 | Recommendation                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Arabic call summaries** (`post-call/route.ts:216`) | **Yes:** Arabic calls get English summaries | **The one worthwhile independent PR.** About half a day per #397. Coordinate with #316, which edits the same file |
| ElevenLabs empty voice id (`vapi.ts:132`)            | Barely: the form has no provider field      | Low priority; bundle only if already touching it                                                                  |
| BYO SIP `credentialId` (`vapi.ts:208`)               | If anyone uses that path                    | Real but not small: needs a test trunk. Hold; the test plan avoids it                                             |
| Arabic disclosure                                    | Yes                                         | Already in #335, awaiting counsel. No new PR                                                                      |
| Stale docs                                           | Docs only                                   | Optional small PR                                                                                                 |

**Decision for the owner:** whether to authorize the Arabic summary fix as its own PR. Not started.
