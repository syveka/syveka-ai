# Fish Audio evaluation for Syveka voice

Audit base: `origin/main` at `40f71ae7`. External sources read 2026-11-05 through a summarising
fetch tool, so check legal wording against the source before relying on it. This is engineering
analysis, not legal advice.

**Decision: keep the current stack. Do not adopt Fish Audio now. Reject Fish Agents and
self-hosting for phone calls. Allow one small further step for Fish TTS, if the owner approves it:
a listening test on synthetic text only. No real customer data reaches Fish unless it clears §3.**

No real audio was generated or heard, and no paid API was called. Nothing here shows how Fish, or
Syveka's current stack, sounds or performs on a phone call.

## 1. How voice works in Syveka today

Evidence labels: **code** means implemented and covered by mocked unit tests. **Live** means a
real call. The repo holds no live call evidence: `docs/release-readiness-eca6822.md:124` lists Vapi
as UNVERIFIED, and draft PR #299 says nothing in its evidence table is live-verified.

| Capability           | Status       | Role today                                                                                                                             | Evidence                                                                          |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Vapi                 | IMPLEMENTED  | Runs the whole call: telephony link, turn-taking, STT, LLM and TTS. Syveka only sends config and answers webhooks                      | `src/server/integrations/vapi.ts:96-145`, `src/app/api/v1/voice/webhook/route.ts` |
| Soniox               | MISSING      | No reference anywhere in the repo, in code, config or docs                                                                             | Repo-wide search                                                                  |
| Phone STT            | IMPLEMENTED  | Deepgram through Vapi: nova-2 for FI/EN, nova-3 for AR                                                                                 | `vapi.ts:89-93`, `vapi.ts:134-138`                                                |
| Phone LLM            | IMPLEMENTED  | Haiku 4.5 through Vapi, constrained by Vapi's accepted-model list                                                                      | `src/server/ai/router.ts:32-37`, `vapi.ts:121-129`                                |
| Phone TTS            | IMPLEMENTED  | Azure by default (`fi-FI-SelmaNeural`, `ar-SA-ZariyahNeural`, `en-US-JennyNeural`); ElevenLabs optional                                | `vapi.ts:77-81`, `vapi.ts:130-133`, `src/lib/validators/voice.ts:27`              |
| Telephony            | PARTIAL      | Vapi's pool is US/Canada only. +358 needs an imported Twilio or BYO SIP number                                                         | `src/server/services/voice.ts:109-118`, `voice.ts:218-221`, `vapi.ts:171-211`     |
| Outbound calls       | MISSING      | An enum value exists; no code places a call                                                                                            | `prisma/schema.prisma:1305-1308`                                                  |
| Booking and calendar | IMPLEMENTED  | Four allowlisted tools, per-call write caps, replay guard, refusal after the call ends                                                 | `validators/voice.ts:9-14`, `webhook/route.ts:96-100`, `webhook/route.ts:374-434` |
| CRM and post-call    | IMPLEMENTED  | Idempotent job: metering, contact match or create, Haiku summary, activity, notification, workflow event                               | `src/app/api/v1/jobs/post-call/route.ts:99-326`                                   |
| Metering and limits  | PARTIAL      | Minutes recorded after the call and checked at call start and on tool calls. Parallel calls can overshoot. No overage billing exists   | `webhook/route.ts:125-137`, `post-call/route.ts:113-126`                          |
| Pricing              | PARTIAL      | Starter 100 min, Pro 500 min; Enterprise voice minutes are unlimited. Provider cost is stored per call                                 | `src/lib/billing/plan-catalog.ts:47-74`, `webhook/route.ts:494`                   |
| Browser live voice   | EXPERIMENTAL | Separate flag-gated pilot in AI Chat: `gpt-4o-mini-transcribe`, Sonnet chat, and the device's own speech synthesis. No server-side TTS | `src/app/api/v1/ai/voice-conversation/turn/route.ts:14-15`, `use-device-voice.ts` |
| Custom-LLM voice     | PLANNED      | Listed on the roadmap only                                                                                                             | `docs/ROADMAP.md:100`                                                             |

### Problems found during the audit

None of these is fixed here, because they are outside this task.

