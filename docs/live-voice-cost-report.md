# Live voice conversation — cost report (first staging pilot)

Estimates for the first limited staging trial of PR #215. No paid provider call was made to produce
this report.

Prices were verified on **2026-09-28** against the official pages:

- Anthropic: <https://platform.claude.com/docs/en/about-claude/pricing>
- OpenAI: <https://developers.openai.com/api/docs/pricing>

This report uses three kinds of number. Only the first two exist today.

| Kind                             | Meaning                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Typical estimate**             | Expected usage, from measured prompt sizes and assumed conversation patterns.                                                         |
| **Conservative calculated cost** | The most the code allows under its enforced limits, plus the stated assumptions (section 5). This is arithmetic, not an enforced cap. |
| **Enforced monetary budget**     | A hard dollar limit checked at runtime. **This implementation has none.** The code enforces counts and sizes only.                    |

## 1. Pilot limits (defaults; temporary; not plan allowances)

Per organization, per Europe/Helsinki day:

- 1 started session (not refunded if ended early);
- 5 minutes per session;
- 10 accepted turns;
- 30 s per turn;
- 300 s of accepted audio;
- 1 concurrent session.

Only the approved QA organization and user are on the allowlist.

## 2. Every paid operation reachable from a live session

| Operation                                               | When                                                                                 | Requests per occurrence                                  | Retries                                                                                                   | Continues after End?                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Transcription (`gpt-4o-mini-transcribe`)                | once per accepted turn                                                               | **exactly 1**                                            | **none**: SDK `maxRetries: 0`, no application retry; 30 s timeout                                         | Aborted with the request, but a request already sent may still be billed. The turn stays reserved.          |
| Chat reply (`claude-sonnet-4-5`)                        | once per accepted turn (single-use grant)                                            | **≤ 2 model calls**                                      | **none**: SDK `maxRetries: 0` and `maxAttempts: 1`                                                        | The HTTP stream is aborted and no further call or tool starts, but a call already sent may still be billed. |
| Retrieval embedding (`text-embedding-3-small`)          | once per chat reply (the transcript is the query)                                    | 1                                                        | **yes**: up to `AI_RETRY_MAX_ATTEMPTS` on transient errors (default 3; the environment schema allows 1–6) | Aborted with the request                                                                                    |
| Knowledge-base tool embedding                           | per `searchKnowledgeBase` execution (≤ 3 tool executions per reply)                  | 1                                                        | **yes**: same setting                                                                                     | A search already running finishes (no abort signal); no new tool starts                                     |
| Conversation title (`claude-haiku-4-5`)                 | once per **new** conversation, **after** its first reply completes (fire-and-forget) | 1                                                        | **yes**: up to `AI_RETRY_MAX_ATTEMPTS`                                                                    | Runs to completion (no abort signal); only starts after a completed reply                                   |
| Moderation (`omni-moderation-latest`), input and output | per chat reply                                                                       | 2                                                        | yes                                                                                                       | free                                                                                                        |
| Rolling summary                                         | —                                                                                    | **never** in a voice turn (the stored summary is reused) | —                                                                                                         | —                                                                                                           |
| Reply speech                                            | device speech synthesis                                                              | —                                                        | —                                                                                                         | free                                                                                                        |

Work after a reply finishes streaming:

- output moderation (free);
- database writes and usage recording;
- for a new conversation only, title generation.

Nothing else is triggered.

