# Voice and AI economics: decision table

For the owner, to support a pricing decision. Read against `origin/main` at `40f71ae7` on 2026-11-05.
**No prices, entitlements, Enterprise limits, Stripe settings or customer terms were changed, and no paid
call was made.**

**No measured cost exists.** No real call has been made and no real token data is in the repo, so every
margin below is a model. The result that survives the uncertainty: **pooled allowances make one-seat
customers the risk, and the AI message allowance, not voice, is the larger exposure.** Before changing
prices, measure message cost and confirm how Vapi reports call length.

## Evidence labels

**CODE**: file on `main`. **PUBLISHED**: vendor page read 2026-11-05. **PROXY**: an estimate from code
structure and published prices. **ASSUMED**: judgement. **MEASURED**: nothing in this document is.

## Decision table

Margin after payment fees and variable voice, AI and Creator costs, **before shared costs and engineering.**
Usage is **ASSUMED**: low is 10% of each allowance, typical 40%, full 100%. Messages cost $0.034 each (PROXY).

| Plan                        | Seats | Billing | Net revenue /mo | Telephony paid by | Low | Typical | Full  |
| --------------------------- | ----- | ------- | --------------- | ----------------- | --- | ------- | ----- |
| Starter, 1,000 msg, 100 min | 1     | Monthly | $30.54          | Tenant            | 86% | 44%     | -41%  |
|                             | 1     | Monthly | $30.54          | Syveka\*          | 64% | 21%     | -66%  |
|                             | 1     | Annual  | $25.66          | Tenant            | 83% | 33%     | -67%  |
|                             | 1     | Annual  | $25.66          | Syveka\*          | 57% | 6%      | -97%  |
|                             | 3     | Monthly | $92.18          | Tenant            | 95% | 81%     | 53%   |
|                             | 3     | Monthly | $92.18          | Syveka\*          | 88% | 74%     | 45%   |
|                             | 3     | Annual  | $77.02          | Tenant            | 94% | 78%     | 44%   |
|                             | 3     | Annual  | $77.02          | Syveka\*          | 86% | 69%     | 34%   |
| Pro, 5,000 msg, 500 min     | 1     | Monthly | $83.68          | Tenant            | 74% | **-3%** | -157% |
|                             | 1     | Monthly | $83.68          | Syveka\*          | 66% | -13%    | -171% |
|                             | 1     | Annual  | $69.94          | Tenant            | 69% | -23%    | -207% |
|                             | 1     | Annual  | $69.94          | Syveka\*          | 59% | -35%    | -224% |
|                             | 5     | Monthly | $419.50         | Tenant            | 95% | 80%     | 49%   |
|                             | 5     | Monthly | $419.50         | Syveka\*          | 93% | 77%     | 46%   |
|                             | 5     | Annual  | $349.79         | Tenant            | 94% | 75%     | 39%   |
|                             | 5     | Annual  | $349.79         | Syveka\*          | 92% | 73%     | 35%   |

\* **No Syveka-paid Finnish route exists in the code.** Today the tenant imports its own Twilio number, so
those rows are hypothetical. They add $0.0107/min and a $6.60 number.

- **FREE** (50 messages, no voice): up to about $1.70 per organization a month, with no revenue.
- **ENTERPRISE:** no list price in the catalog, and AI messages and voice minutes are unlimited on `main`
  (`plan-catalog.ts:72-74`). No margin can be computed. As an illustration, 100,000 minutes is about $7,760
  and 100,000 messages about $3,400 a month. #405 proposes 0 minutes without a grant, but nothing proposes a
  limit on AI messages.

## Plan facts (CODE, `src/lib/billing/plan-catalog.ts`)

| Fact            | Value                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Prices          | €29 and €79 per seat a month, **excluding VAT.** Annual is 10 months: €290 and €790 per seat      |
| Allowances      | **Per organization, never multiplied by seats.** Annual plans still reset every calendar month    |
| Minimum seats   | One seat is possible (`plan-change.ts:288`). Maximums are 10 and 50                               |
| Creator credits | 200 and 1,000, also in the plan. Costed at about $1.20 and $6 when fully used on captions (PROXY) |
| Stripe objects  | The catalog says displayed prices aren't what's charged. **Actual Stripe prices weren't read**    |

