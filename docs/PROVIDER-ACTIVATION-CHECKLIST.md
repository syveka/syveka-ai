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

## 4. Resend (transactional + inbound email)

**Required:** `RESEND_API_KEY`, `EMAIL_FROM`; **for real inbound mail:** `INBOX_EMAIL_DOMAIN`,
`RESEND_INBOUND_WEBHOOK_SECRET`.

Full setup (DNS/MX, inbound route, webhook signing secret, mailbox provisioning) and a dedicated
manual verification checklist: **`docs/inbox-architecture.md`** — this was the one provider with
no setup documentation at all before this checklist (`.env.example`/`src/env.ts` both referenced
it as a dangling link). Do not duplicate that checklist here; follow it directly.

Webhook endpoint: `{NEXT_PUBLIC_APP_URL}/api/v1/webhooks/inbox-email/resend`.

## 5. Vapi (voice AI)

**Required:** `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` (min 16 chars).

- Create a Vapi account and assistant; the app provisions/syncs assistant config against the
  Vapi API using `VAPI_API_KEY`.
- Webhook endpoint (server-events: tool-calls, status updates, end-of-call reports):
  `{NEXT_PUBLIC_APP_URL}/api/v1/voice/webhook`. Configure this as the assistant's server URL in
  the Vapi dashboard, with `VAPI_WEBHOOK_SECRET` as the shared HMAC-SHA256 signing secret
  (verified constant-time server-side).
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
