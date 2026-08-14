# Stripe Webhook Reliability

Branch: `agent/p0-stripe-webhook-reliability` · Status: ready for review · No production/live Stripe access used to build or verify this.

## The problem this closes

`src/app/api/v1/webhooks/stripe/route.ts` guarded against duplicate processing with a single
Redis `SET NX` call, claimed **before** the event was actually processed:

```ts
const dedupe = await redis.set(`stripe:evt:${event.id}`, "1", { nx: true, ex: 86_400 });
if (dedupe === null) return NextResponse.json({ received: true, duplicate: true });
// ... business mutation happens after this point ...
```

**Failure mode**: if the business mutation (`upsertSubscription`, the PAST_DUE transition, the
downgrade-to-FREE transition, etc.) threw for any transient reason — a momentary DB connection
blip, a Stripe API hiccup on the `subscriptions.retrieve()` call, a bug — the handler correctly
returned HTTP 500 so Stripe would retry. But the dedupe key was already set. On Stripe's retry
(same `event.id`), `redis.set(..., { nx: true })` returned `null` — the retry was silently
treated as an already-handled duplicate and the switch statement never ran a second time. Stripe
received `{ received: true, duplicate: true }` (a 200) and stopped retrying, believing the event
was handled. It never was. This is a **claim-before-confirm** bug, not a case of Stripe retrying
too eagerly.

Two secondary problems followed from the same design:

- **Redis was the sole source of truth** for "was this event processed." No database record of
  processing state existed at all — no way to distinguish "never received" from "processing" from
  "failed" from "done," no attempt count, no error visibility beyond an ephemeral
  `console.error` in serverless logs.
- **No protection against a crashed-mid-processing execution.** If a serverless invocation died
  after the (then-nonexistent) claim but before finishing, nothing could ever reclaim that event —
  the same premature-completion problem, triggered by a crash instead of a thrown error.

No production incident evidence was required to establish this — it is provable directly from the
code: the `redis.set` call precedes the `try { switch (event.type) { ... } }` block that performs
every business mutation.

## Design alternatives considered

| Option                                                                          | Verdict                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep Redis as the sole dedupe mechanism, just move the `SET` to _after_ success | Rejected — still not durable (Redis eviction/outage loses all history with no recovery path), still gives zero observability into attempts/errors, and the task's own explicit requirement rules out Redis as sole source of truth for financial event completion.                                                        |
| A durable database event ledger with typed states (chosen)                      | One new table, keyed by Stripe's own globally-unique event id. Completion is recorded only inside the same DB transaction as the business mutation it depends on. Attempts, timestamps, and sanitized errors are queryable. Survives serverless restarts and Redis unavailability alike.                                  |
| A separate dedicated "lease" table, distinct from the event ledger              | Rejected — the ledger row _is_ the natural lease target (one row per Stripe event, exactly the granularity needed); a second table would mean coordinating two tables' state instead of one, for no added safety.                                                                                                         |
| `SERIALIZABLE` transaction isolation around the whole handler                   | Rejected — Postgres can abort `SERIALIZABLE` transactions under contention, which still requires application-level retry logic, so it doesn't remove the need for an explicit state machine; it only adds a heavier isolation mode on top of one.                                                                         |
| `pg_advisory_lock` for per-event mutual exclusion                               | Rejected — session-scoped locks don't compose well with a connection-pooled, `await`-heavy handler that calls out to the Stripe API mid-flight (a pooled connection can be recycled between lock and unlock), and they leave no durable, queryable trail — worse for the explicit "observable and auditable" requirement. |
| Store the full Stripe event payload for replay                                  | Rejected — the ledger stores only `stripeEventId`, `eventType`, a best-effort `objectId` (a Stripe object id, not sensitive), attempt metadata, and a truncated/URL-redacted error string. No raw webhook payload and no payment/card data is ever persisted.                                                             |

The chosen design is the smallest one that satisfies every requirement: **one new table, no new
external dependency, reuses Prisma's existing transaction primitive, and removes Redis from this
code path entirely** rather than layering a second, potentially-inconsistent coordination
mechanism on top of the database ledger.

## State machine

