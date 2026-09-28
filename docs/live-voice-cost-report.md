# Live voice conversation — cost report (first staging pilot)

Status: estimates for the first limited staging trial of PR #215. No paid provider call was made to
produce this report, and none of it is a hard dollar cap. What is enforced in code is **counts and
sizes** (turns, seconds, model calls, output tokens, characters). Dollar amounts follow from
those limits plus the assumptions stated below. Replace the estimates with measured usage after
the trial (section 9).

Prices were verified on **2026-09-28** against:

- Anthropic: <https://platform.claude.com/docs/en/about-claude/pricing>
- OpenAI: <https://developers.openai.com/api/docs/pricing>

## 1. The pilot limits used here

These are temporary staging pilot limits. They are not customer pricing or plan allowances.

| Limit (per organization, per Europe/Helsinki day unless noted) | Value                             |
| -------------------------------------------------------------- | --------------------------------- |
| Started live sessions                                          | 1 (not refunded when ended early) |
| Session length                                                 | 5 min                             |
| Accepted turns                                                 | 10 (per session and per day)      |
| Audio per turn                                                 | 30 s                              |
| Accepted audio                                                 | 300 s (5 min)                     |
| Concurrent sessions                                            | 1                                 |

## 2. What one accepted turn can call (audited in the code)

| Operation                     | Model / provider         | Per turn                                                               | Retries                                                       | Bound type                                                |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Transcription                 | `gpt-4o-mini-transcribe` | 1 call                                                                 | none (SDK `maxRetries: 0`, no app retry)                      | **strict**: ≤ 30 s of audio                               |
| Chat reply                    | `claude-sonnet-4-5`      | **≤ 2 model calls**                                                    | none (`maxAttempts: 1`, SDK `maxRetries: 0`)                  | **strict**: ≤ 400 output tokens per call → ≤ 800 per turn |
| Tool executions (read-only)   | —                        | ≤ 3                                                                    | —                                                             | **strict** count                                          |
| Query embeddings              | `text-embedding-3-small` | 1 for context retrieval + 1 per knowledge-base tool search (≤ 4)       | up to `AI_RETRY_MAX_ATTEMPTS` (default 3) on transient errors | count strict; cost negligible                             |
| Moderation (input and output) | `omni-moderation-latest` | 2                                                                      | as above                                                      | free                                                      |
| Conversation title            | `claude-haiku-4-5`       | once per **new** conversation                                          | as above                                                      | ≤ 64 output tokens; input ≤ 500 characters                |
| Rolling summary               | —                        | **none**: a voice turn uses the stored summary and never generates one | —                                                             | —                                                         |
| Reply speech                  | device speech synthesis  | —                                                                      | —                                                             | free                                                      |

Model resolution (verified in `src/server/ai/router.ts` and the chat route):

- A voice turn always uses `routeModel("chat")` = `claude-sonnet-4-5`.
- The conversation's pinned model and "deep" mode (`claude-opus-4-8`) are ignored for voice turns.
- There are no environment overrides.
- The router's OpenAI `fallbackModel()` is not used by the chat route (`src/server/ai/fallback.ts`
  is not imported anywhere).

Two model calls, exactly:

- The tool loop allows `maxToolRounds = 2` model calls.
- Tools requested by the **second** call are not executed; the loop ends.
- The **400-token limit applies per model call**, so one turn can produce up to 800 output tokens.
- Once cancellation is observed, no new model call or tool execution starts (see section 8).

## 3. Input size: what is strictly bounded and what isn't

Output tokens are strictly bounded by the provider (`max_tokens`). Input is bounded in
**characters or counts**, not tokens. The token count per character depends on language and
content: about 4 characters/token for English, about 2.5–3 for Finnish and Arabic, and
pathological text can come close to 1 character/token. So the token figures below are estimates
at a stated ratio, not guarantees.

