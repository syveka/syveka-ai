-- Inbox mailbox resolution: the server-controlled mapping an inbound
-- webhook resolves the organization from. Never trust an organization id
-- supplied directly in an inbound payload; resolve it through this table
-- via the verified recipient address instead. Server-only for now: RLS is
-- enabled but no client policies are granted, matching inbox_threads/
-- inbox_messages — every access path goes through the service layer.

CREATE TABLE IF NOT EXISTS "inbox_mailboxes" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "channel"         "InboxChannel" NOT NULL DEFAULT 'EMAIL',
  "address"         TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbox_mailboxes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_mailboxes_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbox_mailboxes_organization_id_channel_key"
  ON "inbox_mailboxes"("organization_id", "channel");
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_mailboxes_channel_address_key"
  ON "inbox_mailboxes"("channel", "address");

ALTER TABLE "inbox_mailboxes" ENABLE ROW LEVEL SECURITY;
