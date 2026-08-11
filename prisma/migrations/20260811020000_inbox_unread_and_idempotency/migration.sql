-- Inbox: unread tracking + inbound-webhook idempotency.
--
-- inbox_threads.read_at: null = unread, reset to null whenever a new
-- inbound message arrives (see recordInboundMessage), stamped when a human
-- opens the thread.
--
-- inbox_messages.external_id unique: provider message ids (e.g. RFC 5322
-- Message-ID) are globally unique by construction, so this constraint
-- doubles as webhook-redelivery idempotency at the database layer —
-- multiple NULLs remain allowed, matching every other optional external_id
-- column in this schema.

ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_external_id_key" UNIQUE ("external_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
