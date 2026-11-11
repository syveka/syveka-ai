# Voice pricing and profitability review

Code base: `origin/main` at `40f71ae7`. Vendor prices read 2026-11-05. **All figures are estimates in
USD. No real call cost exists yet**, so these should be replaced with `VoiceCall.costCents` after the
first real calls. EUR 1 = USD 1.10 is an assumption.

## Summary

- **One-seat Pro can lose money at full use, and Starter's margin is thin.** With tenants paying for
  their own telephony, as the code works today and with AI messages counted, Starter is about 26%
  (11% annual) and one-seat Pro about -37%. If Syveka provided numbers, they'd be about 1% (-18% annual)
  and -50%. Several costs are excluded, so real margins are lower.
- **There's a shared-capacity risk that no plan limit addresses.** Vapi's concurrency limit is
  account-wide (10 calls on Core), so one tenant, or someone repeatedly dialling it, can block calls
  for every other tenant.
- **Usage can silently go unbilled.** Vapi doesn't retry webhooks unless configured to, and the code
  doesn't configure it. A lost end-of-call report means uncounted minutes, and nothing reconciles them.
- **Enterprise is uncapped.** The catalog sets its minutes to `MAX_SAFE_INTEGER`, with no overage.
- **Recommended:** fix metering and per-tenant concurrency first (about 8 working days), then sell
  voice as an add-on with a hard cap by default, and metered overage only on opt-in.

## Cost per minute

| Component                        | Rate        | Source and note                                                                                                                                                                          |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vapi hosting                     | $0.0500     | Vapi pricing. Still charged with your own provider keys (forum report)                                                                                                                   |
| Deepgram                         | $0.0092     | Nova-3 multilingual list price, conservative. Nova-2 FI/EN is about $0.0058; Vapi's calculator shows $0.0095-0.0099                                                                      |
| Azure TTS                        | $0.0054     | $15 per million characters, at an assumed 360 characters a minute                                                                                                                        |
| Haiku 4.5                        | $0.0130     | $1/$5, at an assumed 12,000 uncached input and 200 output tokens a minute                                                                                                                |
| **Subtotal: Syveka's cost**      | **$0.0776** | When the tenant's own Twilio account carries the call, which is the only working route to a Finnish number in the code today: Vapi's own pool is US and Canada, and BYO SIP looks broken |
| Twilio Finland inbound           | $0.0107     | Mobile number, "current as of October 2026". The local-number rate isn't published on that page                                                                                          |
| **Total with managed telephony** | **$0.0883** | If Syveka ever provides the number                                                                                                                                                       |

Fixed: Vapi Core $29/month, or $0 with a 4-line limit, 1 number and 14-day retention. Extra line
$10/month. Vapi Pro is 10% of hosting with a $999 minimum, with 30 lines. Twilio mobile number
$6.60/month (a search summary reported $5, unresolved). Core's limit of 5 numbers matters beyond 5
tenants, and whether imported numbers count against it wasn't determined. Ask Vapi. This corrects the
Fish report, which assumed $29 was enough at every volume.

## Plan margins at full use of included amounts

AI messages are costed at $0.016 each, the typical Sonnet turn in `docs/live-voice-cost-report.md:106`,
which was estimated for a bounded voice turn, so it's only a rough guide. Creator credits, Stripe fees
and the shared Vapi fee are excluded, so real margins are lower. Most customers won't use everything,
so these figures are full use with partial costs, not an average. The managed columns include one
$6.60 number.