| Finding                                                                                                                                                   | Evidence                                                                                             | Note                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The AI and recording notice is only a prompt instruction, and Arabic assistants get it in English. The owner's `firstMessage` is spoken before it         | `services/voice.ts:326-329`                                                                          | Compliance risk. Draft #335 addresses it; confirm it covers Arabic |
| Published sub-processor list omits Deepgram, Azure, ElevenLabs and Twilio, although call audio or text reaches them when they are used                    | `src/app/[locale]/(marketing)/legal/[doc]/page.tsx:10`                                               | Needs owner and legal review                                       |
| Recording is requested through a top-level field that Vapi's schema doesn't define                                                                        | `vapi.ts:143`                                                                                        | Finding from #335, not re-verified                                 |
| BYO SIP sends a SIP URI as `credentialId`. Probably wrong, since the field name suggests an id; unverified without a real import                          | `vapi.ts:204-209`                                                                                    | Would block non-Twilio +358 numbers                                |
| Arabic call summaries are requested in English                                                                                                            | `post-call/route.ts:215-217`                                                                         | Product gap                                                        |
| An ElevenLabs assistant with no voice id sends an empty id                                                                                                | `vapi.ts:132`                                                                                        | Likely sync failure                                                |
| Docs overstate reality: "Finnish phone numbers" and a knowledge-base tool. The runbook still enables `searchKnowledgeBase`, which the allowlist now drops | `docs/PROJECT-STATUS.md:75`, `docs/ARCHITECTURE.md:239-240`, `docs/fruppi-voice-pilot-runbook.md:36` | Stale docs                                                         |

## 2. What Fish Audio is

Labels: **V** read on the vendor's page. **Claim** is the vendor's own unmeasured figure. **NF**
means not found.

| Topic                | Finding                                                                                                                                                                              | Label  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| TTS API              | REST `/v1/tts` and WebSocket `/v1/tts/live`. WAV/PCM at 8–44.1 kHz, MP3, Opus. No μ-law or A-law. An unrecognised `model` silently falls back to `s2.1-pro`                          | V      |
| TTS latency          | S2-Pro "100ms time-to-first-audio"; normal ~500 ms, balanced ~300 ms. No figure for S2.1-Pro. No independent or EU measurement                                                       | Claim  |
| STT                  | Realtime `transcribe-stream-1` is **Preview**, 16-bit PCM only. Batch `transcribe-1-pro`. $0.36/hour                                                                                 | V      |
| Fish Agent SDK       | A **browser client** (MIT, 1 star, 23 commits, v0.3.0 seen) for agents **hosted by Fish**. Talks WebRTC on LiveKit. It isn't a self-contained stack and doesn't mention phone        | V      |
| Fish Agents platform | **Public beta.** Interruption settings, webhook/client/system tools, OpenAI-compatible custom LLM (10 s timeout, one retry, three failed generations end the call)                   | V      |
| Telephony            | Managed numbers are US/Canada only. Non-US/CA needs BYO SIP into Fish's LiveKit address. Codecs, SRTP, EU region and transfer countries: NF. No Finnish test known                   | V / NF |
| Vapi                 | Fish isn't a listed Vapi provider. Possible only through Vapi's generic custom TTS route, which sends text to a server we would have to run                                          | V      |
| Finnish              | Listed for Agents and realtime STT, and in S2-Pro's "other" tier. **S1 has no Finnish.** S2.1-Pro and Drama 3 claim 83 languages without a list, so Finnish is unconfirmed           | V / NF |
| Arabic               | Listed, S2-Pro tier 2. **No dialects are listed anywhere.** Azure lists 16+ Arabic locales                                                                                           | V      |
| Quality evidence     | No Finnish or Arabic quality evidence, for phone or otherwise                                                                                                                        | NF     |
| Mid-call language    | Agent language switching on Nova-3 covers ten languages, not Finnish or Arabic                                                                                                       | V      |
| Voice cloning        | Requires your own voice or written permission. Terms don't address consent or library licensing. Free-plan commercial rights contradict each other between pages                     | V      |
| Maintenance          | fish-speech ~34k stars, last commit 2026-10-29, v3.0.0-beta 2026-10-13. S1 retires 2026-12-31 on under three months' notice. Status page reports 99.95%+. SLA "99%", enterprise only | V      |
| Corporate            | Terms name Hanabi AI Inc. (Delaware); the licence names 39 AI, Inc. Relationship NF. $52M seed, July 2026 (third-party)                                                              | V / R  |

### Licensing of self-hosted weights

