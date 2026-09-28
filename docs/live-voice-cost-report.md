# Live voice conversation — cost report (pilot)

Status: estimate for the staging pilot of PR #215. Prices were verified on 2026-09-28 (Anthropic) and
in 2026-09 (OpenAI). Token counts are **estimates from measured prompt sizes**, not provider-billed
usage. No paid provider call was made to produce this report. Before relying on these numbers
commercially, compare them with real usage from the pilot (see "How to validate" at the end).

## 1. What a live turn actually calls

The feature is a hands-free **sequential** pipeline, not speech-to-speech. Per accepted spoken turn:

| Step                        | Provider / model                                       | Paid?                   | Bound in code                                                                |
| --------------------------- | ------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| Transcription               | OpenAI `gpt-4o-mini-transcribe`                        | yes                     | 1 attempt; ≤ 30 s/turn; ≤ 600 s/org/day; ≤ 30 turns/org/day                  |
| Moderation (in and out)     | OpenAI moderation                                      | free                    | —                                                                            |
| Query embedding (RAG)       | OpenAI `text-embedding-3-small`                        | yes, negligible         | 1 query per turn                                                             |
| Chat reply                  | Anthropic `claude-sonnet-4-5` (`routeModel("chat")`)   | yes — **the main cost** | exactly 1 generation per grant; ≤ 400 output tokens; ≤ 2 rounds; no retries  |
| Rolling summary (sometimes) | Anthropic `claude-haiku-4-5` (`routeModel("summary")`) | yes                     | only when the conversation exceeds 40 messages; at most once per 20 messages |
| Reply speech                | Browser/device speech synthesis                        | free                    | —                                                                            |

A voice turn always uses the standard chat model. The conversation's pinned model and "deep" mode
(`claude-opus-4-8`) are ignored for voice turns. The code does not use prompt caching, so every
input token is billed at the base rate.

## 2. Verified prices

| Item                                      | Price                                    | Source                                           |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `claude-sonnet-4-5` input / output        | $3 / $15 per 1M tokens                   | platform.claude.com/docs/en/about-claude/pricing |
| Tool-use system prompt, Sonnet 4.5 (auto) | +496 input tokens per request with tools | same page, "Tool use pricing"                    |
| `claude-haiku-4-5` input / output         | $1 / $5 per 1M tokens                    | same page                                        |
| `claude-opus-4-8` (not used by voice)     | $5 / $25 per 1M tokens                   | same page                                        |
| `gpt-4o-mini-transcribe`                  | $0.003 per audio minute                  | OpenAI API pricing page                          |
| `text-embedding-3-small`                  | $0.02 per 1M tokens                      | OpenAI API pricing page                          |
| OpenAI moderation                         | free                                     | OpenAI API pricing page                          |

For reference only (not used): `claude-sonnet-5` is listed at $2 / $10 per 1M tokens. Switching the
chat model is a separate product decision and is not part of this PR.

## 3. Measured prompt sizes and token assumptions

Measured from the code on this branch (`buildSystemPrompt`, `anthropicToolsFor`):

| Part                                       | Measured size                  | Tokens (estimate) |
| ------------------------------------------ | ------------------------------ | ----------------- |
| Voice system prompt (fi/en/ar, no DNA/RAG) | 1,438–1,498 characters         | ~500              |
| 3 read-only tool definitions (JSON)        | 1,075 characters               | ~300              |
| Tool-use system prompt (Anthropic)         | —                              | 496 (verified)    |
| Business DNA context                       | varies by organization         | assumed 300–1,200 |
| RAG context                                | 0–3 chunks × ~3,200 characters | 0–2,400           |
| History                                    | last 12 messages               | see below         |
| Rolling summary                            | only after 40 messages         | 0–~1,000          |

Assumptions (explicit):

- Tokens are estimated at ~3 characters/token for Finnish and Arabic and ~4 for English. The report
  uses the more expensive 3 characters/token everywhere.
- A typical spoken turn is ~8 s of speech (≈ 20–25 words, ~50 tokens). The limit is 30 s.
- A typical spoken reply is 80–150 output tokens (2–3 sentences). The limit is 400.
- History in a voice-only conversation: 12 messages ≈ 6 × (50 + 120) ≈ 1,000 tokens.
- The knowledge-base search tool, when called, returns up to 5 chunks (~4,000 tokens) into round 2.

### Per-turn scenarios (chat reply only)

| Turn type                                         | Input tokens | Output tokens | Input $ | Output $ | Total $   |
| ------------------------------------------------- | ------------ | ------------- | ------- | -------- | --------- |
| Light: no knowledge base hit, no tool             | ~2,400       | ~100          | 0.0072  | 0.0015   | **0.009** |
| Typical: 3 RAG chunks, no tool                    | ~4,800       | ~120          | 0.0144  | 0.0018   | **0.016** |
| Heavy: RAG + one tool call (2 rounds), full reply | ~15,100      | ~460          | 0.0453  | 0.0069   | **0.052** |
| Theoretical ceiling (see below)                   | ~94,000      | ~460          | 0.282   | 0.0069   | **0.29**  |

The ceiling assumes the last 12 messages are earlier **typed** messages at their maximum size
(user 8,000 characters, assistant 4,096 tokens), 3 RAG chunks, two rounds, and the knowledge-base
tool result in round 2. Voice-only conversations cannot reach it: their own messages are bounded by
30 s of speech and 400 output tokens.

Transcription per turn: 8 s ≈ $0.0004. At the maximum turn length, 30 s = $0.0015.

