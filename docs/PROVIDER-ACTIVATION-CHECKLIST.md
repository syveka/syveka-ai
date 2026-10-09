# Provider Activation Checklist

Consolidated, per-provider manual setup for every external integration this app can use. This
document does not replace the deeper architecture docs already covering some of these providers
in detail — it cross-references them rather than duplicating their content, and adds the
providers that had no dedicated setup documentation at all (Resend/Inbox, Anthropic, OpenAI,
Upstash).

**No live verification of any provider below was performed while writing this checklist.**
Env-var names and validation behavior are read directly from `src/env.ts` (the fail-closed,
per-integration `getXEnv()` functions); webhook routes and URLs are read directly from the
`src/app/api/v1/**` route files that implement them. Where a checklist item requires an actual
external round-trip (a real inbound email, a real completed call, a real webhook delivery), it is
marked **manual verification required** — do not check it off without actually performing it.

For every provider, missing/invalid credentials fail closed: the specific `getXEnv()` function
throws a clear configuration error rather than silently defaulting, and unrelated integrations
are never coupled to it (see `src/env.ts`'s per-provider `pick()` schemas). A misconfigured
Stripe key cannot break Redis, and vice versa.

## 1. Supabase (database + auth)

**Required:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (pooled), `DIRECT_URL` (direct, for migrations).

- Create an EU-region Supabase project (data residency requirement — see `README.md`).
- Copy the pooled (pgbouncer, port 6543) and direct (port 5432) connection strings into
  `DATABASE_URL`/`DIRECT_URL` respectively — see `.env.example` for the exact format.
- Run `npx prisma migrate deploy` then `npx prisma migrate status`; see
  `docs/release-runbook.md` for the full migration-history/baseline explanation and required
  lexical order.
- Run the RLS isolation suites (`scripts/ci/run-rls-check.sh`, invoked in `ci.yml`/
  `staging-release.yml`) against the target database before considering it production-ready.
- [ ] **Manual verification required**: confirm `npx prisma migrate status` reports no pending
      migrations against the real target database.

## 2. Anthropic (primary AI provider)

**Required:** `ANTHROPIC_API_KEY`.

- Create an API key in the Anthropic Console. No webhook — outbound API calls only.
- Model routing (`src/server/ai/router.ts`) and retry policy
  (`AI_RETRY_MAX_ATTEMPTS`/`AI_RETRY_BASE_DELAY_MS`) are configured independently of the key
  itself.
- [ ] **Manual verification required**: trigger one real AI draft/chat/voice-tool call and confirm
      a real Anthropic response is returned (not the degraded fallback path).

## 3. OpenAI (secondary/embedding provider)

**Required:** `OPENAI_API_KEY`.

- Create an API key in the OpenAI dashboard. Used for embeddings/RAG and any explicitly-routed
  secondary model calls — see `docs/AI-RAG-AUDIT.md` for the RAG pipeline this feeds.
- [ ] **Manual verification required**: confirm a document ingestion / embedding job actually
      completes against the real API (not a mocked/skipped path).

### AI Chat voice input (staging pilot only; off by default)

**Enable with (staging only):** `AI_TRANSCRIPTION_ENABLED=1` **and**
`AI_TRANSCRIPTION_PILOT_ALLOWLIST="<organizationId>:<userId>"` (comma-separated UUID pairs), plus
the `OPENAI_API_KEY` above. Without the flag, with an empty or malformed allowlist, or with
invalid OpenAI configuration, nobody sees a microphone and `POST /api/v1/ai/transcribe` makes no
provider call. Production stays disabled.

- **Model:** `gpt-4o-mini-transcribe` (`TRANSCRIPTION_MODEL` in `src/server/integrations/openai.ts`),
  language auto-detected (FI/EN/AR). **One provider attempt per request:** no app-level retry and
  SDK `maxRetries: 0`.
- **Server-side checks, in order, all before the provider call:**
  1. same-origin browser request (`Sec-Fetch-Site`/`Origin`) → 403
  2. session → 401; `chat:use` → 403
  3. flag → 503; **pilot allowlist** (server-verified organization and user IDs) → 403
  4. short-window rate limits (20 / 10 min per user, 200 / 10 min per organization; fail closed,
     including Upstash's timeout-means-allow) → 429 / 503
  5. organization's monthly AI-message quota (read only) → 402
  6. upload ≤ 2 MiB → 413; accepted format and measurable duration → 415; **duration ≤ 60.0 s**
     → 422 `audio_too_long`
  7. **daily pilot attempt**: 10 per user and organization per Europe/Helsinki calendar day,
     reserved atomically in Redis (one Lua script: check, increment, expire) → 429
     `daily_limit_reached`; store error → 503. The reservation happens only after 1–6 pass and is
     never refunded: a started attempt counts even if it fails, times out or is cancelled.
- **Duration measurement** (`src/lib/voice/audio-duration.ts`) reads packet/frame metadata; it
  does **not** decode audio. Opus: each packet's TOC byte fixes its duration (RFC 6716). AAC:
  frames × 1024 samples at the AudioSpecificConfig rate. MP4 sample durations and a single edit
  are also considered; the longest figure wins, and header timestamps are never trusted to
  shorten it. Only WebM/Opus and MP4 (Opus/AAC) are accepted; laced or deprecated block types,
  extra tracks, multi-entry/empty edit lists, trailing data and truncation are refused. Every
  loop is bounded by the bytes behind it. Cross-checked against Chromium's decoder
  (`decodeAudioData`): identical or slightly higher on real recordings and on crafted files
  (e.g. 30 min of audio in 120 kB). OpenAI's own decoder was not available to test; corrupt
  packets could only make its output shorter than the estimate.
- **The browser** stops recording 0.75 s before 60 s so honest recordings stay under the server cap.
- **Cost bound for the pilot** (list price $0.003/min; verify current pricing): ≤ 10 attempts ×
  60 s = 10 audio-minutes ≈ **$0.03 per pilot user per Helsinki day**. The short-window rate
  limits and quota remain as additional guards.
- **Not a plan allowance:** the pilot cap is a temporary staging guard. It does not change
  customer plans, prices or production billing. The `API_CALLS` usage record
  (`metadata.kind = "ai_transcription"`, measured `audioSeconds`, `estimatedCostUsd`) is
  observability only. A general-availability spending policy (per-organization monthly budget,
  plan dependence, user message) is still a product decision.
- **Privacy:** audio is sent to OpenAI to produce the text (disclosed in the recording UI); audio
  and transcripts are not stored or logged by Syveka.
- [ ] **Manual verification required** (pilot account on a real phone): record one short FI, EN
      and AR message; confirm the transcript appears in the message box, is not sent
      automatically, one `API_CALLS` usage record is written per attempt, and the 11th attempt
      of the day shows the localized daily-limit message.

### AI Chat live voice conversation (separate pilot; off by default)

A hands-free **sequential** pipeline, not native speech-to-speech:

1. The browser detects the end of speech and uploads each finished turn.
2. The server reserves the turn, transcribes it (`gpt-4o-mini-transcribe`, one attempt) and returns
   the text with a **single-use grant**.
3. The client submits the text and grant to the normal `/api/v1/ai/chat` route. That route consumes
   the grant atomically — **one accepted turn allows at most one chat generation** — and answers in
   a bounded, read-only voice mode.
4. The device speaks the reply. Without a device voice for the interface language, the start
   screen offers text-only replies or dictation; it never uses another language's voice. Text-only
   is not a spoken conversation.

Live voice is independent of dictation: it has its own flag, allowlist, keys and budgets. The
dictation pilot and its 10-attempt daily cap are unchanged.

**Enable with (staging only, after separate approval):**

- `AI_VOICE_CONVERSATION_ENABLED=1`
- `AI_VOICE_CONVERSATION_PILOT_ALLOWLIST="<organizationId>:<userId>"` (the approved QA pair only)
- `OPENAI_API_KEY`

The limits below default to the first-trial values, so no limit variable needs to be set. A missing
or malformed flag or allowlist, or any invalid or out-of-range limit, disables the feature.

| Variable                                        | Default | Allowed range | Meaning (per organization, per Europe/Helsinki day unless noted) |
| ----------------------------------------------- | ------- | ------------- | ---------------------------------------------------------------- |
| `AI_VOICE_CONVERSATION_DAILY_ORG_SESSIONS`      | 1       | 1–200         | Successfully started sessions; not refunded                      |
| `AI_VOICE_CONVERSATION_SESSION_SECONDS`         | 300     | 60–1800       | Hard session lifetime                                            |
| `AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION`   | 10      | 1–200         | Accepted turns per session                                       |
| `AI_VOICE_CONVERSATION_DAILY_ORG_TURNS`         | 10      | 1–2000        | Accepted turns per day, across all sessions                      |
| `AI_VOICE_CONVERSATION_MAX_TURN_SECONDS`        | 30      | 5–60          | Longest accepted turn (measured server-side)                     |
| `AI_VOICE_CONVERSATION_DAILY_ORG_AUDIO_SECONDS` | 300     | 60–36000      | Accepted audio per day                                           |
| `AI_VOICE_CONVERSATION_MAX_CONCURRENT_PER_ORG`  | 1       | 1–20          | Concurrent live sessions (not per day)                           |

These are temporary pilot limits, not customer pricing or plan allowances.

**Session start** (`POST /api/v1/ai/voice-conversation/session`). Everything that can refuse the
request is checked before the day's session slot is used:

- same-origin, session, `chat:use`, flag and allowlist, valid limits;
- the shared voice rate limit (fails closed);
- **conversation access**: an existing conversation must be the user's own, in their organization
  and not deleted — the same rule as the chat route. A client-supplied id is never trusted without
  this check. For a new chat, the server reserves a random conversation id; the first accepted turn
  creates the conversation with that id. Ending without speaking leaves no empty conversation.
- then one atomic Lua script checks the daily sessions, audio and turns and the concurrency limit
  **before changing anything**, and only then takes the slot and creates the session. A refused
  start (for example from a second tab) leaves the user's running session untouched.

**When the daily session slot is used:** at a successful start. It is **not refunded** if the
session ends early, the page is reloaded or closed, the connection drops, or the user opens another
tab. With the pilot defaults, an interrupted session therefore uses up that day's live
conversation. Its accepted turns and audio also stay counted. The next session is possible after
Europe/Helsinki midnight. The start screen tells the user this before the microphone opens.

**Each turn** (`POST /api/v1/ai/voice-conversation/turn`), before any paid call:

- same-origin, session, permission, flag, allowlist, the rate limit, and the monthly AI-message
  quota (read only);
- size ≤ 2 MiB and measured duration ≤ 30 s;
- one atomic Lua reservation: session owner and expiry, the per-session turn cap, a duplicate turn
  id, and **both** daily budgets (turns and audio). Nothing is reserved on refusal. A retried request
  whose response was lost is refused as a duplicate, not reserved twice.
- A turn is **used** once reserved. It is not refunded on provider failure, timeout, cancel or an
  empty transcript.

**Allowance** (`GET /api/v1/ai/voice-conversation/session`, read-only). It reports the signed-in
organization's starts, turns and audio left for the Helsinki day, when they renew (next Helsinki
midnight, DST-aware), and the maximum session length. It accepts no identifiers: any query parameter
is refused (400), and the organization comes only from the server-verified session. Reading never
starts a session, reserves a turn or changes a counter or expiry. Start and turn responses carry the
same reading (for the turn: right after its reservation, including the session's own turn count),
and so do limit refusals. A reading that fails is returned as `null`, and the UI shows "unknown".

- **Refusals name their limit.** The code is unchanged for compatibility (`voice_daily_limit_reached`
  or `turn_limit`); `reason` is `daily_sessions`, `daily_turns`, `daily_audio` or `session_turns`.
  The UI shows a distinct message and, for daily limits, the Helsinki renewal time.
- **Last permitted turn.** When a reading shows no further turn can be accepted, the client lets
  that turn's reply finish. It doesn't interrupt the reply by voice or record another turn, and then
  ends the session with the reason. Stop reply, Mute and End still work. No upload is made that the
  server would refuse.
- **Self-echo guard.** This applies only in the listening phase, after a reply has ended or been
  stopped. While the device still reports speaking, and for 400 ms after, the microphone can't start
  a turn. During an ordinary reply the guard doesn't apply, and the user interrupts through
  echo-aware barge-in. Recordings shorter than 700 ms are never uploaded.
- **Diagnostics** (content-free structured logs):
  - `voice_conversation_turn` records each outcome (`rejected`, `refused` with its reason,
    `reserved`, `transcribed`, `empty_transcript`, `transcription_failed`/`aborted`). It includes
    the measured audio, the device's speech length and trigger (`speech_end`, `max_turn`,
    `interrupt`), the turns left, the transcript's length and its detected language (`fi`/`en`/`ar`
    or null).
  - `voice_conversation_reply` records the turn and reply languages. It never includes audio or text.
  - **Limits:**
    - Languages are detected from text (the transcript and the reply), so they can't show what the
      user actually spoke.
    - An `interrupt` trigger or an empty transcript is consistent with echo, noise or real speech,
      so it doesn't prove echo.
    - Playback on the device (started, blocked, failed) isn't logged on the server. The in-app
      notice shows it.