- **Drama 3 and code (Fish Audio Community License):** commercial use only below USD 500,000 annual
  revenue, affiliates included. Third-party work is covered only if that party is also under the
  threshold. No licence to offer a "Hosted Service" at any revenue, with an exclusion for content
  your own product generates. Whether a multi-tenant receptionist fits that exclusion needs a
  lawyer. Hugging Face metadata for Drama 3 names a different licence than its own text.
- **S2-Pro weights (Fish Audio Research License):** commercial use needs a separate licence.
- **S2.1-Pro:** the API production model. No weights found.

## 3. Data-protection blockers

Syveka's phone flow sends caller speech text, names and booking details to whichever TTS is used.

| Question                              | What Fish publishes                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Where is data processed?              | "By default your data stays in the United States"; inference from US and Tokyo. **EU is not mentioned**                    |
| Is customer content used in training? | Terms: "Usage Data and Content may be used to develop, train, or enhance" models. **No opt-out found**                     |
| Is there a DPA?                       | **None found**, and no sub-processor list. `/dpa` and `/security` return 404                                               |
| Retention                             | Zero retention on enterprise contracts only. Agent transcripts "always kept"; recording on by default; retention period NF |
| Certification                         | SOC 2 Type II "currently underway"; ISO NF                                                                                 |
| Are the terms current?                | Terms and privacy policy are dated August 2024, which may predate Agents                                                   |

**Gate:** no real customer data reaches Fish until Fish provides, in writing, a DPA with a
sub-processor list, EU processing or a defensible transfer mechanism, and a contractual
no-training commitment. The training clause alone blocks production use as published.

## 4. Options compared

Ratings marked **untested** have no measurement behind them. "Blocked" means a stated gate must
clear first.

| Criterion                 | A: Current (Vapi)                            | B: Vapi + Fish TTS                                   | C: Fish Agents                                | D: Self-hosted Fish                                                                                       | E: LiveKit + best-of-breed                                              |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| End-to-end latency        | Untested in repo                             | Untested. Adds our server and a likely US round trip | Untested. US-hosted inference likely          | Untested. Vendor: ~100 ms on an H200                                                                      | Untested. Region pinning available on paid plans                        |
| Voice quality             | Untested                                     | Untested. Fish's main possible advantage             | Untested                                      | Untested                                                                                                  | Untested, provider of choice                                            |
| Finnish                   | Azure lists fi-FI; untested                  | Listed for S2-Pro, unconfirmed for S2.1-Pro          | Listed; untested                              | S2-Pro "other" tier                                                                                       | Choice of Azure, ElevenLabs, Cartesia                                   |
| Arabic and dialects       | One default locale, 16+ available            | Generic `ar`, no dialects                            | Generic `ar`, no dialects                     | Generic `ar`, no dialects                                                                                 | Best available: Azure locales                                           |
| Interruption, turn-taking | Vapi's, unmeasured here                      | Unchanged                                            | Built-in, public beta                         | Unchanged if kept on Vapi                                                                                 | Must be tuned by us                                                     |
| Phone reliability         | Hosted; live-unverified here                 | New failure point: our TTS server                    | Beta; BYO SIP for +358, untested              | Lowest: our GPU fleet is in the path                                                                      | Ours to run; mature SIP stack                                           |
| Tools and booking         | Implemented with write caps and replay guard | Unchanged                                            | Rebuild against Fish webhooks                 | Unchanged if kept on Vapi                                                                                 | Rebuild the webhook layer in-process                                    |
| CRM integration           | Implemented                                  | Unchanged                                            | Rebuild post-call input                       | Unchanged                                                                                                 | Rebuild post-call input                                                 |
| Multi-tenant isolation    | Bound to the signed assistant                | Unchanged, plus tenant routing on the TTS endpoint   | Workspaces only; no reseller model found      | Ours to build                                                                                             | Ours to build, full control                                             |
| Operational complexity    | Low                                          | Low to medium                                        | Medium (migration)                            | High                                                                                                      | High                                                                    |
| Scaling                   | Vapi's limits                                | Fish: 5 concurrent under $100 prepaid, 429 at limit  | Same credit-based limits                      | GPU planning; 24–48 GB VRAM minimum                                                                       | Good, at our effort                                                     |
| Vendor lock-in            | High on Vapi                                 | Same, TTS swappable                                  | Highest                                       | Lowest code lock-in, high licence risk                                                                    | Lowest                                                                  |
| Commercial licence        | Standard API                                 | API terms; clarify free-plan conflict                | Beta terms                                    | **Blocked:** S2-Pro at any revenue without a separate licence; Drama 3 above $500k or as a hosted service | Apache-2.0 and BSD-2-Clause frameworks                                  |
| GDPR                      | Sub-processor list is incomplete             | **Blocked**, see §3                                  | **Blocked**, plus third-party STT in the path | Best possible if the licence clears                                                                       | Good for Deepgram, Azure, Google EU regions; Soniox EU status not found |
| Cost per minute (§5)      | $0.088                                       | $0.089 FI, $0.093 AR                                 | ~$0.098, low confidence                       | $0.083 plus fixed GPU cost                                                                                | ~$0.047, plus build cost                                                |

