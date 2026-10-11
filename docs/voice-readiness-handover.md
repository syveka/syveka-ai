# Phone voice (Vapi): readiness handover

Snapshot of phone-voice webhook security, call limits, post-call processing, knowledge-base
exposure and failure reporting at main `a72fa7d`, plus the draft PRs below (2026-10-11). It is
an input to the consolidated release gate, not a gate decision. Verify live state before relying
on any line here.

## Evidence levels

Each claim below is labelled with the strongest evidence behind it:

- **db**: run against a real, disposable PostgreSQL (`pgvector/pgvector:pg15`, the complete
  migration history, synthetic data). This exists for #295 and #297 only, through the draft
  evidence PR #303, because no database could be started on the workstation (Docker engine
  unresponsive, WSL unavailable, unsigned Postgres binaries blocked). Staging and production were
  not used. Evidence run: `38129755849`.
- **compiler**: the real Prisma client and query compiler over a scripted driver adapter. It
  proves the SQL Prisma emits and how it reports results; the database's answers are scripted,
  following documented Postgres behaviour.
- **mocked**: unit tests with mocked database and providers.
- **docs**: Vapi's official documentation or its published OpenAPI document
  (`https://api.vapi.ai/api-json`, fetched 2026-10-11).
- **live**: observed on a real Vapi call. **Nothing here is live-verified.**

## Draft PRs (none merged, none deployed)

| PR   | Head      | Concern                                                                                       | Severity              | Evidence                                                |
| ---- | --------- | --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| #294 | `9d18627` | Read-only (past-due) orgs still had calls answered, tools run, minutes billed                 | P2                    | mocked                                                  |
| #295 | `fe33e37` | Call-row writes not bound to the signed assistant's org; same-org first-write race            | P3 (defence in depth) | **db** + compiler + mocked                              |
| #297 | `fcaace0` | Post-call summary failures hidden; CRM activity lost; simultaneous runs double-record         | P2                    | **db** (concurrency, retry, rollback); mocked (summary) |
| #300 | `391e677` | Knowledge ingestion: raw provider/parser errors shown; READY flipped to FAILED; stuck Pending | P2 (raw errors: §4)   | mocked                                                  |
| #302 | `041716b` | Anonymous phone callers could search every document of the organization                       | P1                    | mocked (real route and tool registry)                   |
| #304 | `52193ae` | Recording requested in an undocumented top-level field instead of `artifactPlan`              | P3                    | docs + mocked                                           |
| #303 | `8af176e` | Evidence only (#295 + #297 on Postgres in PR CI). **Not for merge.**                          | n/a                   | db                                                      |

All are based on main `a72fa7d`. #294, #295 and #302 each touch
`src/app/api/v1/voice/webhook/route.ts` in different places; whichever merges later needs main
merged in first. #302 also changes `src/server/services/voice.ts` and the assistant form; #304
changes `src/server/integrations/vapi.ts`. #297 adds an optional transaction parameter to
`recordUsage` (`src/server/services/billing/entitlements.ts`; default unchanged).

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

**Real-Postgres results** (`tests/unit/voice-call-binding.postgres.test.ts`, run `38129755849`):

| Test (real route, real Prisma, real Postgres)                                    | main `a72fa7d`                                                            | #295 v1 `5c468f7`                                     | #295 `fe33e37` |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| B's end-of-call report for A's call id: A's row unchanged, nothing queued, 409   | ❌ **A's row overwritten** (duration 999, reason and transcript "forged") | ❌ row unchanged, but **post-call queued for B**, 200 | ✅             |
| B's status update for A's call id: A's row unchanged, conflict logged            | ❌ row unchanged; no conflict logged                                      | ✅                                                    | ✅             |
| A's own retries: redelivered report; report whose enqueue failed                 | ✅                                                                        | ✅                                                    | ✅             |
| Concurrent first writes (status update + report, both orders, 10 rounds)         | ❌ **unhandled P2002**: one request errors                                | ✅                                                    | ✅             |
| A genuine database failure (temporary trigger) propagates; not called a conflict | ✅                                                                        | ✅                                                    | ✅             |