**Grant** (issued only for a non-empty transcript while the session is live; TTL 120 s):

- It is bound to the organization, user, session, turn, **conversation** and exact transcript.
- The chat route requires the conversation id and consumes the grant atomically before generating.
  Replays, concurrent duplicates, another conversation (including the same user's other
  conversations), another user or organization, and ended, replaced or expired sessions all get 409
  and no generation.
- A client-sent `responseMode` is rejected (400). Voice mode comes only from the grant.
- While the user has a live session, chat without a grant is refused (409).

**Voice-mode bounds** (typed chat unchanged):

- the standard chat model only;
- ≤ 400 output tokens **per model call** and ≤ 2 model calls per turn (tools requested by the
  second call are not run);
- no retries for chat or transcription;
- ≤ 3 read-only tool executions, each result fitted structurally to ≤ 4,000 bytes (valid JSON);
- the last 12 history messages, each cut to 2,000 characters;
- ≤ 3 knowledge chunks;
- the stored summary is used, never generated;
- write tools are refused both in the tool list and in `executeTool`;
- **aggregate input budget**, checked before **every** model call:
  - an upper-bound estimate (1 token per UTF-8 byte, plus the tool prompt; not an exact count) of
    everything sent, including instructions, Business DNA with all services, history, the
    transcript, knowledge, tool definitions, and the tool requests and results added before the
    second call;
  - ≤ 48,000 per call, with the first call planned to 30,000;
  - optional context is left out whole, in a fixed order: oldest history, the summary, the
    lowest-ranked knowledge, services, the rest of Business DNA, organization instructions;
  - rules, the transcript and the tool structure are never cut;
  - if required content can't fit, the turn is refused before the call with the localized
    `voice_context_too_large` message. Stored data is not changed.