```
RECEIVED --(claim: atomic conditional UPDATE)--> PROCESSING --(business mutation + ledger
   ^                                                  |          update commit together)--> COMPLETED
   |                                                  |
   +----------------(handler throws)-----------------+--> FAILED --(next delivery/retry
                                                                      re-claims: same as RECEIVED)
```

- **`RECEIVED`**: a row was just created for this `stripeEventId`. Always claimable.
- **`PROCESSING`**: an execution has claimed the row and is actively running the business
  mutation. A fresh `PROCESSING` row is _not_ reclaimable — a concurrent/near-concurrent duplicate
  delivery gets `{ received: true, processing: true }` and does not reprocess. A `PROCESSING` row
  whose `last_attempt_at` is older than `STALE_PROCESSING_MS` (5 minutes — comfortably longer than
  this handler's realistic worst-case runtime) _is_ reclaimable, so a crashed execution can never
  strand an event forever.
- **`COMPLETED`**: the business mutation and the ledger's own transition to `COMPLETED` committed
  together, in the same `unscopedPrisma.$transaction(...)`. There is no window where the mutation
  succeeded but completion wasn't recorded, or vice versa. Any later delivery of the same event id
  returns `{ received: true, duplicate: true }` immediately, with zero reprocessing.
- **`FAILED`**: the handler threw. The `FAILED` write happens _after_ the failed transaction has
  already rolled back, as a separate statement — it is the only state write that can follow a
  failure. A `FAILED` row is always reclaimable by the next delivery (Stripe's own retry, or a
  redelivery), exactly like a fresh `RECEIVED` row.

## Concurrency guarantee

Claiming a row is a single conditional `UPDATE ... WHERE stripe_event_id = ? AND (status IN
('RECEIVED','FAILED') OR (status = 'PROCESSING' AND last_attempt_at < ?))`, issued via Prisma's
`updateMany` and checked by its returned `count`. This is not read-then-write: Postgres locks the
matching row for the duration of the `UPDATE`, so two concurrent requests targeting the same event
id serialize at the database — exactly one `updateMany` call affects a row (`count: 1`), the other
matches zero rows (`count: 0`) and is told `{ received: true, processing: true }` without ever
running the business mutation. This holds regardless of which of the two requests' `create()` call
happened to win the initial unique-constraint race on `stripe_event_id`.

## Data stored

`stripe_webhook_events` (`prisma/migrations/20260815000000_stripe_webhook_event_ledger/`):
`stripeEventId` (unique), `eventType`, `status`, `organizationId` (nullable, best-effort, never an
access-control boundary), `objectId` (a Stripe object id such as a subscription/invoice id, not
sensitive), `attempts`, `lastError` (URL-redacted, truncated to 500 chars — never a raw payload,
never a stack trace, never payment/card data), `firstSeenAt`, `lastAttemptAt`, `completedAt`.

RLS is enabled with **zero policies** — matching `document_upload_intents`, `inbox_mailboxes`, and
every other server-only table in this schema: every access path goes through the Prisma
service-role connection (`unscopedPrisma`), never a client-authenticated Supabase path. This table
is deliberately **not** added to `TENANT_MODELS` (`src/server/db/tenant.ts`) — every lookup is by
the globally-unique `stripeEventId`, never by organization, so tenant-scoping doesn't apply, the
same reasoning that already excludes `User`/`Organization`.

## What did not change

- Signature verification (`stripe.webhooks.constructEvent`) is untouched and still runs before any
  ledger interaction — an invalid signature never creates a ledger row.
- The exact subscription-upsert field mapping, the FREE-downgrade-on-delete behavior, and the
  PAST_DUE transition on `invoice.payment_failed` are byte-for-byte the same as before; they now
  run against a Prisma transaction client (`tx`) instead of `unscopedPrisma` directly, so they can
  commit atomically with the ledger's `COMPLETED` write.
- Entitlement cache invalidation (`invalidateEntitlements`) still runs, now after the transaction
  commits rather than inline with the mutation — it is a cache invalidation, not a source of
  truth, so this ordering has no correctness impact and avoids invalidating a cache entry for a
  mutation that ultimately rolled back.
- Unhandled/unsupported Stripe event types are still acknowledged with `{ received: true }` and no
  business mutation — they are now also marked `COMPLETED` in the ledger, so they are never
  needlessly reprocessed on redelivery.
