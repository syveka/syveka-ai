# Voice provider comparison

For engineers and the owner deciding how Syveka's voice stack should evolve. Audited against code
on `origin/main` at `40f71ae7` on 2026-11-05. "Implemented" means the code exists and has mocked
tests. **The repo holds no evidence from a real phone call**, so nothing here measures live quality
or latency.

**Recommendation: keep Vapi (Option A), baseline it on real calls, and treat every other option as
a later decision.** A cheaper LLM is the only change with a clear benefit and almost no migration.

## What exists today

| Component             | Status                             | Evidence                                                                                                                                         |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vapi assistant config | IMPLEMENTED                        | `src/server/integrations/vapi.ts:96-145`, sync at `src/server/services/voice.ts:318-363`                                                         |
| Vapi webhook and HMAC | IMPLEMENTED                        | `src/app/api/v1/voice/webhook/route.ts:312-316`, `vapi.ts:214-221`. The HMAC has no timestamp; replay guards compensate (`route.ts:374-384`)     |
| Soniox                | **MISSING**                        | No reference in code. Any plan that assumes it is out of date                                                                                    |
| Phone TTS             | IMPLEMENTED                        | Azure by locale (`vapi.ts:77-81`), ElevenLabs branch (`vapi.ts:131-133`)                                                                         |
| Voice choice in UI    | MISSING                            | `assistant-form.tsx` has no provider or voice field, so UI-created assistants use Azure (`validators/voice.ts:27`)                               |
| Phone STT             | IMPLEMENTED                        | Deepgram hardcoded: nova-2 for FI/EN, nova-3 for AR (`vapi.ts:89-93,134-138`)                                                                    |
| LLM on calls          | IMPLEMENTED                        | Vapi runs it with `routeModel("voice")` (`vapi.ts:121-127`, `src/server/ai/router.ts:37`). There is no custom-LLM endpoint                       |
| Inbound telephony     | PARTIAL                            | Twilio and SIP import (`vapi.ts:191-211`). Buying a number requests +358 from a pool the code itself calls US-only (`services/voice.ts:109-118`) |
| Outbound calling      | MISSING                            | `vapi.ts` calls only `/assistant` and `/phone-number`                                                                                            |
| Browser dictation     | EXPERIMENTAL                       | `src/app/api/v1/ai/transcribe/route.ts`, flag and allowlist (`:62-64`)                                                                           |
| Browser live voice    | EXPERIMENTAL                       | `src/app/api/v1/ai/voice-conversation/`. OpenAI STT, the device's own speech synthesis, read-only tools. Off by default                          |
| CRM during calls      | PARTIAL                            | `createContact` and `logActivity` only (`validators/voice.ts:9-14`). No caller context before the call (`route.ts:333,561`)                      |
| Booking tool          | IMPLEMENTED                        | `bookMeeting` (`tools/index.ts:473-594`): offered slots only, org lock, audit, 2 per call (`route.ts:96-100`)                                    |
| Calendar tool         | IMPLEMENTED                        | `getCalendarAvailability` (`tools/index.ts:384`). External-calendar sync on this path is unverified                                              |
| Post-call workflow    | IMPLEMENTED                        | `src/app/api/v1/jobs/post-call/route.ts:98-325`, idempotent. Arabic calls get an English summary (`:214-216`)                                    |
| Usage metering        | IMPLEMENTED phone, PARTIAL browser | `VOICE_MINUTES`, rounded up (`post-call/route.ts:112-125`). Browser: `API_CALLS` plus Redis budgets                                              |
| Billing and limits    | PARTIAL                            | Plans: 0, 100, 500 minutes, Enterprise unlimited (`src/lib/billing/plan-catalog.ts`). No overage billing. Parallel calls can overshoot           |
| Tenant authorization  | IMPLEMENTED                        | Signed `assistantId` → DB row → org (`route.ts:104-123,328-330`). Browser: `getTenantContext`. Admin: `requirePermission("voice:configure")`     |
| Rate limiting         | PARTIAL                            | The webhook has HMAC and per-call caps but no limiter (`route.ts:61,96-100`). Browser routes are limited                                         |
| Tests                 | IMPLEMENTED                        | 42 voice-related unit test files. All mocked                                                                                                     |

**There is no provider abstraction for voice.** A new phone TTS means widening an enum
(`validators/voice.ts:27`) and adding a branch (`vapi.ts:130-133`). The tool execution logic is also
tangled with Vapi's request shape in the webhook route, so any move off Vapi starts by extracting it.