| Part of each model call                            | Bound in code                                                                | Kind                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Voice system prompt (fi/en/ar), 3 tool definitions | measured 1,438–1,498 + 1,075 characters                                      | measured                       |
| Anthropic tool-use system prompt (Sonnet 4.5)      | 496 tokens                                                                   | provider fact                  |
| Organization instructions                          | ≤ 2,000 characters (settings validator)                                      | strict                         |
| Business DNA profile                               | ≤ ~33,700 characters across all fields (validators)                          | strict per field               |
| Business DNA services                              | ≤ ~2,400 characters each; **the number of services is not limited**          | not strictly bounded           |
| Knowledge-base context                             | ≤ 3 chunks, chunker target ~3,200 characters each                            | count strict; size is a target |
| History                                            | ≤ 12 messages × ≤ 2,000 characters (longer messages are cut)                 | strict                         |
| Stored rolling summary                             | ≤ 1,024 tokens (generated by Haiku with `max_tokens` 1024)                   | strict                         |
| Spoken message                                     | the exact transcript of ≤ 30 s speech (validator hard cap: 8,000 characters) | strict                         |
| Second call only: tool results                     | ≤ 3 × 4,000 characters (longer results are cut)                              | strict                         |

## 4. Per-turn scenarios (Sonnet 4.5: $3 / $15 per 1M input/output tokens)

**Typical scenarios** (Finnish at ~3 characters/token):

| Turn type                                  | Input tokens | Output tokens | Input $ | Output $ | Total $   |
| ------------------------------------------ | ------------ | ------------- | ------- | -------- | --------- |
| Light: no knowledge-base hit, no tool      | ~2,400       | ~100          | 0.0072  | 0.0015   | **0.009** |
| Typical: 3 knowledge chunks, no tool       | ~4,800       | ~120          | 0.0144  | 0.0018   | **0.016** |
| Heavy: knowledge + one tool call (2 calls) | ~12,400      | ~460          | 0.0372  | 0.0069   | **0.044** |

**Conservative bound for the pilot organization.** Every capped input is at its cap, the
estimate uses a pessimistic 2.5 characters/token, and both model calls are used at 400 output
tokens. Business DNA and instructions are assumed to total 14,000 characters (a fully written
profile). A 30-second transcript is taken as ≤ 1,000 characters.

- Call 1: 51,400 characters ≈ 20,600 tokens + 496 (tool prompt) + 1,024 (summary) ≈ **22,100
  input tokens**.
- Call 2: call 1 + ≤ 400 tokens of tool requests + 12,000 characters of tool results (≈ 4,800
  tokens) ≈ **27,300 input tokens**.
- Per turn: ≈ **49,400 input + 800 output tokens ≈ $0.148 + $0.012 = $0.16**. Add transcription
  ≤ $0.0015.

Sensitivity:

- Each additional 10,000 characters of Business DNA adds ≈ 4,000 input tokens to **each** call,
  i.e. ≈ +$0.024 per turn.
- At the Business DNA schema maximum (all profile fields full plus the 2,000-character
  instructions) the bound is ≈ **$0.21 per turn**, plus ≈ $0.006 per fully written service.

## 5. A representative 5-minute pilot conversation

About 24 s per turn cycle (speech, end-of-turn silence, transcription, generation, spoken reply)
allows up to about 12 turns, but the pilot caps the session at **10 turns**. Mix: 7 typical, 2
light, 1 heavy.

| Line                                  | Quantity          | Cost        |
| ------------------------------------- | ----------------- | ----------- |
| Transcription                         | 10 × ~9 s = ~90 s | $0.0045     |
| Chat input (Sonnet 4.5)               | ~50,800 tokens    | $0.152      |
| Chat output (Sonnet 4.5)              | ~1,500 tokens     | $0.023      |
| Title (new chat only)                 | 1 Haiku call      | < $0.001    |
| Embeddings, moderation, device speech | —                 | ≈ $0        |
| **Total**                             |                   | **≈ $0.18** |

## 6. Pilot maximum day (one organization)

| Line                    | Typical (10 typical turns) | Realistic heavy (10 heavy turns) | Conservative bound (section 4)                          |
| ----------------------- | -------------------------- | -------------------------------- | ------------------------------------------------------- |
| Transcription (≤ 300 s) | $0.005                     | $0.005                           | ≤ $0.015                                                |
| Chat input              | 48,000 tokens → $0.144     | 124,000 → $0.372                 | 494,000 → $1.48                                         |
| Chat output             | 1,430 tokens → $0.021      | 4,600 → $0.069                   | 8,000 → $0.12                                           |
| Title                   | < $0.001                   | < $0.001                         | < $0.001                                                |
| **Total per day**       | **≈ $0.17**                | **≈ $0.45**                      | **≈ $1.62** (≈ $2.1 at the Business DNA schema maximum) |

