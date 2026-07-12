-- CRM Deals & Sales Pipeline V1.
-- Adds per-deal probability override, kanban ordering, an owner read-path
-- index, and a STAGE_CHANGE activity type for the deal timeline.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "probability" INTEGER;

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "deals_organization_id_owner_id_idx"
  ON "deals"("organization_id", "owner_id");

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'STAGE_CHANGE';
