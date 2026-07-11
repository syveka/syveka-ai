-- CRM Dashboard V1 read-path indexes.
-- Ownership: Prisma migration history. Do not duplicate these indexes in prisma/sql setup files.
CREATE INDEX IF NOT EXISTS "deals_organization_id_closed_at_idx"
  ON "deals"("organization_id", "closed_at");

CREATE INDEX IF NOT EXISTS "deals_organization_id_pipeline_id_closed_at_idx"
  ON "deals"("organization_id", "pipeline_id", "closed_at");

CREATE INDEX IF NOT EXISTS "activities_organization_id_type_due_at_idx"
  ON "activities"("organization_id", "type", "due_at");

CREATE INDEX IF NOT EXISTS "activities_organization_id_type_created_at_idx"
  ON "activities"("organization_id", "type", "created_at");

CREATE INDEX IF NOT EXISTS "conversations_organization_id_updated_at_idx"
  ON "conversations"("organization_id", "updated_at");
