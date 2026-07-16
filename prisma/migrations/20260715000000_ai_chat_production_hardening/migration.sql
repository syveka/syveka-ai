ALTER TABLE "conversations"
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "summary_message_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "summary_updated_at" TIMESTAMP(3);

ALTER TABLE "messages"
  ADD COLUMN "estimated_cost_usd" DECIMAL(12, 8);

CREATE TABLE "conversation_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_documents_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_documents_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_documents_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "conversation_documents_conversation_id_document_id_key"
  ON "conversation_documents"("conversation_id", "document_id");
CREATE INDEX "conversation_documents_organization_id_conversation_id_idx"
  ON "conversation_documents"("organization_id", "conversation_id");
CREATE INDEX "conversation_documents_document_id_idx"
  ON "conversation_documents"("document_id");

ALTER TABLE "conversation_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY "conversation_documents_tenant_isolation" ON "conversation_documents"
  FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());
