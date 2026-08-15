-- Business DNA MVP: structures the parts of the business profile that
-- genuinely benefit from structure rather than one text blob (Products &
-- Services get individual active/price/duration state; Policies split into
-- cancellation/booking/refund/payment; Pricing & Quotes gets currency and
-- quote instructions; Company Identity gains description and timezone).
--
-- `business_dna.policies` is intentionally NOT dropped or renamed at the
-- database level -- the Prisma field is now `otherPolicies` via `@map`, so
-- any existing data in that column is preserved and simply repurposed as
-- the general/other-policies catch-all, with zero data migration risk.

-- AlterTable
ALTER TABLE "business_dna" ADD COLUMN     "booking_policy" TEXT,
ADD COLUMN     "cancellation_policy" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "payment_policy" TEXT,
ADD COLUMN     "quote_instructions" TEXT,
ADD COLUMN     "refund_policy" TEXT,
ADD COLUMN     "response_instructions" TEXT,
ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "business_dna_services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "business_dna_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER,
    "price_note" TEXT,
    "duration_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_dna_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "business_dna_services_organization_id_is_active_idx" ON "business_dna_services"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "business_dna_services_business_dna_id_idx" ON "business_dna_services"("business_dna_id");

-- AddForeignKey
ALTER TABLE "business_dna_services" ADD CONSTRAINT "business_dna_services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_dna_services" ADD CONSTRAINT "business_dna_services_business_dna_id_fkey" FOREIGN KEY ("business_dna_id") REFERENCES "business_dna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Client-writable, organization-scoped table: same authenticated CRUD shape
-- as `business_dna` itself (see 20260811000000_business_dna_v1) -- SELECT/
-- INSERT/UPDATE for any authenticated org member, DELETE restricted to
-- OWNER/ADMIN/MANAGER, matching the app-layer "business-dna:write" RBAC set.
ALTER TABLE "business_dna_services" ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_dna_services_select ON public.business_dna_services
  FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());

CREATE POLICY business_dna_services_insert ON public.business_dna_services
  FOR INSERT TO authenticated WITH CHECK (organization_id = auth_org_id());

CREATE POLICY business_dna_services_update ON public.business_dna_services
  FOR UPDATE TO authenticated USING (organization_id = auth_org_id());

CREATE POLICY business_dna_services_delete ON public.business_dna_services
  FOR DELETE TO authenticated
  USING (
    organization_id = auth_org_id()
    AND auth_role() IN ('OWNER', 'ADMIN', 'MANAGER')
  );