## The $0.016 AI message estimate doesn't fit

**#399's arithmetic is right: 4,800 input and 120 output tokens at Sonnet's $3/$15 is $0.0162. Its workload
is wrong for this use.** It's the "Typical" row of `docs/live-voice-cost-report.md:106`, a **live voice turn**
with 3 chunks, 12 history messages, read-only tools and a 400-token output cap. An `AI_MESSAGES` unit is
mostly something else: one typed chat turn counts as 1 whatever its tool rounds or model.

| One metered message                            | Model (CODE) | Input  | Output | Cost (PROXY) |
| ---------------------------------------------- | ------------ | ------ | ------ | ------------ |
| Workflow step, deal insight, scheduling        | Haiku 4.5    | 1,300  | 300    | $0.003       |
| Inbox draft                                    | Sonnet 4.5   | 3,000  | 300    | $0.014       |
| Typed chat, no documents                       | Sonnet 4.5   | 4,600  | 300    | $0.018       |
| **Typed chat, 10 history messages, documents** | Sonnet 4.5   | 9,250  | 400    | **$0.034**   |
| The same, with one tool (two model calls)      | Sonnet 4.5   | 19,500 | 500    | $0.066       |
| 40 history messages, 3 tool rounds             | Sonnet 4.5   | 97,000 | 1,500  | $0.31        |
| Code ceiling: 5 rounds, maximum history        | Sonnet 4.5   | ~700k  | 20,480 | ~$2.40       |

$0.034 is used here only as a central proxy; the feature mix is unknown. The code has **no prompt caching**
(cache hits would be $0.30/M), resends full context each tool round, and has no input budget on typed chat.
Rolling summaries (about $0.025 a run), titles and post-call summaries aren't metered as messages at all.
Sonnet 4.5 is marked deprecated on Anthropic's pricing page. `src/server/ai/cost.ts:6,8` holds stale prices.

## Voice cost per minute

| Part      | Tenant Twilio (today) | Syveka-paid\* | Label                                                                                                                         |
| --------- | --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Vapi      | $0.0500               | $0.0500       | PUBLISHED for no package. **The rate on Core is shown as "not listed": UNKNOWN**                                              |
| STT       | $0.0092               | $0.0092       | PUBLISHED Nova-3 multi, as a conservative figure. Vapi's calculator shows $0.0095–0.0099. FI and EN use Nova-2, about $0.0058 |
| TTS       | $0.0054               | $0.0054       | PUBLISHED $15/M characters, with 360 characters/min ASSUMED                                                                   |
| LLM       | $0.0130               | $0.0130       | PUBLISHED Haiku 4.5, with 12,000 input and 200 output tokens/min ASSUMED                                                      |
| Telephony | Tenant pays           | $0.0107       | PUBLISHED, Twilio Finland inbound on a mobile number                                                                          |
| **Total** | **$0.0776**           | **$0.0883**   | **PROXY**                                                                                                                     |

**Billing may understate real minutes.** The webhook reads `message.durationSeconds` (`webhook/route.ts:487`).
That field isn't in Vapi's published `end-of-call-report` schema, and post-call bills at least 1 minute
(`post-call/route.ts:113`). **If real payloads omit it, every call counts as 1 minute.** Whether they do is
**UNKNOWN**, since no real call has been made. If they do, and calls average 3 minutes, Pro's "500 minutes"
costs about $116, not $39.

## Sensitivity

Monthly, tenant telephony. One input changes at a time; the base is 40% usage at $0.034.