**A TTS provider can't replace a phone agent.** Fish TTS replaces one of the five parts of Vapi's
call. The other four, plus Syveka's tool and post-call layers, remain.

## 5. Financial comparison

All figures in USD. **Treat these as estimates, not quotes.** List prices are from the sources in
§8.

**Assumptions, none measured on real Syveka calls:** the agent speaks 40% of the time at about 15
characters per second, so 360 characters per minute. Bytes per character are 1.03 for Finnish and
1.8 for Arabic. The LLM uses 12,000 uncached input and 200 output tokens per minute. Deepgram
Nova-3 multilingual is the proxy for Nova-2, whose price wasn't verified. Twilio inbound at
$0.0107/min. GPU at an estimated $2 an hour, always on. Operational time at $75 an hour; the hours
below are judgement, not data. EUR 1 = USD 1.10. **Real figures should replace these once
`costCents` has real calls behind it.**

Unit prices: Fish $15 per million bytes, Azure $15 and ElevenLabs Flash $40 per million characters,
Haiku 4.5 $1/$5 per million tokens.

| Fixed monthly item, by volume (100 / 1,000 / 10,000 / 100,000 min)   | Amount                            | Applies to |
| -------------------------------------------------------------------- | --------------------------------- | ---------- |
| Vapi Core plan                                                       | $29 at every volume               | A, B, D    |
| Finnish mobile numbers at $6.60 (1 / 2 / 10 / 50 numbers)            | $7 / $13 / $66 / $330             | All        |
| LiveKit plan                                                         | $0 / $50 / $50 / $500             | E          |
| GPUs at $1,460 each (2 / 2 / 2 / 6, assuming peaks, with redundancy) | $2,920 / $2,920 / $2,920 / $8,760 | D          |

| Operational hours a month (100 / 1,000 / 10,000 / 100,000 min) | A               | B                | C                | D                  | E                 |
| -------------------------------------------------------------- | --------------- | ---------------- | ---------------- | ------------------ | ----------------- |
| Hours                                                          | 2 / 5 / 10 / 20 | 6 / 10 / 16 / 30 | 6 / 10 / 20 / 40 | 40 / 40 / 60 / 120 | 20 / 20 / 30 / 60 |

### Variable cost per connected minute

| Component | A: Current  | B: Fish, FI | B: Fish, AR | C: Fish Agents      | E: LiveKit stack                |
| --------- | ----------- | ----------- | ----------- | ------------------- | ------------------------------- |
| Platform  | $0.0500     | $0.0500     | $0.0500     | $0.0833 (derived)   | $0.0160 (includes est. compute) |
| STT       | $0.0092     | $0.0092     | $0.0092     | Included?           | $0.0020 (Soniox)                |
| TTS       | $0.0054     | $0.0056     | $0.0097     | Included?           | $0.0054 (Azure)                 |
| LLM       | $0.0130     | $0.0130     | $0.0130     | Possibly included   | $0.0130                         |
| Telephony | $0.0107     | $0.0107     | $0.0107     | $0.0147 (incl. SIP) | $0.0107                         |
| Network   | Included    | $0.0002     | $0.0002     | Included            | $0.0002                         |
| **Total** | **$0.0883** | **$0.0887** | **$0.0928** | **~$0.098**         | **$0.0473**                     |

The Fish Agents price is derived from "$5 trial, about 60 minutes". The official per-minute rate
wasn't found, and neither was what it includes. If speech recognition or the LLM is billed on top,
that column is understated, so treat it as low confidence.

### Monthly cost: direct cost / with operational time

