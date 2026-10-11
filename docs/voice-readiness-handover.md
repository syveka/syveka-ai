# Phone voice (Vapi): readiness handover

Snapshot of phone-voice webhook security, call limits, post-call processing, knowledge-base
exposure and failure reporting at main `a72fa7d`, plus the draft PRs below (2026-10-11). It is
an input to the consolidated release gate, not a gate decision. Verify live state before relying
on any line here.

## Evidence levels

Each claim below is labelled with the strongest evidence behind it:

- **db**: run against a real PostgreSQL. **None of this work has db evidence.** No disposable
  database could be started on the workstation: the Docker engine did not respond, WSL is
  unavailable, and unsigned Postgres binaries are blocked by Windows code integrity. Staging and
  production were not used as a substitute.
- **compiler**: the real Prisma client and query compiler over a scripted driver adapter. It
  proves the SQL Prisma emits and how it reports results; the database's answers are scripted,
  following documented Postgres behaviour.
- **mocked**: unit tests with mocked database and providers.
- **docs**: Vapi's official documentation or its published OpenAPI document
  (`https://api.vapi.ai/api-json`, fetched 2026-10-11).
- **live**: observed on a real Vapi call. **Nothing here is live-verified.**

## Draft PRs (none merged, none deployed)

| PR   | Head      | Concern                                                                                       | Severity              | Evidence                              |
| ---- | --------- | --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------- |
| #294 | `9d18627` | Read-only (past-due) orgs still had calls answered, tools run, minutes billed                 | P2                    | mocked                                |
| #295 | `2d7b5ff` | Call-row writes not bound to the signed assistant's org                                       | P3 (defence in depth) | compiler + mocked; db test written    |
| #297 | `928abbd` | Post-call summary failures hidden; CRM activity lost; simultaneous runs double-record         | P2                    | mocked (deterministic interleaving)   |
| #300 | `391e677` | Knowledge ingestion: raw provider/parser errors shown; READY flipped to FAILED; stuck Pending | P2 (raw errors: §4)   | mocked                                |
| #302 | `041716b` | Anonymous phone callers could search every document of the organization                       | P1                    | mocked (real route and tool registry) |

All are based on main `a72fa7d`. #294, #295 and #302 each touch
`src/app/api/v1/voice/webhook/route.ts` in different places; whichever merges later needs main
merged in first. #302 also changes `src/server/services/voice.ts` and the assistant form.

## #295: tenant binding, and what Prisma actually does

The first version of #295 assumed a tenant-scoped upsert raises P2002 for another
organization's call id. The real Prisma query compiler (`engineType = "client"`) plans the
webhook's two upserts differently (compiler evidence, `voice-call-rows-prisma.test.ts`):

| Webhook message                       | SQL Prisma runs                                                                    | Another org's call id                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| end-of-call-report (fields to update) | one `INSERT … ON CONFLICT (vapi_call_id) DO UPDATE … WHERE organization_id = $org` | nothing updated, no row returned: Prisma returns `null` |
| status-update (nothing to update)     | SELECT within the org, then a plain `INSERT`                                       | the INSERT fails: P2002                                 |

So on the first version the 409 / `voice_call_org_conflict` path never ran for an end-of-call
report, and the post-call job was still enqueued (it then found no call in the wrong
organization and skipped). Another organization's row was never changed in either version. The
correction treats both a `null` result and an unexplained P2002 as "foreign".

`tests/unit/voice-call-binding.postgres.test.ts` covers the requested real-database cases:
organizations A and B, A's whole row unchanged after B's report and status update, no post-call
work, 409 vs 200, ten rounds of concurrent first writes within one organization, and an
out-of-range integer as a genuine database failure. It follows the existing
`invitation-seat-limit.postgres.test.ts` pattern: skipped unless `VOICE_PG_URL` is set. **It has
never been run.** To run it: a scratch `pgvector/pgvector:pg15` database,
`tests/migrations/supabase-compatibility.sql`, `npx prisma migrate deploy`, then
`VOICE_PG_URL=… npx vitest run tests/unit/voice-call-binding.postgres.test.ts`.

