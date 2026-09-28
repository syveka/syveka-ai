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
2. The server reserves the turn, transcribes it (`gpt-4o-mini-transcribe`, one attempt) and returns the
   text with a **single-use grant**.
3. The client submits the text and grant to the normal `/api/v1/ai/chat` route. That route consumes
   the grant atomically, so **one accepted turn allows at most one chat generation**. It uses the same
   session, permissions, moderation, Business DNA and RAG as typed chat, in a bounded voice mode.
4. The reply is read aloud with the device's speech voices. If the device has no voice for the
   interface language, the start screen offers text-only replies or dictation instead. It never uses
   another language's voice.

Live voice is independent of dictation. It has its own flag, allowlist, keys and budgets, and it never
consumes the dictation cap of 10 attempts per day.

**Enable with (staging only, after review):**

- `AI_VOICE_CONVERSATION_ENABLED=1`
- `AI_VOICE_CONVERSATION_PILOT_ALLOWLIST="<organizationId>:<userId>"`
- `OPENAI_API_KEY`

If the flag or allowlist is missing or malformed, or any limit is invalid or out of range, the
feature is disabled.

| Variable                                        | Default | Allowed range | Meaning                                                                |
| ----------------------------------------------- | ------- | ------------- | ---------------------------------------------------------------------- |
| `AI_VOICE_CONVERSATION_SESSION_SECONDS`         | 300     | 60–1800       | Hard session lifetime (server refuses turns after it)                  |
| `AI_VOICE_CONVERSATION_MAX_TURN_SECONDS`        | 30      | 5–60          | Longest accepted turn (measured server-side)                           |
| `AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION`   | 20      | 1–200         | Turns per session                                                      |
| `AI_VOICE_CONVERSATION_DAILY_ORG_TURNS`         | 30      | 1–2000        | Turns per organization per Europe/Helsinki day, across all sessions    |
| `AI_VOICE_CONVERSATION_DAILY_ORG_AUDIO_SECONDS` | 600     | 60–36000      | Audio per organization per Europe/Helsinki day, reserved per turn      |
| `AI_VOICE_CONVERSATION_MAX_CONCURRENT_PER_ORG`  | 1       | 1–20          | Active sessions per organization (one per user; a new tab replaces it) |

**What the server enforces (before any paid call):**

- **Turn route**, all before transcription:
  - same-origin request, session, `chat:use`, flag and allowlist;
  - short-window limit (40 turns / 5 min per user, fails closed);
  - the organization's monthly AI-message quota (read only);
  - size ≤ 2 MiB and measured duration ≤ the turn cap;
  - one atomic Redis reservation (Lua) that checks, in one step: session owner and expiry, the
    per-session turn cap, a duplicate turn id, and **both** daily budgets (audio seconds and turns).
    Only then does it add to them. A refused turn reserves nothing.
- **Session start:** refused when the organization's daily audio or turn budget is already used up,
  or it is at its concurrency limit. A new session or tab can't reset a daily budget: the budgets are
  keyed by organization and Helsinki day, not by session.
- **Grant:** issued only for a non-empty transcript, only while the session is still live, and valid
  for 120 s. It is bound to the organization, user, session, turn and exact transcript text.
- **Chat route with a grant:**
  - atomically consumes the grant (owner, exact text, session still live) before generating;
  - a replay, a changed message, or an ended, expired or replaced session gets 409 and no generation;
  - `documentIds` can't be combined with a grant;
  - voice mode is derived **only** from the grant; a client-sent `responseMode` is rejected (400).
- **Chat route without a grant** while the user has a live session: refused with 409
  `live_voice_session_active`, so the typed route can't be used to get around the voice limits.
  With the flag off, typed chat never touches the voice store.
- **Voice-mode bounds:**
  - the standard chat model (pinned and deep models are ignored);
  - ≤ 400 output tokens and ≤ 2 model/tool rounds;
  - no provider retries;
  - the last 12 messages of history and ≤ 3 RAG chunks;
  - **read-only tools** (`searchKnowledgeBase`, `searchContacts`, `getCalendarAvailability`),
    enforced in `executeTool` as well as in the tool list.
- **Failure:** any store error returns 503 (fail closed).

**What counts as used:**

- A turn (its audio seconds, one daily turn and one session turn) is consumed as soon as its
  reservation succeeds. It is not refunded on provider failure, timeout, cancel or an empty
  transcript.
- A grant is consumed when the chat route accepts it. If the request fails before that (for example
  on moderation), the grant expires unused after 120 s.
- Ending the conversation while Syveka is "thinking" aborts the reply in the browser. A generation
  already running on the server may still finish and be saved.

**Why no realtime provider session:** the browser holds no provider credential and no open
provider stream. Every paid unit is a separate server request, so a modified client can't keep an
ended or expired session alive.

**Cost:** see `docs/live-voice-cost-report.md` for sources, assumptions and scenarios. In summary:

- Transcription is hard-capped at 600 s per organization per day (≤ $0.03/day).
- Chat replies (`claude-sonnet-4-5`) are the main cost: roughly $0.009–$0.05 per turn, ≈ $0.20 per
  5-minute conversation.
- A realistic heavy pilot day (30 turns) is ≈ $1.70 per organization.
- The chat part is bounded by turns, tokens, rounds, history and RAG, but it is **not a hard dollar
  cap**. The theoretical ceiling is ≈ $8.80 per organization per day.

**Privacy:**

- Audio is held in memory for the request and sent to OpenAI for transcription.
- Neither audio nor transcripts are logged.
- The conversation text is saved in the chat like typed messages.
- The intro screen discloses this. OpenAI's own retention is governed by its API data policy; it is
  not promised here.

**Known limitation (separate follow-up):** in typed chat, confirmation for write tools is prompt-only.
See `docs/ai-tool-confirmation-followup.md`. Live voice doesn't depend on it, because it is read-only.

- [ ] **Manual verification required** (pilot account, real phone, in FI, EN and AR):
  - start and end a conversation;
  - confirm turns are answered aloud;
  - check that talking interrupts a reply and that mute stops turns;
  - check that ending stops the microphone indicator;
  - check that asking for a booking gets a spoken refusal pointing to typed chat;
  - check that a device without a voice for the language offers text-only replies or dictation;
  - check that a second tab replaces the first session;
  - check that the daily limit message appears after 30 turns.

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
usage-rollup}/route.ts`), which the app itself enqueues jobs against via `enqueue()`. Every job
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
