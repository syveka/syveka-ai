-- Durable idempotency ledger for inbound Stripe webhook events (§14.4).
--
-- Replaces a Redis-only `SET NX` dedupe key that was claimed *before* event
-- processing completed: a transient failure after the claim permanently
-- suppressed Stripe's own retry for that event, since the retry saw the key
-- already set and short-circuited without ever reprocessing. This table
-- makes completion durable and conditional on the business mutation
-- actually succeeding, and lets a failed or interrupted attempt be safely
-- reclaimed and retried. Keyed by Stripe's own globally-unique event id --
-- not org-scoped, so it is server-only: RLS is enabled but no client
-- policies are granted, matching inbox_mailboxes/inbox_threads/
-- document_upload_intents -- every access path goes through the service
-- layer via the Prisma service-role connection.

CREATE TYPE "StripeWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "stripe_event_id"  TEXT NOT NULL,
  "event_type"       TEXT NOT NULL,
  "status"           "StripeWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "organization_id"  UUID,
  "object_id"        TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "last_error"       TEXT,
  "first_seen_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at"  TIMESTAMP(3),
  "completed_at"     TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_events_stripe_event_id_key"
  ON "stripe_webhook_events"("stripe_event_id");
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_status_last_attempt_at_idx"
  ON "stripe_webhook_events"("status", "last_attempt_at");

ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;