## Post-call concurrency (#297)

Confirmed by code inspection; reproduced only with mocks. Every "already recorded?" guard in the
post-call job (usage, contact, CRM activity, owner notification) was a separate SELECT then
INSERT, with no unique constraint behind it (`usage_records`, `activities` and `notifications`
have none on the call). Two runs of the job for the same call at the same moment both pass each
check under READ COMMITTED. QStash's `deduplicationId` reduces how often that happens; it does not
make the job run once (a duplicate report outside its window, or a retry overlapping a slow
first attempt).

- **Reproduced (mocked):** with run A paused inside its usage check until run B reaches the same
  step, the previous head records the minutes twice.
- **Fix (no schema change):** each check-then-insert runs in its own transaction holding
  `pg_advisory_xact_lock(hashtext('post_call'), hashtext(call.id))`, the pattern already used for
  bookings, contacts by email and phone numbers. The second run waits, then sees the first run's
  row. Each step commits on its own, so a retry after a partial failure redoes only what is
  missing and loses nothing.
- **Not proven:** no real-Postgres run, so this is **not** a demonstrated exactly-once guarantee.
- **Residual:**
  - Two simultaneous runs can each pay for a summary call. The last summary written wins; only
    one activity is created.
  - Two different calls from the same new number at the same moment can still create two
    contacts. `contacts` has no unique (org, phone); that is pre-existing and per-number, not
    per-call.
- **Durable alternative (needs a migration, not proposed here):** a unique index on the call key
  for `usage_records` and `activities`. The lock is enough without a schema change.

## Anonymous knowledge-base access (#302)

- **Existing behaviour (reproduced, mocked retrieval, real route and tool registry):** a phone
  caller could run `searchKnowledgeBase` whenever the assistant's `useKnowledgeBase` was set
  (default **true**) or its stored `enabledTools` listed it (default `["searchKnowledgeBase"]`).
  The tool returns the top chunks of every READY document in the organization; a synthetic
  private document was read back to the caller.
- **No visibility model exists:** `Document` and `Collection` have no visibility or "public"
  field, so there is nothing to reuse. No "public collection" was invented from names, tags or
  prompts.
- **Proposed change:** `searchKnowledgeBase` leaves `VOICE_TOOL_NAMES`, the phone-caller
  allowlist. `allowedVoiceTools` drives both the webhook's tool dispatch and the tools synced to
  Vapi, and drops stored tools not on that list. Effects:
  - every existing assistant is refused the tool, whatever it stored;
  - a forged call gets `tool_not_enabled`;
  - missing or malformed settings allow nothing;
  - the next sync stops offering the tool;
  - the knowledge-base toggle leaves the assistant form (the column stays).
  - Signed-in chat is unchanged. `src/server/ai/tools/index.ts` is not touched.
- **Follow-up for the owner:** per-document or per-collection public visibility, set
  deliberately and enforced inside retrieval (`match_chunks`). It needs a migration and its own
  review.

## #300: error boundary

- **Owner-facing errors:** only errors this codebase raises with fixed text keep their message.
  They are matched with `instanceof` against `DocumentIngestionError`, `ParserSecurityError`,
  `UrlIngestionError` and the job's own `DocumentProcessingError`. Matching on `err.name`, as
  the first version did, trusts any error that sets that name.
- **Parser messages:** the isolated parser's catch-all reports the PDF/DOCX library's own message
  (`parser_failed`). Those messages can include file paths, so they now become "The document
  could not be read."
- **Usage accounting:** a failed `recordUsage(EMBEDDINGS)` after READY is logged
  (`document_embed_usage_failed`) and **not retried or reconciled**. That metric is written but
  read by no limit, invoice or usage page today. If it is ever billed, it needs a durable retry or
  reconciliation first.

## Evidence table

