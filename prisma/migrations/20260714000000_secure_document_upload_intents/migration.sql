-- Server-issued, tenant-bound, expiring, one-time document upload intents.
CREATE TABLE IF NOT EXISTS "document_upload_intents" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    UUID NOT NULL,
  "user_id"            UUID NOT NULL,
  "storage_path"       TEXT NOT NULL,
  "expected_mime_type" TEXT NOT NULL,
  "max_size_bytes"     INTEGER NOT NULL,
  "expires_at"         TIMESTAMP(3) NOT NULL,
  "used_at"            TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_upload_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_upload_intents_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_upload_intents_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_upload_intents_storage_path_key"
  ON "document_upload_intents"("storage_path");
CREATE INDEX IF NOT EXISTS "document_upload_intents_organization_id_user_id_expires_at_idx"
  ON "document_upload_intents"("organization_id", "user_id", "expires_at");

-- Intents are server-only. Enabling RLS without client policies denies direct API access.
ALTER TABLE "document_upload_intents" ENABLE ROW LEVEL SECURITY;
