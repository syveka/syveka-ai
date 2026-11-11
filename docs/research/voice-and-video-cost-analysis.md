# Voice and video cost analysis

For the owner, to support pricing and provider decisions. Prices were read from official pages on
2026-11-05. **Every total here is an estimate.** No real Syveka call or production render has been
measured, so replace these with real figures once `costCents` and a real pilot provide them.

**Main findings:** Switching text-to-speech barely moves voice cost, since it is about 6% of a call.
Vapi's fee is 57%. On video, a template render is about 100 times cheaper than a generated clip in
compute, but only for jobs a template can do.

## Voice

**Reconciled on 2026-11-05 with draft PRs #396–#399.** The fuller analysis of Syveka's own pricing, with
AI messages included, is `docs/voice/pricing-and-profitability.md` in #399. Where this document and #399
disagreed, the better-evidenced value is used here and noted.

**Owner decision of 2026-11-05: no Fish adoption, no Vapi replacement, no paid evaluation.** Fish rows are
kept for comparison only.

### Assumptions

These are judgement, not measurement. The agent speaks 40% of the time at about 15 characters a
second, so 360 characters a minute. Finnish uses 1.03 UTF-8 bytes per character, and Arabic 1.8. The
LLM uses 12,000 uncached input and 200 output tokens a minute. One Finnish number per customer group:
1, 2, 10 and 50 numbers across the four volumes. EUR 1 = USD 1.10.

### Prices used