| Stack                                        | 100 min         | 1,000 min       | 10,000 min      | 100,000 min       |
| -------------------------------------------- | --------------- | --------------- | --------------- | ----------------- |
| A: Current                                   | $44 / $194      | $131 / $506     | $978 / $1,728   | $9,189 / $10,689  |
| A\*: Current with Haiku 5.5 (if Vapi allows) | $43 / $193      | $119 / $494     | $861 / $1,611   | $8,019 / $9,519   |
| A: With ElevenLabs Flash                     | $45 / $195      | $140 / $515     | $1,068 / $1,818 | $10,089 / $11,589 |
| B: Vapi + Fish, Finnish                      | $44 / $494      | $131 / $881     | $982 / $2,182   | $9,225 / $11,475  |
| B: Vapi + Fish, Arabic                       | $45 / $495      | $135 / $885     | $1,023 / $2,223 | $9,641 / $11,891  |
| C: Fish Agents (low confidence)              | $16 / $466      | $111 / $861     | $1,046 / $2,546 | $10,130 / $13,130 |
| D: Self-hosted Fish on Vapi                  | $2,964 / $5,964 | $3,045 / $6,045 | $3,846 / $8,346 | $17,429 / $26,429 |
| E: LiveKit + Soniox + Azure                  | $11 / $1,511    | $111 / $1,611   | $589 / $2,839   | $5,560 / $10,060  |

Excludes one-off engineering. E also needs an estimated 8–12 engineer-weeks to build.

### What this shows

- **TTS is about 6% of the call. Switching it barely moves cost.** Against Azure at 100,000
  minutes, Fish costs about $36 a month more in Finnish and $452 more in Arabic. Fish bills by
  byte, so Arabic costs about 80% more per character than Azure, and 75% more than Fish's own
  Finnish. Against ElevenLabs Flash it saves about $864 a month in Finnish.
- **Vapi's $0.05 is 57% of the call.** That is the real cost lever, and only option E lowers it.
- **The cheapest change is the LLM:** Haiku 5.5 would save about $0.0117 a minute with no
  migration, if Vapi accepts it and it holds up on calls. List price $0.10/$0.50 per million tokens
  against $1/$5.
- **Self-hosting never pays at these volumes.** Fish's API TTS is about $550–970 a month at 100,000
  minutes, against an estimated $8,760 in GPUs. Even holding the fleet at two GPUs ($2,920), the
  break-even would be about 525,000 min/month in Finnish or 300,000 in Arabic, and two GPUs can't
  carry that load, so the true break-even is higher or doesn't exist. Adding an estimated $5,000 a
  month of engineering moves that floor to about 1.4M or 815,000. Fish's own hosted self-deployment
  ($10k a month minimum) breaks even at about 1.8M or 1.0M. The licence blocks self-hosting first.
- **E doesn't pay back at today's volumes, and its case depends on operational cost.** The build
  is an estimated 8–12 engineer-weeks ($24,000–36,000 at $75 an hour; the paybacks below exclude the $6,000 two-week spike). On
  direct cost alone it saves about $389 a month at 10,000 minutes and $3,629 at 100,000, a payback of
  7–10 months at the higher volume. With the assumed operational time it costs $1,111 a month more
  at 10,000 minutes and saves only $629 at 100,000, a payback of 38–57 months, with break-even near
  67,000 minutes. Revisit at a sustained 100,000 minutes a month, or if Vapi limits force it.

### Gross margin, voice cost only

Revenue is at list price per customer, with full use of the included minutes and one number. AI
messages and other product costs are excluded, so real margins are lower. **The $29 Vapi plan and any LiveKit plan
fee are shared across all customers and are left out of this table.** For a sole customer it decides the
result: Starter on A falls to about -39%, one-seat Pro on A to about 8%, and one-seat Pro on E with
a $50 plan to about 8%.

| Plan                     | Revenue | A: Margin | E: Margin |
| ------------------------ | ------- | --------- | --------- |
| Starter, 1 seat, 100 min | $31.90  | 52%       | 64%       |
| Pro, 1 seat, 500 min     | $86.90  | 42%       | 65%       |
| Pro, 5 seats, 500 min    | $434.50 | 88%       | 93%       |

| Usage price per minute | A   | B, Arabic | C (low confidence) | E   |
| ---------------------- | --- | --------- | ------------------ | --- |
| €0.15                  | 46% | 44%       | 41%                | 71% |
| €0.20                  | 60% | 58%       | 55%                | 79% |
| €0.30                  | 73% | 72%       | 70%                | 86% |