### Problems the audit found

None is fixed here, since they are outside this task's scope.

- Arabic assistants get the AI-disclosure text in English (`services/voice.ts:326-329`). Draft #335
  addresses disclosure; confirm that it covers Arabic.
- `sipUri` is sent to Vapi as `credentialId` (`vapi.ts:204-209`). This looks like a mismatch and is
  inferred, not checked against Vapi's API. It could block non-Twilio +358 numbers.
- An ElevenLabs assistant with no voice id sends an empty id (`vapi.ts:132`).
- Voice prompt text is hardcoded (`services/voice.ts:326-329`, `post-call/route.ts:214`), which
  conflicts with charter §7.
- Quota is checked only at call start and on tool calls, so the 900-second maximum is the only other
  bound during a call.

## The options

Latency and quality are **untested for every option**.

| Criterion         | A: Keep current                  | B: Vapi + Fish TTS                    | C: Fish Agent SDK in browser                     | D: Self-host Fish Speech                     | E: LiveKit + best of breed          |
| ----------------- | -------------------------------- | ------------------------------------- | ------------------------------------------------ | -------------------------------------------- | ----------------------------------- |
| Fish's part       | None                             | One of five parts of a call           | Whole agent, hosted by Fish                      | TTS only, on our GPUs                        | None by default                     |
| Telephony         | Vapi; +358 by import             | Unchanged                             | Browser; a phone line needs BYO SIP, costed here | Unchanged                                    | Ours to run                         |
| Tools, CRM        | Implemented, with caps           | Unchanged                             | Rebuild against Fish webhooks                    | Unchanged                                    | Rebuild in-process                  |
| New failure point | None                             | Our TTS server, on every call's audio | Beta platform                                    | Our GPU fleet                                | Everything                          |
| $/min (est.)      | $0.0883                          | $0.0887 FI, $0.0928 AR                | $0.0707, promotional                             | $0.0829 + GPUs                               | $0.0473                             |
| 10,000 min/mo     | $978                             | $982–$1,023                           | $773                                             | $2,482                                       | $589 + build cost                   |
| GDPR              | Sub-processor list is incomplete | **Blocked** as published              | **Blocked**, transcripts kept                    | Best, if the licence clears                  | Good; regions selectable            |
| Licence           | Standard API terms               | API terms                             | Beta terms; SDK is MIT                           | **Blocked**: separate licence or revenue cap | Apache-2.0, BSD-2-Clause frameworks |
| Effort            | None                             | 1–2 weeks after the gates             | Weeks; a new product surface                     | High, ongoing                                | 8–12 engineer-weeks (estimate)      |

Figures come from
[docs/research/voice-and-video-cost-analysis.md](../research/voice-and-video-cost-analysis.md), where
that document is present on the branch you are reading; otherwise see draft PR 3 from the same run.

### Why not the others

- **B.** Fish could only win on how it sounds, and nobody has listened. It costs slightly more than
  Azure, and Azure lists 16 Arabic locales where Fish lists no dialects. If a listening test favours
  Fish and the data gates clear, this is the right shape: Vapi's custom voice route sends text and
  expects raw 16-bit PCM at 8, 16, 22.05 or 24 kHz. Fish lists no 22.05 kHz output, so the adapter must
  resample that case.
- **C.** It isn't a replacement for phone calls: it does not cover telephony without BYO SIP, and it
  sends call content to a US-hosted beta platform that keeps transcripts by default. Its low price is
  promotional.
- **D.** Loses at every volume here: a 24 GB GPU fits only the S2-Pro minimum, and a redundant pair
  costs $1,558 a month against about $556–$972 of Fish API TTS at 100,000 minutes. The licence blocks
  it before cost matters.
- **E.** The only option that moves the biggest cost, since Vapi's fee is 57% of a call. It doesn't
  pay back at today's volumes. Revisit at a sustained 100,000 minutes a month. Soniox would be new, and
  its EU processing status wasn't found on the pages read.

## Order of work

1. Baseline real +358 calls in FI, AR and EN. Without this, no provider comparison means anything.
2. Fix what the audit found: the Arabic notice and the sub-processor list first.
3. Test whether Vapi accepts Haiku 5.5. At list price this saves about $0.0117 a minute, with no
   migration, if it holds up on calls.
4. Extract the webhook's tool execution into a shared service. Every future option needs this.
5. Run the blind listening test on synthetic text, including Fish, before 2026-11-30 if you want its
   free model.