| Item                         | Price                                                                                                                        | Source                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Vapi platform                | $0.05/min; Core plan $29/month, with 10 lines and 5 numbers                                                                  | [Vapi](https://vapi.ai/pricing), limits from #399                                         |
| Twilio Finland inbound       | $0.0107/min on a mobile number; number $6.60/month                                                                           | [Twilio](https://www.twilio.com/en-us/voice/pricing/fi)                                   |
| Deepgram Nova-3 multilingual | $0.0092/min. Finnish and English use Nova-2 (about $0.0058, per #399), and Arabic uses Nova-3. Kept as a conservative figure | [Deepgram](https://deepgram.com/pricing), `vapi.ts`                                       |
| Soniox realtime              | $0.002/min                                                                                                                   | [Soniox](https://soniox.com/pricing)                                                      |
| Azure Neural TTS             | $15 per million characters (West Europe retail feed)                                                                         | [Azure](https://prices.azure.com/api/retail/prices)                                       |
| Fish `s2.1-pro`              | $15 per million UTF-8 bytes                                                                                                  | [Fish](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.md) |
| Fish Agents                  | $0.06/min all-in with basic LLMs, **promotional**; none extra on BYO SIP                                                     | [Fish](https://docs.fish.audio/agents/pricing.md)                                         |
| ElevenLabs Flash             | $0.04 per 1,000 characters                                                                                                   | [ElevenLabs](https://elevenlabs.io/pricing/api)                                           |
| Claude Haiku 4.5, in use     | $1 / $5 per million tokens                                                                                                   | `src/server/ai/router.ts`, #395                                                           |
| Claude Haiku 5.5             | $0.10 / $0.50 per million tokens, up to 100k-token prompts                                                                   | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)                     |
| GPU, 24 GB                   | AWS g5.xlarge $1.067/hour in eu-north-1                                                                                      | [AWS](https://aws.amazon.com/ec2/instance-types/g5/)                                      |
| LiveKit stack (Option E)     | $0.0473/min and plan fees, from #395's model                                                                                 | Not re-derived                                                                            |

### Cost per minute

"Managed" means Syveka carries the Twilio cost. **#399 shows that today's import flow takes the tenant's
own Twilio credentials, so the tenant carries it, and $0.0776 is today's Syveka-side figure.**

| Part                 | A: Tenant Twilio (today) | A: Managed  | B: Fish, FI | B: Fish, AR | C: Fish Agents | D: Self-hosted | E: LiveKit  |
| -------------------- | ------------------------ | ----------- | ----------- | ----------- | -------------- | -------------- | ----------- |
| Provider or platform | $0.0500                  | $0.0500     | $0.0500     | $0.0500     | $0.0600        | $0.0500        | see total   |
| STT                  | $0.0092                  | $0.0092     | $0.0092     | $0.0092     | included       | $0.0092        |             |
| TTS                  | $0.0054                  | $0.0054     | $0.0056     | $0.0097     | included       | GPU            |             |
| LLM                  | $0.0130                  | $0.0130     | $0.0130     | $0.0130     | basic included | $0.0130        |             |
| Telephony            | Tenant pays              | $0.0107     | $0.0107     | $0.0107     | $0.0107        | $0.0107        |             |
| Hosting, network     | included                 | included    | $0.0002     | $0.0002     | included       | see below      |             |
| **Total**            | **$0.0776**              | **$0.0883** | **$0.0887** | **$0.0928** | **$0.0707**    | **$0.0829**    | **$0.0473** |

Vapi's fee is 57% of a managed call and 64% of a tenant-carried one. TTS is 6–7%.

### Monthly cost

Includes numbers (except where the tenant pays) and plan fees. Excludes one-off engineering, operational
time and BYO SIP trunk fees. **At 10,000 and 100,000 minutes these use the $29 Core plan, but Core has 10
lines and 5 numbers, and Pro has a $999 minimum per #399. How imported numbers count is unknown, so these
totals are likely low.**

| Stack                                         | 100 min | 1,000 min | 10,000 min | 100,000 min |
| --------------------------------------------- | ------- | --------- | ---------- | ----------- |
| A: Tenant Twilio (today)                      | $37     | $107      | $805       | $7,789      |
| A: Managed                                    | $44     | $131      | $978       | $9,189      |
| A\*: Managed, with Haiku 5.5, if it holds up  | $43     | $119      | $865       | $8,058      |
| B: Vapi + Fish, Finnish                       | $44     | $131      | $982       | $9,225      |
| B: Vapi + Fish, Arabic                        | $45     | $135      | $1,023     | $9,641      |
| C: Fish Agents, promotional                   | $14     | $84       | $773       | $7,400      |
| D: Self-hosted on Vapi, 2 GPUs (6 at 100,000) | $1,602  | $1,683    | $2,482     | $13,322     |
| E: LiveKit + Soniox + Azure                   | $11     | $111      | $589       | $5,560      |

### Gross margin, voice cost only

At a usage price per minute, at 10,000 minutes a month, **with fixed fees shared across those minutes.**
#396 and #399 show 60% and 73% for A at €0.20 and €0.30 because they exclude fixed fees: a different
basis, not a conflict.

| Stack               | €0.15/min | €0.20/min | €0.30/min |
| ------------------- | --------- | --------- | --------- |
| A: Tenant Twilio    | 51%       | 63%       | 76%       |
| A: Managed          | 41%       | 56%       | 70%       |
| A\*: With Haiku 5.5 | 48%       | 61%       | 74%       |
| B: Fish, Arabic     | 38%       | 53%       | 69%       |
| C: Fish Agents      | 53%       | 65%       | 77%       |
| D: Self-hosted      | -50%      | -13%      | 25%       |
| E: LiveKit          | 64%       | 73%       | 82%       |

At plan prices confirmed in `src/lib/billing/plan-catalog.ts:93-100` (€29 and €79, so $31.90 and $86.90
at the assumed rate), full use of the included minutes, one number, managed telephony, **voice cost
only:**

| Plan                     | Revenue | A   | B: Arabic | C   | E   |
| ------------------------ | ------- | --- | --------- | --- | --- |
| Starter, 1 seat, 100 min | $31.90  | 52% | 50%       | 57% | 64% |
| Pro, 1 seat, 500 min     | $86.90  | 42% | 39%       | 52% | 65% |
| Pro, 5 seats, 500 min    | $434.50 | 88% | 88%       | 90% | 93% |

**These flatter the business.** #399 includes pooled AI messages, and finds a one-seat Pro at about -37%
with tenant Twilio and -50% managed, and an annual Starter at about -18%. Read #399 for pricing decisions.

### What this means

- **TTS is the wrong lever.** At 100,000 minutes, Fish costs about $36 a month more than Azure in
  Finnish and $452 more in Arabic, because it bills bytes and Arabic letters take two.
- **The cheapest change is the LLM, with real risks.** Haiku 5.5 would save about $0.0113 a minute (#399,
  allowing for its higher token count). Vapi's schema lists `claude-haiku-5-5`, but **a call has never
  been made on it.** #399 also flags a temperature error risk against Vapi's 0.5 default, latency from
  thinking, and a post-call summary trap (`post-call/route.ts:221`). Change only the `voice` route, and only
  after a test.
- **Fish Agents looks cheap, but** the rate is promotional, and it's blocked on data protection. It needs
  BYO SIP for Finnish numbers, whose cost isn't included.
- **Self-hosting doesn't pay.** A redundant pair of 24 GB GPUs costs $1,558 a month, against $556–$972
  of Fish API TTS at 100,000 minutes. Licences block it first.
- **Option E has the best margin, and a real build cost:** an estimated 8–12 engineer-weeks. With operating
  time, #396 finds a payback of 38–57 months. Revisit at a sustained 100,000 minutes a month.

### Two pricing risks larger than the provider choice

1. **There is no overage billing, and Enterprise voice minutes are unlimited in the catalog**
   (`src/lib/billing/plan-catalog.ts`). One Enterprise customer's cost has no limit unless a contract
   sets one.
2. **Minutes are per organization, while price is per seat,** so a one-seat Pro customer is the thinnest
   case: 42% on voice alone, and negative with AI messages (#399).

## Video

### Measured versus estimated

| Item                                | Value                                                                     | Status                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| CPU per 10-second render            | About 75–150 CPU-seconds                                                  | **Measured** on a laptop                                    |
| Memory peak                         | 1.3 GB; 2.6 GB with video                                                 | **Measured**                                                |
| Wall time per render                | Median 15–23 s when quiet, 23–32 s when busy, at 4 CPUs, plus 4–5 s check | **Measured** on a laptop                                    |
| Compute cost per render             | About **$0.002–$0.004**                                                   | **Estimated**: assumed serverless rates, unverified tonight |
| Worker host, queue, storage, egress | Not costed                                                                | **Unknown**                                                 |
| Engineering to productize           | Not estimated                                                             | **Unknown**                                                 |

### Compared with generated clips

Provider list prices for 10 seconds of video. These are what Syveka pays, not what it charges.

| Option                      | 10 s cost                             | Status                                                    |
| --------------------------- | ------------------------------------- | --------------------------------------------------------- |
| Template render (estimate)  | $0.002–$0.004                         | Compute only                                              |
| Kling 2.1 Standard, current | $0.50 or $0.56 (fal's page conflicts) | **Deprecated by fal**                                     |
| Kling 2.5 Turbo Standard    | $0.42                                 | Nearest match; not tested                                 |
| Kling 3 Standard, audio off | $0.84                                 | Breaking input changes; not tested                        |
| Kling 3 Standard, audio on  | $1.26                                 | Audio defaults to on, so a careless switch costs 50% more |
| Runway gen4_turbo           | $0.50                                 | From the earlier evaluation                               |
| Runway gen4.5               | $1.20                                 | From the earlier evaluation                               |
| Veo 3.1 via Runway          | $2–$4                                 | From the earlier evaluation                               |

### What this means

- **About 100 times cheaper in compute, for the jobs a template can do.** A template can't invent
  footage, so these are complements. The saving appears when a customer needs ten language and format
  variants of one offer, which would otherwise be ten paid generations.
- **A hybrid costs one generation plus cheap variants:** one $0.42–$0.84 clip reused across nine
  renders adds about $0.02–$0.04 of compute.
- **The margin depends on credit pricing,** which is a product decision. A template render shouldn't
  be priced like a generation, and giving it away needs a limit, since CPU is still real.
- **The cost argument fails if an LLM writes each template by hand.** The value comes from reuse.

## Could not verify

Fish API retention, and whether Fish's API tiers allow a training opt-out. Twilio's Finland local-number
inbound rate. Nova-2's price. BYO SIP trunk costs. Any real call or render cost at Syveka. Whether Vapi
accepts Haiku 5.5. Whether cloud CPUs match this laptop.