**Two pricing risks matter more than the TTS choice.** Minutes are per organization while price is
per seat, so a one-seat Pro customer is the thinnest case. There is also no overage billing, and
Enterprise voice minutes are unlimited in the catalog, so one Enterprise customer's minutes have no
limit unless a contract sets one.

## 6. Pilot results

A development-only pilot is included in this branch. **It proves the integration boundary and the
safety properties. It doesn't evaluate Fish.**

| Requirement               | Result                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation                 | New route and page only, plus their two generated route-template lines. Open only under `next dev` with `FISH_VOICE_PILOT_ENABLED=1`; closed in production builds and on Vercel. No production voice code changed; no migration. The closed route is unreachable but still compiled in: POST answers 404, and other methods get the framework's default answers |
| Two-way conversation      | **Partial.** Multi-turn call with state, but the caller and replies are scripted, and a scripted reply can contradict a tool refusal. No microphone, STT or LLM                                                                                                                                                                                                 |
| FI and AR scenarios       | Lines exist, including a pronunciation set. Not reviewed by native speakers. **Audio played is a test tone**                                                                                                                                                                                                                                                    |
| Streaming                 | Tested with the mock. Handles samples split across chunks                                                                                                                                                                                                                                                                                                       |
| Interruption              | Stops the provider stream on cancel. This is client-initiated cancel only; there is no voice barge-in or phone echo handling                                                                                                                                                                                                                                    |
| Error handling            | First-chunk, idle and overall timeouts, provider errors, mid-stream failure and malformed audio all return stable codes, with no provider text                                                                                                                                                                                                                  |
| Tool compatibility        | Real voice allowlist and real tool schemas, with a mock CRM and calendar. It doesn't touch the real tools                                                                                                                                                                                                                                                       |
| Keys and paid calls       | The key stays server-side. A key alone never starts paid use; a separate approval flag is required, then the live-voice rate limit and a stop at 100 real turns until restart or hot reload apply. Unit tests mock `fetch`                                                                                                                                      |
| Tenancy and authorization | Identity from `requirePermission` only. Cross-tenant, replay, malicious-argument and client-supplied `orgId` cases have negative tests. Replay and caps are in memory, so they hold within one server process only, unlike the phone webhook's durable checks                                                                                                   |
| Fish adapter              | Written from the API reference, **never run against the real API**. PCM byte order, headers and response content type aren't stated in the docs                                                                                                                                                                                                                 |
| Browser page              | Compiles. **Never opened in a browser**, since it needs local Supabase and Redis credentials                                                                                                                                                                                                                                                                    |

**Measured latency** (200 samples, Windows laptop, mock provider): the guard adds about 0.2 ms to
first audio at p50 (15.50 ms against 15.32 ms unguarded, which is within timer resolution, so
effectively no measurable cost). Cancel reaches the caller in about 0.04 ms. This was a one-off
script, not committed, run on the guard before its final deadline check. **These numbers
describe Syveka's code path only. They say nothing about Fish's latency or any phone call.**

### What the pilot exposed

The webhook's tool execution is tangled with Vapi's request shape in a route file, so its write
caps can't be imported, and the pilot had to copy them (`conversation.ts`). Any provider move,
including option E, should start by extracting that logic into a shared service.

### To run it locally

Set `FISH_VOICE_PILOT_ENABLED=1` in a local environment that already has Supabase and Redis, sign in
as a user with `voice:configure`, and open `/fi/voice/fish-pilot`. Real calls need owner approval and are paid
unless the free model is chosen. For those, also set `FISH_VOICE_PILOT_ALLOW_PAID_API=1`, `FISH_AUDIO_API_KEY`,
`FISH_AUDIO_VOICE_ID` and optionally `FISH_AUDIO_MODEL=s2.1-pro-free`. Use only the scripted
synthetic lines, because the terms allow training on content.

## 7. Roadmap

Effort is an estimate. Each item is separately authorized.

### P0: worthwhile whatever happens with Fish