| Control                    | Behaviour (main `a72fa7d` + draft PRs)                                                                                                                                                                                                                                                                                                         | Evidence                                    | Live configuration / owner decision                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Webhook authentication     | HMAC-SHA256 of the raw body, hex, timing-safe, from `x-vapi-signature` (or `x-vapi-secret`), before parsing and before any database access. `VAPI_WEBHOOK_SECRET` ≥ 16 chars or the route fails closed. No timestamp: a captured request stays valid; tool-call ids, write caps, the ended-call refusal and end-of-call markers limit replays. | mocked (merged)                             | **Unverified live.** See "Provider configuration".             |
| Tenant isolation           | Org only from the signed assistant. Call rows written only within that org (#295).                                                                                                                                                                                                                                                             | compiler + mocked; db test written, not run | none                                                           |
| Duplicate / retry handling | Tool calls: Redis claim per tool-call id, per-call write caps, refusal after the call ends. End-of-call: QStash dedupe id + Redis marker. Post-call: per-step guards, serialized per call (#297).                                                                                                                                              | mocked                                      | Optional migration: unique indexes on the call key.            |
| Usage limits               | Plan minutes checked at `status-update` in-progress (ends the call via Live Call Control) and at every `tool-calls`. Read-only orgs refused (#294). No gate at call start (`assistant-request` not used).                                                                                                                                      | mocked                                      | Test once on staging (procedure below).                        |
| Concurrency (calls)        | No cap on simultaneous calls; N parallel calls can each overrun the remaining minutes (bounded by `maxDurationSeconds` 900).                                                                                                                                                                                                                   | code                                        | **Policy:** a per-plan cap, or accept the overrun.             |
| Failed / short calls       | Every call with an end-of-call report is billed at least 1 minute, including zero-length and our own quota hang-ups.                                                                                                                                                                                                                           | code                                        | **Policy** (unchanged by this work).                           |
| AI / recording notice      | A model instruction, after the owner-written `firstMessage`; Arabic gets the English instruction. #265 speaks the notice first. Vapi also has `compliancePlan.recordingConsentPlan` (docs), unused.                                                                                                                                            | mocked                                      | Approve the wording and #265.                                  |
| Recordings and retention   | Recording is on (Vapi default). The raw `recordingUrl` is stored and played directly. Nothing deletes Vapi-side recordings on erasure.                                                                                                                                                                                                         | docs                                        | See "Provider configuration".                                  |
| Knowledge base exposure    | Phone callers refused (#302); signed-in chat unchanged.                                                                                                                                                                                                                                                                                        | mocked                                      | **P1:** approve #302; decide on public content as a follow-up. |
| Failure reporting          | `voice_tool_call_failed`, `voice_quota_end_call_skipped`, `voice_call_org_conflict` (#295), `post_call_summary_failed` (#297), `document_embed_failed`, `document_embed_usage_failed`, `document_ready_notification_failed` (#300). Ids and error class only. No alerting.                                                                     | mocked                                      | Which events to alert on.                                      |

## Provider configuration (Vapi)

**Confirmed from official sources (docs), not observed live:**

- **HMAC credential defaults** (OpenAPI `HMACAuthenticationPlan`): `signatureHeader` defaults to
  `x-signature`, `includeTimestamp` to true, `payloadFormat` to `{timestamp}.{body}`,
  `signatureEncoding` to hex, `secretIsBase64` to false. Our verifier needs the body alone in
  `x-vapi-signature`. The credential must therefore be set explicitly:
  - `algorithm: sha256`;
  - `signatureHeader: x-vapi-signature`;
  - `includeTimestamp: false`;
  - `payloadFormat: {body}`;
  - `signatureEncoding: hex`;
  - no `signaturePrefix`;
  - `secretIsBase64: false`;
  - secret = `VAPI_WEBHOOK_SECRET`.

  A credential left on defaults makes every webhook 401: voice stops, it does not open up.

- **Org credential scope** (docs): Vapi attaches the credential only when the server URL comes
  from the org's saved configuration (assistant, phone number, tool, server configuration), not
  from a per-request URL. Ours is set on the saved assistant.
- **Live Call Control** (OpenAPI `MonitorPlan`): `controlEnabled` defaults to true, and the URL
  is read from `call.monitor.controlUrl`; the end-call message is `{"type":"end-call"}`. So
  `controlUrl` should be present without setting `monitorPlan`. Still to confirm live.
- **Recording** (OpenAPI): the setting is `artifactPlan.recordingEnabled`, default true.
  `CreateAssistantDTO` has **no** top-level `recordingEnabled`, which
  `src/server/integrations/vapi.ts` sends. Recording happens anyway by default. Whether Vapi
  ignores the unknown field or rejects the request is not established. Not changed here.
- **Recording URLs** (OpenAPI `Artifact`): presigned URLs expire; the raw `recordingUrl` "remain[s]
  the stable identifier and do[es] not expire". Whether the raw URL needs authentication is not
  stated.
- **Retention and deletion** (OpenAPI): retention is per Vapi subscription (`callRetentionDays`,
  `dataRetentionEnabled`). `DELETE /call/{id}` erases the call's recordings, and fails with 503,
  keeping the call, if erasure fails.

**Still unknown (needs the dashboard or an authorized read):**

- the actual credential settings;
- the subscription's retention days;
- whether raw recording URLs are publicly fetchable;
- whether the top-level `recordingEnabled` is accepted.

No Vapi configuration was read or changed.

## Staging test procedure (not run; each call is paid and needs approval)

1. **Authentication, no call needed.** Send one unsigned POST to `/api/v1/voice/webhook` on
   staging.
   - **Expect:** 401, nothing written.
   - Then check the staging assistant's credential matches the settings above.
2. **Authentication, one call.** Place one test call to the staging assistant.
   - **Expect:** a `voice_calls` row for the staging test org with status `IN_PROGRESS`, then
     `COMPLETED` with a transcript.
   - **Expect:** a `post-call` job and a `call.completed` notification.
   - A 401 in the logs instead means the credential is on Vapi defaults.
3. **Over-quota termination.** Use a FREE-plan test org (0 minutes; entitlement grants only add minutes, so they can't lower a limit).
   Place one call.
   - **Expect:** the call ends within seconds of connecting, and no `voice_calls` row is
     created.
   - **Expect no** `voice_quota_end_call_skipped` log line. If it appears, `controlUrl` was
     missing and the call runs to 15 minutes; end it by hand.
   - A tool call in the same call is refused with the spoken goodbye.
4. **Knowledge base (after #302 is deployed).** Ask the assistant something only an uploaded
   synthetic document contains.
   - **Expect:** it doesn't know.
   - **Expect** no `searchKnowledgeBase` tool call to succeed in the logs.

## One Syveka alignment

Reused today: the org context from the signed assistant, the shared tool registry
(`executeTool` with a `voice_ai` identity), Business DNA in the system prompt, plan entitlements
and usage records, the workflow event bus, and the advisory-lock pattern (#297).

Gaps (no refactor started):

- **Post-call summary.** It calls Anthropic directly, bypassing the model router's provider
  abstraction and AI spend accounting.
- **Post-call contact creation.** It skips the contacts service (plan limit, audit,
  `contact.created`).
- **Voice tool executions.** They are not written to the audit log.

## Dependencies for the release-gate owner (old account)

- Incorporate the rows above. Treat nothing mocked or compiler-level as database or live
  evidence.
- No calendar, recurrence, booking or busy-query file was changed. `src/server/ai/tools/index.ts`
  was not changed (#296).
- `executeTool` returns tool errors to the model but logs nothing (its catch). A one-line
  structured log there (`{event: "ai_tool_failed", tool, actorType, name}`, ids only) belongs
  with whoever owns that file.
- #302 changes what live assistants can do once deployed, and their Vapi tool lists at their
  next sync.
- Flaky under heavy parallel load, both passing alone:
  - `tests/unit/voice-conversation-flow.test.ts`;
  - `tests/unit/hook-config-protection.test.ts` (one 5 s timeout seen once on #295; about 0.9 s
    alone on both main and the branch).