**End pressed while a request is in flight.** That request is not an extra request. It is one of the
≤ 2 model calls of an accepted turn (or that turn's one transcription), and it is already counted
below. Completed model calls of an aborted reply are recorded in usage with `aborted: true`.

## 3. The enforced aggregate input budget (live mode only)

Before **every** live-voice model call (the first call and the tool round), the server computes an
**upper-bound estimate** of the whole request:

- the system instructions, organization instructions and Business DNA, including all services;
- the knowledge-base content and the rolling summary;
- the history and the current transcript;
- the tool definitions, and in the second call the tool requests and tool results;
- 496 tokens for Anthropic's tool-use system prompt, plus framing overheads.

How the estimate works:

- Every UTF-8 byte counts as one token. This assumes at most one token per byte, as byte-level BPE
  tokenizers give. It is **not an exact token count**, and Anthropic doesn't publish its tokenizer,
  so the route logs `voice_input_bound_exceeded` whenever the provider-reported input tokens are
  higher.
- In practice the estimate over-counts about 3–4× for English and Finnish, and less for Arabic.

The limits:

- **No call may exceed 48,000 estimated tokens.** A call that would exceed it is not made.
- The first call is planned to 30,000 so the tool round fits.

To fit, the server leaves out optional context **whole**, in this fixed order:

1. oldest history (the kept history starts with a user turn);
2. the rolling summary;
3. the lowest-ranked knowledge chunks;
4. Business DNA services, last first;
5. the rest of Business DNA;
6. organization instructions.

Content that is never reduced: the persona and rules, the organization name, the tool section, the
live-voice rules, the tool definitions and the transcript. Tool results are fitted **structurally**
to ≤ 4,000 bytes. They stay valid JSON: trailing items are left out with a count, and over-long text
fields are shortened. Tool requests and their results are never split.

If the required content alone can't fit, the turn is refused **before the model call** with
`voice_context_too_large`. The message is localized (EN/FI/AR) and suggests the typed chat. Typed
chat and all stored data are unchanged.

## 4. Typical estimate (Sonnet 4.5: $3 / $15 per 1M input/output tokens)

Assumes about 3 characters per token for Finnish.

| Turn type                             | Input tokens | Output tokens | Cost   |
| ------------------------------------- | ------------ | ------------- | ------ |
| Light (no knowledge hit, no tool)     | ~2,400       | ~100          | $0.009 |
| Typical (3 knowledge chunks)          | ~4,800       | ~120          | $0.016 |
| Heavy (knowledge + one tool, 2 calls) | ~12,400      | ~460          | $0.044 |

**A full pilot day** is 10 turns: 7 typical, 2 light and 1 heavy.

| Line                                     | Quantity       | Cost                |
| ---------------------------------------- | -------------- | ------------------- |
| Transcription                            | ~90 s          | ≈ $0.0045           |
| Chat input                               | ~50,800 tokens | $0.152              |
| Chat output                              | ~1,500 tokens  | $0.023              |
| Embeddings, moderation, title (new chat) | —              | < $0.001            |
| **Total**                                |                | **≈ $0.18 per day** |

**Monthly:**

| Usage                                     | Cost    |
| ----------------------------------------- | ------- |
| Light (2 sessions/week, 5 turns)          | ≈ $0.73 |
| Moderate (1 session per workday, 8 turns) | ≈ $2.99 |
| Heavy (every day at the cap)              | ≈ $5.10 |

Transcription uses OpenAI's published estimate of $0.003 per minute. It is **billed per token**
($1.25 per 1M input, $5 per 1M output), so the per-minute figure is an estimate, not a billing
guarantee.

## 5. Conservative calculated cost (not an enforced cap)

Assumptions:

- the byte-based token bound holds;
- `AI_RETRY_MAX_ATTEMPTS` is at its schema maximum of 6;
- every retryable call fails transiently until its last attempt, and every failed attempt is billed;
- prices don't change.

Per accepted turn:

| Line          | Calculation                                                                                                                                                                           | Cost      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Chat input    | 2 calls × 48,000 = 96,000 tokens × $3/1M                                                                                                                                              | $0.288    |
| Chat output   | 2 calls × 400 = 800 tokens × $15/1M                                                                                                                                                   | $0.012    |
| Transcription | ≤ 30 s at ≈ $0.003/min (estimate; see section 4)                                                                                                                                      | ≈ $0.0015 |
| Embeddings    | 4 operations × 6 attempts. Retrieval query ≤ 8,000 characters ≤ 32,000 bytes; each tool query ≤ 500 characters ≤ 2,000 bytes. So 6 × (32,000 + 3 × 2,000) = 228,000 tokens × $0.02/1M | $0.0046   |
| Moderation    | 2 × 6 attempts                                                                                                                                                                        | $0        |

Per pilot day (10 turns, 1 session):

| Line                                                                                      | Cost                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------ |
| Chat: 10 × $0.300                                                                         | $3.00                                |
| Transcription (≤ 300 s, estimate)                                                         | ≈ $0.015                             |
| Embeddings: 10 × $0.0046                                                                  | $0.046                               |
| Title: ≤ 1 new conversation × 6 attempts × (≤ 2,200 tokens in at $1/1M + 64 out at $5/1M) | $0.015                               |
| **Conservative total**                                                                    | **≈ $3.08 per organization per day** |

Over 30 days that is ≈ $92 per month.

The call in flight when End is pressed is already inside these figures, because each accepted turn
is counted with both model calls at full size.

The earlier "$1.62 per day" figure was lower because it assumed a fully written Business DNA of
14,000 characters. It didn't bound the number of services, and it didn't count ancillary retries.
The enforced budget now makes the bound independent of organization data.

## 6. Not included

- VAT, payment fees, and infrastructure (Vercel, Supabase, Upstash Redis commands).
- Typed chat, dictation and other product AI usage. That includes any summary a later typed message
  triggers in a conversation that started in voice.
- Price changes after 2026-09-28.
- If the byte-per-token assumption were ever wrong, the input bound would be too. That case is
  logged (`voice_input_bound_exceeded`), not prevented.

## 7. Pricing worksheet — scenarios only

Not a pricing proposal; no Stripe, price or plan changes. Price = monthly cost / (1 − margin).

| Monthly cost     | 60% margin | 70% margin | 80% margin |
| ---------------- | ---------- | ---------- | ---------- |
| Light ($0.73)    | $1.83      | $2.43      | $3.65      |
| Moderate ($2.99) | $7.48      | $9.97      | $14.95     |
| Heavy ($5.10)    | $12.75     | $17.00     | $25.50     |

## 8. How to validate on staging

After activation (a separate, approved step):

1. Compare the `AI_TOKENS_IN` / `AI_TOKENS_OUT` rows for voice turns (including the `aborted` and
   `stoppedBy` rows) with section 4.
2. Look for any `voice_context_reduced`, `voice_context_too_large` or `voice_input_bound_exceeded`
   log events. They carry counts only, never content.

## Alternatives (documentation only; nothing enabled)

- **Provider TTS for devices without a voice in the language:**
  - `gpt-4o-mini-tts`: $0.60 per 1M text tokens in, $12 per 1M audio tokens out.
  - `tts-1`: $15 per 1M characters. That is ≈ $0.075 per 10-turn session at 500 characters per
    reply.
  - Either one adds a paid service and needs separate approval.
- **Realtime speech-to-speech:** not recommended for this pilot. No per-minute figure is claimed.