## 7. Monthly scenarios (one pilot organization; at most one session per day)

Blended typical turn ≈ 4,800 input + 143 output tokens + 9 s audio ≈ $0.017.

| Scenario              | Usage                             | Turns | Transcription | Chat input | Chat output | **Month**   |
| --------------------- | --------------------------------- | ----- | ------------- | ---------- | ----------- | ----------- |
| Light                 | 2 sessions/week × 5 turns         | ~43   | $0.02         | $0.62      | $0.09       | **≈ $0.73** |
| Moderate              | 1 session per workday × 8 turns   | ~176  | $0.08         | $2.53      | $0.37       | **≈ $2.99** |
| Heavy (typical turns) | the daily cap every day (30 × 10) | 300   | $0.14         | $4.32      | $0.64       | **≈ $5.10** |
| Heavy (heavy turns)   | 30 × 10 heavy turns               | 300   | $0.14         | $11.16     | $2.07       | **≈ $13.4** |
| Conservative bound    | 30 × the conservative day         | 300   | $0.45         | $44.5      | $3.60       | **≈ $48.5** |

### Why the earlier heavy-month and maximum-day figures looked inconsistent

The previous version of this report showed a heavy month of ≈ $11.22 but a maximum day of
≈ $8.78. They were different quantities, not a contradiction:

- **Heavy month:** the _typical_ per-turn cost ($0.017) × 30 turns × 22 workdays.
- **Maximum day:** a _theoretical ceiling_ per turn ($0.29) × 30 turns. That ceiling assumed
  12 history messages at their unclipped maximum (8,000-character user messages and
  4,096-token typed replies) and unclipped tool results.

Multiplying that ceiling day by 30 would have given ≈ $263 per month. Since then:

- history is clipped to 2,000 characters per message, tool results to 4,000 characters, and tool
  executions to 3;
- voice turns never trigger a paid summary;
- the pilot allows 10 turns and one session per day.

The conservative bound is now ≈ $0.16 per turn and ≈ $1.62 per day for the pilot organization.

### Pricing worksheet — scenarios only

This worksheet is not a pricing proposal. It changes no Stripe product, published price or
customer plan. Price = cost / (1 − margin).

| Monthly cost scenario        | 60% margin | 70% margin | 80% margin |
| ---------------------------- | ---------- | ---------- | ---------- |
| Light ($0.73)                | $1.83      | $2.43      | $3.65      |
| Moderate ($2.99)             | $7.48      | $9.97      | $14.95     |
| Heavy, typical turns ($5.10) | $12.75     | $17.00     | $25.50     |
| Heavy, heavy turns ($13.4)   | $33.50     | $44.67     | $67.00     |

## 8. Not included

- VAT, payment fees, and infrastructure: Vercel, Supabase, Upstash Redis commands.
- Provider work billed but not reported back. A model call that was **in flight when the user
  pressed End** may still be billed by Anthropic: cancellation stops further calls and tool
  executions, but cannot reverse a call already processing. Completed calls are recorded, with
  `aborted: true`.
- Retries of embeddings, moderation (free) and title generation on transient errors. These are
  small and are not modelled.
- Typed chat usage, dictation, and other product AI usage.
- Tokenizer variance beyond the stated characters/token ratios, and any future price changes.
- Prompt caching: not used by the code. It would lower chat input cost.

## 9. How to validate on staging

1. After activation (a separate, approved step), run the pilot for a few days.
2. Compare the recorded `AI_TOKENS_IN` / `AI_TOKENS_OUT` usage rows for voice turns (and the
   `aborted: true` rows) with section 4, and the reserved audio seconds with section 6.
3. Replace the character-based estimates with the measured per-turn averages.

## Alternatives (documentation only; nothing enabled)

- **Provider TTS for devices without a voice in the language:**
  - `gpt-4o-mini-tts`: $0.60 per 1M text tokens in, $12 per 1M audio tokens out.
  - `tts-1`: $15 per 1M characters. That is ≈ $0.0075 per 500-character reply, ≈ $0.075 per
    10-turn session.
  - Either one adds a paid service and needs separate approval.
- **Realtime speech-to-speech:** not recommended for this pilot. It needs a browser-held
  provider stream. The pricing is per audio token, and the per-minute conversion was not verified,
  so no per-minute figure is claimed.
