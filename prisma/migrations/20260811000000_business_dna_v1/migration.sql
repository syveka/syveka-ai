-- Business DNA V1: tenant-scoped operational business context consumed by
-- Inbox, Voice, Booking and CRM. One profile per organization.

CREATE TABLE IF NOT EXISTS "business_dna" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"     UUID NOT NULL,
  "display_name"        TEXT,
  "industry"            TEXT,
  "products_services"   TEXT,
  "supported_locales"   "Locale"[] NOT NULL DEFAULT ARRAY[]::"Locale"[],
  "brand_tone"          TEXT,
  "communication_style" TEXT,
  "opening_hours"       JSONB,
  "policies"            TEXT,
  "pricing_notes"       TEXT,
  "target_customer"     TEXT,
  "key_facts"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_url"          TEXT,
  "extracted_at"        TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_dna_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_dna_organization_id_key" UNIQUE ("organization_id"),
  CONSTRAINT "business_dna_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Client-writable, organization-scoped table: same authenticated CRUD shape
-- as `prompts` (see 20260719000000_initial_security_baseline).
ALTER TABLE "business_dna" ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_dna_select ON public.business_dna
  FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());

CREATE POLICY business_dna_insert ON public.business_dna
  FOR INSERT TO authenticated WITH CHECK (organization_id = auth_org_id());

CREATE POLICY business_dna_update ON public.business_dna
  FOR UPDATE TO authenticated USING (organization_id = auth_org_id());

CREATE POLICY business_dna_delete ON public.business_dna
  FOR DELETE TO authenticated
  USING (
    organization_id = auth_org_id()
    AND auth_role() IN ('OWNER', 'ADMIN', 'MANAGER')
  );