The previous-code steps must fail on the labelled assertion that shows the defect ("A's row
unchanged" on main, "nothing queued for B" on v1); a failure on any other assertion does not
count. Main's concurrent first-write failure is a second, same-organization defect: when the
in-progress update and the end-of-call report race, one of them fails with P2002 and relies on a
Vapi retry. The P2002 handling in #295 fixes it.

To rerun locally once a database exists: a scratch `pgvector/pgvector:pg15` database,
`tests/migrations/supabase-compatibility.sql`, `npx prisma migrate deploy`, then
`VOICE_PG_URL=… npx vitest run tests/unit/voice-call-binding.postgres.test.ts`.

## Post-call concurrency (#297)

Every "already recorded?" guard in the post-call job (usage, contact, CRM activity, owner
notification) was a separate SELECT then INSERT, with no unique constraint behind it. QStash's
`deduplicationId` reduces how often two runs overlap; it does not make the job run once.

**Fix (no schema change):** each check-then-insert runs in its own transaction holding
`pg_advisory_xact_lock(hashtext('post_call'), hashtext(call.id))`, the pattern already used for
bookings and phone numbers. Each step commits on its own.

**Real-Postgres results** (`tests/unit/post-call-concurrency.postgres.test.ts`, run
`38129755849`; independent connections; summary provider, Redis, QStash and workflow queue
mocked; assertions on committed rows):

| Test                                                                                                                 | before the locks `a9f1b43`                                                       | #297 `fcaace0`                                      |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| Two simultaneous runs for one call: usage, contact, activity, notification each once                                 | ❌ **usage recorded twice**                                                      | ✅ the second run waited on the lock at every check |
| Retry after a failure part-way (activity insert fails): only unfinished steps run                                    | ✅                                                                               | ✅                                                  |
| A step failing inside its transaction (contact link) rolls back its contact; the retry completes                     | ❌ contact left behind (no transaction; a retry finds it by phone, no duplicate) | ✅                                                  |
| Two orgs' calls at once: each completes in its own org, neither waited on the other's lock; B can't process A's call | ✅                                                                               | ✅                                                  |

How the race is forced: run A, having read "nothing recorded yet", is held before it may insert,
until run B has made the same read (no serialization) or is seen in `pg_locks` waiting for A's
advisory lock (serialization). The second run starts once the first has reached that check,
because two lazy route imports in flight at once can bypass `vi.mock` in Vitest (seen in an
earlier run as the real QStash verifier answering 401). An earlier version of this harness held
run A before its read, which let the pre-lock code pass the counts; that run is not counted.

**Not established:** exactly-once delivery, or anything about external side effects.

**Residual, unchanged:**

- two simultaneous runs can each pay for a summary call (the last one written wins; one
  activity);
- two different calls from the same new number at the same moment can still create two contacts
  (`contacts` has no unique (org, phone)).

A unique index on the call key would make the guarantee schema-backed; that needs a migration and
is not proposed.

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
  - Signed-in chat is unchanged: same tool, same organization-scoped retrieval, same role
    permissions (`kb:read`); no chat code and not `src/server/ai/tools/index.ts` changed.
- **Deploying #302 turns off document answers on every phone assistant.** Callers asking about
  something only in an uploaded document will hear that the assistant doesn't know.
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
  Neither `CreateAssistantDTO` nor `UpdateAssistantDTO` has a top-level `recordingEnabled`, which
  `src/server/integrations/vapi.ts` sends; recording happens only because the documented field
  defaults to on. Draft #304 sends the same intent (recording on) as
  `artifactPlan: { recordingEnabled: true }`. No policy change. Review risk: it is the first
  `artifactPlan` the sync sends, so if Vapi treats a nested object in a PATCH as a replacement,
  hand-set `artifactPlan` options on a synced assistant would be reset. Check one staging
  assistant's `artifactPlan` in the dashboard (read only) before deploying.
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
- whether Vapi ignores or rejects the top-level `recordingEnabled` main sends today, and what
  `artifactPlan` the live assistants have.

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

- Incorporate the rows above. Only #295 and #297 have database evidence (run `38129755849`);
  treat nothing mocked or compiler-level as database or live evidence.
- No calendar, recurrence, booking or busy-query file was changed. `src/server/ai/tools/index.ts`
  was not changed (#296).
- Shared-file conflict risks: `src/app/api/v1/voice/webhook/route.ts` (#294, #295, #302);
  `src/server/services/billing/entitlements.ts` (#297 adds an optional parameter to
  `recordUsage`); `tests/unit/voice-webhook.test.ts` (#294, #295, #302). Each PR is based on
  `a72fa7d` and was not tested combined with the others or with the integration candidate.
- #303 is evidence only: it merges #295 and #297 and adds a PR-only workflow. Don't merge it,
  and don't bring its workflow or `scripts/ci/expect-test-failure.sh` into the candidate.
- `executeTool` returns tool errors to the model but logs nothing (its catch). A one-line
  structured log there (`{event: "ai_tool_failed", tool, actorType, name}`, ids only) belongs
  with whoever owns that file.
- #302 changes what live assistants can do once deployed, and their Vapi tool lists at their
  next sync.
- Flaky under heavy parallel load, both passing alone on main and the branches (not changed;
  no synchronization defect reproduced, and neither is in these PRs):
  - `tests/unit/voice-conversation-flow.test.ts` (in-app live voice; 5 s timeouts, 21/21 alone);
  - `tests/unit/hook-config-protection.test.ts` (one 5 s timeout once; about 0.9 s alone).
- Vitest harness constraint: two first lazy imports of a route in flight at once can bypass
  `vi.mock`. The Postgres tests start the second request after the first's imports, then force
  the overlap with gates.