| Plan                     | Revenue | Voice cost, tenant's telephony | Margin | With AI messages | Margin   | Voice cost, managed telephony | With AI messages, margin |
| ------------------------ | ------- | ------------------------------ | ------ | ---------------- | -------- | ----------------------------- | ------------------------ |
| Starter, monthly, 1 seat | $31.90  | $7.76                          | 76%    | $23.76           | 26%      | $15.43                        | 1%                       |
| Starter, annual, 1 seat  | $26.58  | $7.76                          | 71%    | $23.76           | 11%      | $15.43                        | **-18%**                 |
| Pro, monthly, 1 seat     | $86.90  | $38.80                         | 55%    | $118.80          | **-37%** | $50.75                        | **-50%**                 |
| Pro, monthly, 3 seats    | $260.70 | $38.80                         | 85%    | $118.80          | 54%      | $50.75                        | 50%                      |
| Pro, monthly, 5 seats    | $434.50 | $38.80                         | 91%    | $118.80          | 73%      | $50.75                        | 70%                      |

The cause is structural: price is per seat, but AI messages and voice minutes are pooled per
organization (`src/lib/billing/plan-catalog.ts:15-30`). A small team gets the whole pool for one seat's
price. Whether a one-seat Pro customer can buy that way should be confirmed in Stripe; the code sets
seats to `Math.max(1, members)` (`src/server/services/billing/plan-change.ts:288`).

## Where the money leaks

| Risk                       | How it happens                                                                                                                                                                                                                                             | Evidence                                                       | Bound                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Lost usage**             | Minutes are recorded only by the post-call job. Vapi's `Server.backoffPlan` "Defaults to undefined (the request will not be retried)", and the payload sets none. A deploy or outage during the report loses the call. A code comment assumes Vapi retries | `post-call/route.ts:113-126`, `vapi.ts:141`, `call-rows.ts:16` | **Unbounded**, with no reconciliation of `IN_PROGRESS` calls                     |
| **Concurrent overshoot**   | The quota check passes for every parallel call until the first one is billed                                                                                                                                                                               | `webhook/route.ts:125-137`                                     | 10 lines × 15 min = 150 min, about $12–13, per burst                             |
| **Noisy tenant**           | Vapi's limit covers the whole account, and Syveka has no per-tenant limit. Excess calls end with `call.start.error-subscription-concurrency-limit-reached`                                                                                                 | Vapi call-concurrency docs; no limit in `webhook/route.ts`     | All tenants' calls refused. Reputation, not just cost                            |
| **Quota checks fail open** | The quota check is after the call connects. A webhook error, or a missing control URL, leaves the call running until `maxDurationSeconds`                                                                                                                  | `webhook/route.ts:174-183`, `webhook/route.ts:458-466`         | 15 min a call                                                                    |
| **Unlimited Enterprise**   | `voiceMinutesMonth: MAX_SAFE_INTEGER`, and the 80% warning skips it                                                                                                                                                                                        | `plan-catalog.ts`, `usage-rollup/route.ts`                     | 10 lines around the clock is 432,000 min, about $34,000–38,000 a month in theory |
| **No overage**             | Nothing in `src/` bills extra minutes. A customer at their limit just stops                                                                                                                                                                                | Search of `src/lib/billing`, `services/billing`, `stripe.ts`   | Lost revenue, plus a hard stop at a bad moment                                   |

The quota check on `status-update` is deliberate, because Vapi ignores replies to that event. That's
why the real fix is a check before the call is accepted.

## Technical plan

Each item is its own PR with tests. Efforts are estimates.