## 4. A representative 5-minute conversation

Assumed turn cycle: ~8 s speech + 1.2 s end-of-turn silence + ~1.5 s transcription + ~3 s reply
generation + ~10 s spoken reply ≈ 24 s. That gives **~12 turns in 5 minutes** (the session cap is 20).
Mix: 8 typical, 3 light, 1 heavy.

| Line                      | Quantity                     | Cost                             |
| ------------------------- | ---------------------------- | -------------------------------- |
| Transcription             | 12 × ~9 s = ~108 s (1.8 min) | $0.0054                          |
| Chat input (Sonnet 4.5)   | ~57,600 tokens               | $0.1728                          |
| Chat output (Sonnet 4.5)  | ~1,720 tokens                | $0.0258                          |
| Embeddings                | ~12 × 50 tokens              | < $0.0001                        |
| Moderation, device speech | —                            | $0                               |
| **Total**                 |                              | **≈ $0.20** (≈ $0.04 per minute) |

Chat input is ~85% of the cost. Transcription is under 3%.

## 5. Pilot maximum day (hard limits)

Per organization per Europe/Helsinki day: 30 turns, 600 s of audio, and 1 concurrent session (5 minutes, 20 turns).

| Line                               | Realistic heavy day (30 heavy turns) | Theoretical ceiling (30 ceiling turns) |
| ---------------------------------- | ------------------------------------ | -------------------------------------- |
| Transcription (≤ 600 s, hard)      | ≤ $0.03                              | $0.03                                  |
| Chat input                         | 30 × 15,100 = 453k tokens → $1.36    | 30 × 94k = 2.82M tokens → $8.46        |
| Chat output                        | 30 × 460 = 13.8k tokens → $0.21      | 13.8k tokens → $0.21                   |
| Rolling summaries (Haiku, ≤ 3/day) | ≤ $0.08                              | ≤ $0.08                                |
| **Total per organization per day** | **≈ $1.68**                          | **≈ $8.78**                            |

The transcription part is a hard dollar cap. The chat part is bounded by the turn count, output tokens,
rounds, history, RAG size and retries (all enforced in code), but it is **not** a dollar cap: its input
size depends on conversation history and knowledge-base content.

## 6. Monthly usage scenarios (one pilot organization, one user)

Blended per turn (from the 5-minute mix): ~4,800 input + ~143 output tokens + ~9 s audio
≈ $0.0144 + $0.0021 + $0.00045 ≈ **$0.017 per turn**.

| Scenario | Usage                                  | Turns/month | Transcription | Chat input | Chat output | **Total/month** |
| -------- | -------------------------------------- | ----------- | ------------- | ---------- | ----------- | --------------- |
| Light    | 2 short conversations/week (6 turns)   | ~48         | $0.02         | $0.69      | $0.10       | **≈ $0.81**     |
| Moderate | ~1 conversation per workday (10 turns) | ~200        | $0.09         | $2.88      | $0.43       | **≈ $3.40**     |
| Heavy    | daily cap on every workday (30 × 22)   | ~660        | $0.30         | $9.50      | $1.42       | **≈ $11.22**    |
| Ceiling  | theoretical daily ceiling × 30 days    | 900         | $0.90         | $253.80    | $6.21       | **≈ $263**      |

The ceiling row is shown so the worst case is visible. It is not an expected outcome.

## 7. Pricing worksheet — scenarios only

This worksheet is **not a pricing proposal**. It changes no Stripe product, published price or
customer plan. It only shows what a price per user would need to cover at different gross margins.

| Scenario (cost/month) | 60% margin | 70% margin | 80% margin |
| --------------------- | ---------- | ---------- | ---------- |
| Light ($0.81)         | $2.03      | $2.70      | $4.05      |
| Moderate ($3.40)      | $8.50      | $11.33     | $17.00     |
| Heavy ($11.22)        | $28.05     | $37.40     | $56.10     |

Formula: price = cost / (1 − margin). These figures do not include VAT, payment fees or
infrastructure costs. The organization's existing monthly AI-message quota also counts voice turns,
because each voice turn is a normal chat message.

## 8. Alternatives (documentation only, none enabled)

- **Provider TTS instead of device voices** (for devices without a voice in the user's language):
  - `gpt-4o-mini-tts`: $0.60 per 1M text input tokens, $12 per 1M audio output tokens.
  - `tts-1`: $15 per 1M characters. A ~500-character reply costs ≈ $0.0075, i.e. ≈ $0.09 more per
    5-minute conversation.
  - It would add a paid service and audio streaming to the client, and needs separate approval.
- **Realtime speech-to-speech**:
  - `gpt-realtime`: $32 / $64 per 1M audio input/output tokens; `gpt-realtime-mini`: $10 / $20.
  - The per-minute cost depends on audio tokenization, which is not verified here, so no per-minute
    number is claimed.
  - It would also need a provider stream held open by the browser. The pilot deliberately avoids this
    (see the checklist: "Why no realtime provider session").
- **Prompt caching** of the system prompt and tool definitions could lower chat input cost. It is not
  implemented, and it's a separate change.

## 9. How to validate these numbers on staging

1. Run the manual pilot on staging (after approval) for a few 5-minute conversations.
2. Compare them with the `tokensIn` and `tokensOut` recorded for each assistant message (voice turns
   are logged as normal chat usage), and with the transcription seconds reserved per day.
3. Update sections 3–6 with the measured per-turn input/output averages. The measured averages
   replace the character-based estimates.
