-- Additive correction for tenant relationship integrity. Do not fold this into
-- either previously published production-hardening migration.

CREATE UNIQUE INDEX IF NOT EXISTS "collections_organization_id_id_key"
  ON "collections"("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "documents_organization_id_id_key"
  ON "documents"("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_organization_id_id_key"
  ON "conversations"("organization_id", "id");

ALTER TABLE "documents"
  DROP CONSTRAINT IF EXISTS "documents_collection_id_fkey";
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_organization_id_collection_id_fkey"
  FOREIGN KEY ("organization_id", "collection_id")
  REFERENCES "collections"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "conversation_documents"
  DROP CONSTRAINT IF EXISTS "conversation_documents_conversation_id_fkey",
  DROP CONSTRAINT IF EXISTS "conversation_documents_document_id_fkey";
ALTER TABLE "conversation_documents"
  ADD CONSTRAINT "conversation_documents_organization_id_conversation_id_fkey"
  FOREIGN KEY ("organization_id", "conversation_id")
  REFERENCES "conversations"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "conversation_documents_organization_id_document_id_fkey"
  FOREIGN KEY ("organization_id", "document_id")
  REFERENCES "documents"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_chunks"
  DROP CONSTRAINT IF EXISTS "document_chunks_document_id_fkey";
ALTER TABLE "document_chunks"
  ADD CONSTRAINT "document_chunks_organization_id_document_id_fkey"
  FOREIGN KEY ("organization_id", "document_id")
  REFERENCES "documents"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_upload_intents"
  ADD CONSTRAINT "document_upload_intents_tenant_path_check"
  CHECK ("storage_path" LIKE "organization_id"::text || '/%') NOT VALID;
ALTER TABLE "document_upload_intents"
  VALIDATE CONSTRAINT "document_upload_intents_tenant_path_check";