| Change                | Starter, 1 seat | Starter, 3 | Pro, 1 seat | Pro, 5 |
| --------------------- | --------------- | ---------- | ----------- | ------ |
| **Base**              | 44%             | 81%        | -3%         | 80%    |
| Message $0.003        | 84%             | 95%        | 71%         | 94%    |
| Message $0.016 (#399) | 67%             | 89%        | 40%         | 88%    |
| Message $0.066        | 2%              | 67%        | -79%        | 64%    |
| Usage 10%             | 86%             | 95%        | 74%         | 95%    |
| Usage 25%             | 65%             | 88%        | 36%         | 87%    |
| Usage 60%             | 16%             | 72%        | -54%        | 69%    |
| Usage 100%            | -41%            | 53%        | -157%       | 49%    |

**The two largest assumptions are message cost and allowance use, and seat count matters more than either.**
At full use, one seat, the costs split as follows:

| Full use, one seat, monthly | Voice alone | Messages alone at $0.034 |
| --------------------------- | ----------- | ------------------------ |
| Starter                     | $7.76, 75%  | $34.00, -11%             |
| Pro                         | $38.80, 54% | $170.00, -103%           |

**Break-even message cost, one seat:** Starter $0.067 at 40% use and $0.022 at full. Pro $0.033 at 40% and
$0.0078 at full. So one-seat Pro at full use only makes money if messages average under about 0.8 cents, which
means mostly Haiku features rather than typed chat. Telephony and TTS can't change this. Haiku 5.5 on calls saves
about $5.65 at Pro's full voice use (#399's risks still apply), while 40% fewer messages at 40% use saves about $27.

## Omitted or unknown costs

| Cost                                            | Treatment                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe fees                                     | **Included.** PUBLISHED 1.5% + €0.25, Billing 0.7%, Tax 0.5%, on a VAT-inclusive charge at Finland's 25.5%. #403 omits Stripe Tax. International cards are 3.15%                                    |
| Vapi Core                                       | **Excluded,** shared: $29 a month with 5 numbers and 10 lines. Pro is $999 minimum. How imported numbers count: UNKNOWN                                                                             |
| Hosting and platform                            | **Excluded,** shared. Published starting points: Supabase from $25, Vercel $20 per seat, Sentry from $29, Resend $20, Upstash $0.20/100K commands, QStash $1/100K. **Syveka's real bills: UNKNOWN** |
| Rolling summaries, titles, post-call            | **Excluded.** PROXY small per event; volume UNKNOWN                                                                                                                                                 |
| Call recordings                                 | **UNKNOWN.** Held by Vapi, with plan retention of 14–180 days                                                                                                                                       |
| Support and operations                          | **Excluded.** #403 shows these can dominate: its add-on margin falls from 78% to 46% with 15 minutes of support a customer, and to 17% with 30                                                      |
| Bad debt, refunds, chargebacks, taxes on Syveka | UNKNOWN                                                                                                                                                                                             |
| Exchange rate                                   | ASSUMED 1.10 USD per EUR. Revenue is in euros and most costs in dollars                                                                                                                             |

## Superseded since #396–#399 and #402

| Earlier statement                            | Now                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| #399: a lost report means uncounted minutes  | **Understated.** #404: possibly every call bills 1 minute                                                    |
| #399 retry and reconciliation are to-dos     | Written in #404, unmerged. Also needs a QStash schedule and an assistant re-sync                             |
| #399, #402: Enterprise voice is uncapped     | Still true on `main`. #405 proposes 0 minutes without a grant, and call slots: Starter 1, Pro 3              |
| #399 add-on €39 at 63–64%, overage about 68% | #403: 78% call-only, 46% or 17% with support time; overage 69% and 65%. **Still hypotheses**                 |
| #399, #402: Haiku 5.5 post-call summary trap | Addressed by #407, unmerged. The temperature risk remains unknown                                            |
| #399: fees excluded                          | #403 includes Stripe and Billing, not Tax. Included above                                                    |
| #397: no guaranteed notice                   | Still true on `main`. #406 addresses it, replaces #335, and **ends every call until languages are approved** |
| #402 reconciliation                          | A snapshot from before #403–#408, and this document adds to it                                               |

