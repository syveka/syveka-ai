-- Inbox MVP foundation: a unified, channel-agnostic conversation surface
-- (email/SMS/WhatsApp/web chat today, extensible to more). Server-only for
-- now: RLS is enabled on both tables but no client policies are granted,
-- matching document_upload_intents/calendar_connections — every access path
-- in this MVP goes through the audited, RBAC-checked service layer, not a
-- direct Supabase client query. Add client policies later only if a real
-- direct-client use case (e.g. Realtime) emerges.

DO $$ BEGIN
  CREATE TYPE "InboxChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP', 'WEB_CHAT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "InboxThreadStatus" AS ENUM ('OPEN', 'PENDING', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "InboxMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "InboxMessageStatus" AS ENUM ('RECEIVED', 'DRAFT', 'APPROVED', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "inbox_threads" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "channel"          "InboxChannel" NOT NULL,
  "status"           "InboxThreadStatus" NOT NULL DEFAULT 'OPEN',
  "subject"          TEXT,
  "contact_id"       UUID,
  "assigned_to_id"   UUID,
  "external_id"      TEXT,
  "last_message_at"  TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  "deleted_at"       TIMESTAMP(3),
  CONSTRAINT "inbox_threads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_threads_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbox_threads_contact_id_fkey" FOREIGN KEY ("contact_id")
    REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "inbox_threads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "inbox_threads_organization_id_status_last_message_at_idx"
  ON "inbox_threads"("organization_id", "status", "last_message_at");
CREATE INDEX IF NOT EXISTS "inbox_threads_contact_id_idx"
  ON "inbox_threads"("contact_id");

CREATE TABLE IF NOT EXISTS "inbox_messages" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "thread_id"       UUID NOT NULL,
  "direction"       "InboxMessageDirection" NOT NULL,
  "status"          "InboxMessageStatus" NOT NULL DEFAULT 'RECEIVED',
  "from_address"    TEXT,
  "to_address"      TEXT,
  "body"            TEXT NOT NULL,
  "ai_generated"    BOOLEAN NOT NULL DEFAULT false,
  "approved_by_id"  UUID,
  "approved_at"     TIMESTAMP(3),
  "sent_at"         TIMESTAMP(3),
  "external_id"     TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_messages_thread_id_fkey" FOREIGN KEY ("thread_id")
    REFERENCES "inbox_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbox_messages_approved_by_id_fkey" FOREIGN KEY ("approved_by_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "inbox_messages_thread_id_created_at_idx"
  ON "inbox_messages"("thread_id", "created_at");

ALTER TABLE "inbox_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_messages" ENABLE ROW LEVEL SECURITY;