| #   | Change                                                                                                                                                                                                                 | Effort    | Risk                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Retry webhooks.** Set `server.backoffPlan` in `toVapiPayload`. The webhook is already idempotent. Takes effect on re-sync                                                                                            | 0.5 day   | Low. Confirm exact retry behaviour on a test call                                                                                            |
| 2   | **Reconcile stale calls.** A job finds calls still `IN_PROGRESS` after 20 minutes (15-minute cap plus a margin), fetches them from Vapi, and feeds the existing idempotent path                                        | 2 days    | Low. Reads Vapi only                                                                                                                         |
| 3   | **Per-tenant concurrency limit.** Redis slot counter on `status-update`, released on end-of-call, with a TTL. Starter 1, Pro 3, Enterprise by contract. Over the limit, end through Live Call Control, like over-quota | 2–3 days  | Medium. A leaked slot blocks calls until its TTL                                                                                             |
| 4   | **Cost dashboard and alert.** Cost and minutes per tenant from `costCents`, with a warning at 70% of Vapi lines. No schema change                                                                                      | 2 days    | Low                                                                                                                                          |
| 5   | **Enterprise cap.** Change the catalog's value to a finite default, and give each contract its minutes through the existing additive grants, so no migration is needed                                                 | 1 day     | Low. Check existing Enterprise organizations first                                                                                           |
| 6   | **Pre-call check**, with Vapi's `assistant-request`: refuse with a spoken `error`, or set `maxDurationSeconds` from the minutes left. This removes the overshoot, and answers in the caller's language                 | 1–2 weeks | Medium. Calls then depend on Syveka's webhook within 7.5 s, so it needs `fallbackDestination`. Whether refused calls are billed wasn't found |
| 7   | **Overage billing.** See below                                                                                                                                                                                         | 1–2 weeks | Medium. Needs pricing, terms, FI/EN/AR UI, and an approved Stripe change                                                                     |

Items 1–5 take about 8 working days and need no pricing decision. Item 1 is the most valuable and the smallest.

### Overage: the choice to make

| Option                          | For                                                                                                                                                  | Against                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stripe Meters (recommended)** | Fits the existing Checkout and seat subscriptions. `identifier` deduplicates over at least 24 hours, and `call.id` is a natural key. Fully supported | Stripe now labels the guide "Not Recommended" for new integrations. No doc found showing one licensed and one metered item together, so test it in test mode first |
| Stripe Metronome                | Stripe's stated recommendation, including adding usage to flat-rate subscriptions                                                                    | Stripe lists limits, including Checkout and Dashboard. A second system to learn for one metric                                                                     |
| Prepaid minute packs            | No metering, no surprise bills, simple to explain                                                                                                    | Manual buying. Doesn't fit high-volume customers                                                                                                                   |

Whichever is chosen: a hard cap stays the default, overage is an explicit opt-in that follows Preview →
Confirm → Execute → Verify → Audit, and each meter event is written once, from the post-call job, with
the call id as its key. It would count only minutes above the included amount.

## Pricing decision for the owner

Don't change existing customers' terms. These are for new sales, and all use managed-telephony cost,
the more cautious case.

| Option                                                                                                                         | Margin on voice                              | Trade-off                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| **A. Voice add-on (recommended):** €39 for 100 min, €59 for 200, €149 for 600. Core plans include no minutes, or a small trial | 63–64%                                       | Clear margin. Higher entry price for voice customers        |
| B. Reduce included minutes: Starter 50, Pro 300                                                                                | Better, but AI-message exposure is unchanged | Simple. Looks like a reduction, and the seat mismatch stays |
| C. Minimum seats for voice, such as Pro with 3 seats                                                                           | About 50% at full use                        | Keeps the current minutes. Awkward for small businesses     |

**Overage price,** at $0.0883 a minute: €0.20 gives about 60%, €0.25 about 68%, and €0.30 about 73%. Finnish and Arabic TTS have the same list price on Azure, so no language surcharge is needed.

## Cheaper stack: Haiku 5.5

`haiku-5-5-evaluation.md`, on this branch, has the details. In short, it could save about $0.011 a
minute, or about $1,130 a month at 100,000 minutes, but it needs a real test first.

## Decisions needed

1. Approve items 1–5, on separate draft PRs.
2. Choose a pricing option, and an overage price.
3. Set a contract minute limit for Enterprise, and say whether any Enterprise customers exist today.
4. Say whether Syveka intends to provide phone numbers itself, or stay with tenant-held numbers. This
   changes the cost, the sub-processor list and the regulatory work.
5. Check the Vapi plan and its line and number limits. The repo can't see them.
