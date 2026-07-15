# AI Chat Production Hardening (Milestone 3)

## Architecture

Milestone 3 extends the existing Next.js route, Anthropic model router, OpenAI moderation/embeddings, Upstash Redis, Supabase Storage, QStash ingestion, Prisma, and pgvector implementation. It does not add a second chat or document pipeline.

The request path is:

1. Authenticate and require `chat:use`.
2. Apply independent Redis sliding-window limits for the user and organization.
3. Parse the strict shared Zod request schema and check the plan entitlement.
4. Moderate the user input with OpenAI moderation.
5. Resolve the tenant-owned conversation, attach validated tenant documents, and refresh the rolling summary when required.
6. Retrieve conversation-attached document chunks or the organization knowledge base with a tenant-filtered pgvector query.
7. Generate with transient-failure retry and request-abort propagation.
8. Moderate the complete model output before any answer text is released.
9. Stream the approved answer as SSE and persist the message, token counts, estimated USD cost, citations, latency, and usage records.

Holding generated text until output moderation completes intentionally trades first-token latency for the guarantee that flagged output is never sent to the browser.

## Chat API

### `POST /api/v1/ai/chat`

Authenticated JSON request:

```json
{
  "conversationId": "optional UUID",
  "message": "required, 1-8000 characters",
  "useKnowledgeBase": true,
  "deepMode": false,
  "documentIds": ["up to 10 tenant-owned document UUIDs"]
}
```

Unknown properties are rejected. Validation errors use HTTP 400 and include Zod field details under `error.details`.

Successful responses use `text/event-stream`. Each frame is `data: <json>\n\n` and has one of these shapes:

- `meta`: `{ type, conversationId, messageId }`
- `text`: `{ type, delta }`
- `tool`: `{ type, name, status }`
- `citations`: `{ type, citations }`
- `done`: `{ type, tokensIn, tokensOut, estimatedCostUsd }`
- `error`: `{ type, code }`

The browser cancels with `AbortController`. The request signal is propagated to moderation, embeddings, and generation. An aborted generation is not persisted as an assistant message.

Rate-limit responses use HTTP 429, identify `user` or `organization` in `error.scope`, and include `Retry-After` plus `X-RateLimit-*` headers.

## Chat file APIs

Chat uploads reuse the knowledge-base upload intent and embedding pipeline but require `chat:use`, allowing normal chat members to attach files without receiving general `kb:write` access.

### `POST /api/v1/ai/files/upload-url`

```json
{ "fileName": "report.pdf", "mimeType": "application/pdf", "sizeBytes": 12345 }
```

Allowed chat UI formats are PDF, DOCX, and TXT, up to 25 MB. The response contains a single-use, tenant/user-bound upload intent and signed Supabase Storage URL.

### `POST /api/v1/ai/files`

```json
{ "title": "report", "uploadIntentId": "UUID" }
```

Finalization verifies the stored object and enqueues the established `embed-document` job. That job extracts text, chunks it, creates OpenAI embeddings, stores them in pgvector, and marks the document `READY`. Passing its ID in `documentIds` connects it to the conversation. Retrieval automatically starts once embedding is ready.

## Rolling summaries

At more than 40 user/assistant messages, older context is summarized in batches while the newest 20 messages remain verbatim. `Conversation.summary`, `summaryMessageCount`, and `summaryUpdatedAt` make the process incremental. The saved summary is inserted as context on later turns. Summary token usage and estimated cost are recorded like other AI work.

## Retries and moderation

OpenAI embeddings and moderation retry HTTP 408, 409, 429, 5xx, and common transient network failures with exponential backoff and jitter. Anthropic generation uses the same policy only before a streamed round has emitted text, preventing duplicate output. Abort and permanent 4xx failures are never retried.

Input and output use `omni-moderation-latest`. Unsafe input returns HTTP 422. Unsafe output produces an SSE `content_flagged` error, is not stored as an assistant message, and its provider usage is still recorded for billing accuracy.

## Token and cost storage

Prompt/completion tokens remain in `Message.tokensIn` and `Message.tokensOut`. `Message.estimatedCostUsd` stores a `Decimal(12,8)` estimate. Daily `UsageRecord` entries also contain the model, user/conversation or task, and estimated cost metadata. Pricing is centralized in `src/server/ai/cost.ts`; it is an estimate and should be reviewed when provider prices or routed model families change.

## Configuration

```dotenv
AI_CHAT_USER_RATE_LIMIT=30
AI_CHAT_ORG_RATE_LIMIT=300
AI_CHAT_RATE_WINDOW_SECONDS=60
AI_RETRY_MAX_ATTEMPTS=3
AI_RETRY_BASE_DELAY_MS=250
```

All values are validated at runtime by `src/env.ts`. The migration `20260715000000_ai_chat_production_hardening` owns the summary/cost columns, the conversation-document join table, indexes, foreign keys, and RLS policy.

## Verification

Run:

```sh
npm run db:generate
npx prisma validate
npm run format -- --check
npm run lint
npm run typecheck
npm test
npm run build
```