All were read at their head SHAs on 2026-11-05: #396 `05e0c09d`, #397 `1d04ba19`, #398 `6bf979b5`, #399
`b993aa71`, #403 `38982c7c`, #404 `9f8526d1`, #405 `42a00252`, #406 `90e36150`, #407 `bd314642`, #408 `a0787ddf`.
All are unmerged, so `main` has none of these fixes.

## Smallest next engineering task

**Independently review #404, ready for your merge decision.** It's already written, with 21 of 21 checks
passing, so it is the smallest step, and it prevents the largest unmeasurable loss.

| Item         | Detail                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence     | `webhook/route.ts:487` reads a field absent from Vapi's published schema. No retry on `vapi.ts:141` (Vapi doesn't retry by default). Nothing recovers a lost report. Late reports land in the wrong month |
| Scope        | Review only. No new code, unless the review finds defects                                                                                                                                                 |
| Prevents     | Lost minutes, understated usage, and a limit check that counts too little. **It doesn't address AI message cost**                                                                                         |
| Dependencies | **#408's stated merge path:** #404, #405 and #406 are reviewed individually, then merged through #408, because separately #404's reconciliation can re-create a call #406 refused                         |
| After merge  | A QStash schedule and assistant re-sync, both live actions needing your authorization. Then Phase 0 of the call test must confirm Vapi's fields: `#399` lists its prerequisites                           |

The largest exposure with **no PR at all** is typed chat's unbounded per-message cost, but the fix depends on
real numbers, so measure first (decision 1 below).

## Pricing options, for your decision

**Nothing here is implemented.** Margins use the same model, at one seat, monthly, tenant telephony. They
protect against full use, so they're worst cases. Reducing what customers have already been sold has
contractual consequences, which counsel should check.

| Option                                                                 | Effect, at one seat                                                                       | For                                                       | Against                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| **A. No change until measured**                                        | Pro -3% at 40% use, -157% at full, on this model                                          | Decide on real data; no customer impact                   | Exposure continues, though only if real use is this high    |
| **B. Smaller pools:** Starter 300 msg and 60 min; Pro 1,000 and 200    | Full use: Starter 47%, Pro 34%                                                            | Simple; bounds the worst case                             | Lowers advertised value                                     |
| **C. Pro minimum of 3 seats**                                          | Pro: 66% at 40% use, 15% at full                                                          | Keeps allowances; revenue matches a pool                  | Excludes small customers; Starter's one-seat risk remains   |
| **D. Voice as a paid add-on,** €39 for 100 minutes (#403's hypothesis) | About 81% call-only with tenant Twilio, 63% if Syveka paid; #403's 78% differs in basis   | Separates the voice cost, and it's the plan #403 proposes | Support time lowers it to 46% or 17% (#403). Needs building |
| **E. Metered overage** on voice, €0.25/min (#403)                      | About 72% on overage minutes, before fees, on today's voice cost                          | Revenue follows cost                                      | No overage billing exists; needs Stripe metering            |
| **F. Cheaper model for routine typed chat**                            | $0.016 instead of $0.034 would take Pro at 40% use from -3% to 40%; not a measured saving | No customer-visible price change                          | Quality risk, unmeasured. Engineering, not pricing          |
| **G. Finite Enterprise default,** contract grants above it             | Removes unlimited exposure. #405 does this for voice only                                 | Small; contract-based                                     | Sales must set grants                                       |

**My recommendation: A now, then decide with data.** The cost model swings from -79% to 71% for one-seat Pro on
message cost alone, too wide to justify changing prices. G is the exception: it can be decided independently,
since "unlimited" has no defensible margin at any message cost.

## Decisions for the owner

1. **Authorize one read-only aggregate query** of production token usage and message counts per plan, without
   content. The code already records tokens for chat, so this may replace the largest proxy. It's the
   cheapest way to narrow the model. This is production access, so it needs your approval.
2. Approve the Phase 0 prerequisites in #399 when ready: a real call is the only way to confirm Vapi's
   length field.
3. Choose among the options above once 1 and 2 are in.