**Ending and cancellation:**

- End, page hide, a language change or unmount releases the microphone and ends the session.
- The in-flight chat request is aborted. The server then starts no new model call or tool execution
  (checked before each call and each tool).
- A model call or transcription already sent when End arrives may still be billed. Cancellation
  can't reverse it. It is one of the turn's already-counted calls, not an extra one.
- Tokens from completed calls are still recorded, with `aborted: true`.
- A knowledge-base search already running finishes.
- A new conversation's title generation (Haiku, after its first completed reply) runs to completion.
- Late responses can't restart speech or the microphone.
- The grant and the turn stay consumed.

**Cleanup after configuration changes:** ending a session needs no flag, allowlist or valid limits
(the end script uses no configuration). Switching the feature off never leaves a session that can't
be closed. Sessions also expire on their own after their lifetime.

**Failure:** every store error returns 503 (fail closed).

**Cost** (see `docs/live-voice-cost-report.md`):

- **Typical estimate:** ≈ $0.18 per full pilot day (10 turns).
- **Conservative calculated cost:** ≈ $3.08 per organization per day (≈ $92 per 30 days). It assumes
  every call is at the enforced input budget and output limit, and that retryable ancillary calls
  (embeddings, title) use the maximum `AI_RETRY_MAX_ATTEMPTS` = 6.