| Task                                                                                     | Effort   | Depends on                 |
| ---------------------------------------------------------------------------------------- | -------- | -------------------------- |
| Baseline real +358 calls in FI, AR and EN: latency, interruption, booking, cost per call | 2–3 days | Owner approval, paid calls |
| Review and land the disclosure fix (#335); confirm the Arabic notice is spoken in Arabic | 1 day    | Human review               |
| Correct the sub-processor list                                                           | 0.5 day  | Owner and legal            |
| Decide overage and Enterprise limits, and enforce parallel-call limits                   | 2–4 days | Business decision          |
| Check whether Vapi accepts Haiku 5.5, then compare booking accuracy                      | 1–2 days | Baseline calls             |
| Verify the BYO SIP `credentialId` path                                                   | 1 day    | A test SIP trunk           |

### P1: gated Fish evaluation

| Task                                                                                                               | Effort    | Depends on                          |
| ------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------- |
| Ask Fish in writing for DPA, sub-processors, EU processing, no-training terms, S2.1-Pro language list              | 1 day     | Owner sends                         |
| Blind listening test, synthetic text: Fish, Azure, ElevenLabs, Cartesia. Native FI and AR raters, phone-band audio | 2–3 days  | Owner approval; synthetic text only |
| Measure time to first audio from an EU host                                                                        | 0.5 day   | Same approval                       |
| Extract the webhook's tool execution into a shared service                                                         | 3–5 days  | None                                |
| Only if Fish wins and clears §3: Vapi custom TTS endpoint behind a per-assistant `voiceProvider` value             | 1–2 weeks | All above                           |

The free model, `s2.1-pro-free`, is documented as free for testing through 2026-11-30, so the
listening test costs little if it runs before then. Any Fish production plan must also handle S2.1
language coverage and the short deprecation notice seen on S1.

### P2: only with sustained volume

| Task                                                  | Effort     | Depends on                                  |
| ----------------------------------------------------- | ---------- | ------------------------------------------- |
| Spike option E on one test tenant                     | 2 weeks    | Sustained 100,000 min/month, or Vapi limits |
| Soniox STT comparison for FI and AR (cheapest listed) | 2–3 days   | Baseline calls                              |
| Migrate to option E with parallel running             | 8–12 weeks | Spike succeeds                              |

### Rollback

- **Pilot:** unset the flag, or don't merge. It is unreachable in production and holds no data.
- **Fish TTS, if ever adopted:** `voiceProvider` is per assistant and stored as a string, so switch
  back to `azure` and let the existing re-sync (`resyncActiveAssistants`) push it. No migration.
- **Option E:** keep Vapi assistants live, and move numbers tenant by tenant.

## 8. Sources

**Fish:** [fish-speech](https://github.com/fishaudio/fish-speech),
[licence](https://raw.githubusercontent.com/fishaudio/fish-speech/main/LICENSE),
[hardware](https://raw.githubusercontent.com/fishaudio/fish-speech/main/docs/en/install.md),
[agent SDK](https://github.com/fishaudio/fish-agent-sdk-web),
[TTS API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech.md),
[live TTS](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live.md),
[realtime STT](https://docs.fish.audio/features/speech-to-text/realtime.md),
[models](https://docs.fish.audio/developer-guide/models-pricing/models-overview.md),
[pricing and limits](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.md),
[Agents overview](https://docs.fish.audio/agents/overview.md),
[voice and language](https://docs.fish.audio/agents/build/voice-language.md),
[BYO SIP](https://docs.fish.audio/agents/telephony/byo-sip),
[phone numbers](https://docs.fish.audio/agents/telephony/phone-numbers.md),
[custom LLM](https://docs.fish.audio/agents/build/custom-llm.md),
[S2-Pro weights](https://huggingface.co/fishaudio/s2-pro),
[terms](https://fish.audio/terms), [privacy](https://fish.audio/privacy),
[enterprise](https://fish.audio/enterprise/), [plans](https://fish.audio/plan),
[status](https://status.fish.audio/).

**Other providers:** [Vapi pricing](https://vapi.ai/pricing),
[Vapi custom TTS](https://docs.vapi.ai/customization/custom-voices/custom-tts),
[Deepgram](https://deepgram.com/pricing), [Soniox](https://soniox.com/pricing),
[ElevenLabs](https://elevenlabs.io/pricing/api), [Cartesia](https://cartesia.ai/pricing),
[Azure regions](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions),
[Azure languages](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts),
[Google Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd),
[Twilio Finland](https://www.twilio.com/en-us/voice/pricing/fi),
[LiveKit](https://livekit.com/pricing), [Pipecat](https://github.com/pipecat-ai/pipecat),
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).

Not found: Fish's per-minute Agents rate, EU processing, a DPA, a training opt-out, S2.1-Pro's
language list, Telnyx's Finland rate, and any independent benchmark of Fish from Europe.
