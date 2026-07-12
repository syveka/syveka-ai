-- CRM Contacts & Companies V1.
-- Adds archive support to contacts/companies, links activities to companies,
-- and read-path indexes for company lists and timelines.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "company_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activities_company_id_fkey'
  ) THEN
    ALTER TABLE "activities"
      ADD CONSTRAINT "activities_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "activities_company_id_idx"
  ON "activities"("company_id");

CREATE INDEX IF NOT EXISTS "companies_organization_id_name_idx"
  ON "companies"("organization_id", "name");