- **Enforced monetary budget:** none. The code enforces counts and sizes, not dollars.
- Transcription per-minute figures are OpenAI's estimate; transcription is billed per token.

**Privacy:**

- Audio is held in memory for the request and sent to OpenAI for transcription.
- Neither audio nor transcripts are logged.
- The conversation text is saved in the chat like typed messages.
- The intro screen discloses this. OpenAI's own retention is governed by its API data policy; it is
  not promised here.

**Known limitation (separate follow-up):** in typed chat and the phone assistant, confirmation for
write tools is prompt-only. See `docs/ai-tool-confirmation-followup.md`. Live voice doesn't depend on
it, because it is read-only.

**Test evidence:**

- Route integration (mocked providers; in-memory emulation of the scripts).
- The Lua scripts against a **real Redis server**:
  `VOICE_REDIS_TEST_URL=redis://127.0.0.1:<port> npx vitest run tests/unit/voice-conversation-redis.test.ts`.
  Opt-in and skipped in CI. Use only an isolated, disposable local Redis — never a shared, staging
  or production instance.
- A real-browser harness.
- Real phones: not yet tested (see below).

- [ ] **Manual verification required** (approved QA account, real phones).

  With one started session per organization per Helsinki day, **test one language per day**:
  day 1 Finnish, day 2 English, day 3 Arabic. The interface language is fixed for the session, and
  changing it ends the session. Do not reset counters or raise the limits to test faster; that needs
  a separate, explicit authorization. The daily-limit checks (a second tab, a restart after ending)
  use that day's already-used session, so they add no extra session.

  Each day, in that day's language, as **one session of at most 10 turns**, in this order:
  1. Open a **new chat**, type a draft in the composer (don't send it) and press Start. Confirm the
     start screen (spoken, or text-only where the phone has no voice for the language).
  2. Speak 2–3 questions → answers are spoken (or shown as text only). Talk over one reply → it
     stops. Stop reply works.
  3. Mute → speaking produces no turn. Unmute → turns resume.
  4. Ask for a booking → a spoken refusal pointing to the typed chat; nothing is created.
  5. Open a second tab and press Start → refused with the daily-limit message; the first tab keeps
     working.
  6. Ask one more question and press End while it shows "thinking" → the microphone indicator goes
     off, and nothing is spoken afterwards.
  7. All turns are in one conversation, which opens after End. The draft is back. Dictation still
     works.
  8. Press Start again → refused with the daily-limit message (the day's session is used).

## 4. Resend (transactional + inbound email)

**Required:** `RESEND_API_KEY`, `EMAIL_FROM`; **for real inbound mail:** `INBOX_EMAIL_DOMAIN`,
`RESEND_INBOUND_WEBHOOK_SECRET`.

Full setup (DNS/MX, inbound route, webhook signing secret, mailbox provisioning) and a dedicated
manual verification checklist: **`docs/inbox-architecture.md`** — this was the one provider with
no setup documentation at all before this checklist (`.env.example`/`src/env.ts` both referenced
it as a dangling link). Do not duplicate that checklist here; follow it directly.

Webhook endpoint: `{NEXT_PUBLIC_APP_URL}/api/v1/webhooks/inbox-email/resend`.

## 5. Vapi (voice AI)

**Required:** `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` (min 16 chars), `VAPI_WEBHOOK_CREDENTIAL_ID`.

- Create a Vapi account and assistant; the app provisions/syncs assistant config against the
  Vapi API using `VAPI_API_KEY`.
- Webhook endpoint (server-events: tool-calls, status updates, end-of-call reports):
  `{NEXT_PUBLIC_APP_URL}/api/v1/voice/webhook`, verified with HMAC-SHA256 over the raw body
  (constant-time compare server-side).
- **Do not use Vapi's legacy inline `server.secret`** — it sends the raw secret verbatim in
  `X-Vapi-Secret`, which this app's verification does not accept (it expects an HMAC digest, not
  a raw value). Instead, create a **Custom Credential** in the Vapi dashboard: type HMAC,
  algorithm SHA256, Payload Format `{body}` (signs the raw request body), Signature Header
  `x-vapi-signature`, secret = the same value as `VAPI_WEBHOOK_SECRET`. Put the resulting
  credential's ID in `VAPI_WEBHOOK_CREDENTIAL_ID` — the app references it via
  `server.credentialId` and never pushes the secret value itself to Vapi's API. **This exact
  field shape (`server.credentialId`) is verified against Vapi's live documentation, not against
  this repository alone — confirm it against the current Vapi dashboard/docs before relying on it
  in production.**
- Phone number provisioning (+358 numbers) happens through the app's voice settings once the
  assistant is active.
- [ ] **Manual verification required**: place one real call through the provisioned number and
      confirm a `VoiceCall` row reaches `COMPLETED` status — this is exactly what
      `getOrgSetupReadiness` requires before reporting the voice channel `ready` rather than
      `verification_required` (see `src/server/services/setup-readiness.ts`).

## 6. Stripe (billing)

**Required:** `STRIPE_SECRET_KEY` (`sk_...`), `STRIPE_WEBHOOK_SECRET` (`whsec_...`),
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_...`), `STRIPE_PRICE_STARTER_MONTHLY`,
`STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL` (all
`price_...`).

- Create the four recurring Prices (Starter/Pro × monthly/annual) in the Stripe dashboard; copy
  their ids into the four `STRIPE_PRICE_*` variables — `planForPriceId`
  (`src/server/integrations/stripe.ts`) maps them back to internal plan tiers.
- Webhook endpoint: `{NEXT_PUBLIC_APP_URL}/api/v1/webhooks/stripe`. Configure it in the Stripe
  dashboard (or `stripe listen --forward-to` locally) and copy the signing secret into
  `STRIPE_WEBHOOK_SECRET`. Verified via the Stripe SDK's `constructEvent` (rejects anything not
  signed with that exact secret).
- Subscriptions are matched back to organizations via `sub.metadata.orgId` — ensure your
  Checkout/subscription-creation flow sets that metadata key.
- [ ] **Manual verification required**: complete one real Checkout session (test mode is
      sufficient) and confirm the webhook updates the org's `Subscription` row and entitlements.

## 7. Upstash Redis (rate limiting, idempotency)

**Required:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

- Create an Upstash Redis database (REST API, not the raw Redis protocol). Copy the REST URL and
  token directly from the Upstash console.
- No webhook. Used by `src/server/integrations/redis.ts`'s rate limiters (every state-changing,
  cost-amplifying, or publicly-reachable endpoint is rate-limited through this — CLAUDE.md §4)
  and by several idempotency-key guards (e.g. booking notifications).
- [ ] **Manual verification required**: confirm `/api/health`'s `redis` check reports healthy
      against the real database (`getRedisEnv()` validates this subset independently of the rest
      of `serverSchema` — see the comment above it in `src/env.ts`).

## 8. Upstash QStash (delayed/scheduled jobs)

**Required:** `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.

- Create a QStash instance in the same Upstash console; copy the token and both signing keys
  (current + next, for zero-downtime key rotation) from the QStash dashboard.
- No inbound webhook to configure manually — QStash calls back into the app's own job routes
  (`src/app/api/v1/jobs/{calendar-sync,embed-document,post-call,run-workflow,send-reminder,
usage-rollup}/route.ts`). Most are enqueued by the app via `enqueue()`; `calendar-sync` and
  `usage-rollup` run only from manually registered QStash schedules (see `docs/release-runbook.md`). Every job
  route verifies the request with `verifyJobRequest()` (QStash's `Receiver.verify()`) before
  doing any work.
- See `docs/calendar-booking-v1.md`'s "Calendar webhook subscription maintenance schedule" and
  `docs/release-runbook.md` for how the `calendar-sync`/`send-reminder` jobs are scheduled in
  practice.
- [ ] **Manual verification required**: confirm at least one enqueued job (e.g. a scheduled
      booking reminder) actually executes and is signature-verified, not merely enqueued.

## 9. Google Calendar

**Required (optional feature):** `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`;
also needs `CALENDAR_TOKEN_ENCRYPTION_KEY` (shared with Microsoft) to store OAuth tokens.

Full setup already documented in **`docs/calendar-booking-v1.md`** ("Provider setup / OAuth
callback configuration") — do not duplicate here. Summary: OAuth client in Google Cloud Console
with the Calendar API enabled; redirect URI
`{NEXT_PUBLIC_APP_URL}/api/v1/integrations/calendar/google/callback`; webhook channels
(`events.watch`) require the app to be publicly reachable over HTTPS.

- [ ] **Manual verification required**: connect a real Google account, confirm calendars sync,
      then confirm the connection survives a token refresh cycle without needing `NEEDS_REAUTH`.

## 10. Microsoft Calendar (Microsoft 365 / Entra ID)

**Required (optional feature):** `MICROSOFT_CALENDAR_CLIENT_ID`,
`MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_TENANT`; also needs
`CALENDAR_TOKEN_ENCRYPTION_KEY` (shared with Google).

Full setup already documented in **`docs/calendar-booking-v1.md`** — do not duplicate here.
Summary: app registration in Entra ID; redirect URI
`{NEXT_PUBLIC_APP_URL}/api/v1/integrations/calendar/microsoft/callback`; delegated permissions
`Calendars.ReadWrite`, `offline_access`, `openid`, `email`; Graph subscriptions expire after ~3
days and need periodic re-subscription via the scheduled `calendar-sync` job.

- [ ] **Manual verification required**: connect a real Microsoft 365 account, confirm calendars
      sync, and confirm a Graph change-notification subscription survives renewal.

## Provider-independent setup

- `CALENDAR_TOKEN_ENCRYPTION_KEY` — 32-byte base64 (`openssl rand -base64 32`), required by
  Google **and** Microsoft calendar integrations for AES-256-GCM encryption of OAuth tokens at
  rest. Not itself an external provider, but nothing calendar-related works without it.
- `INBOX_EMAIL_WEBHOOK_SECRET` — shared secret (`openssl rand -hex 32`) for the
  provider-agnostic inbox webhook (`/api/v1/webhooks/inbox-email`); independent of Resend's own
  signing secret.
