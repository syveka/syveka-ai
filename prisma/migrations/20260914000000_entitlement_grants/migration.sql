-- Internal/pilot entitlement overrides. NOT a Stripe subscription and NOT a
-- change to Subscription.plan: a superadmin-issued, per-org, per-metric,
-- strictly additive bonus on top of whatever the org's real plan already
-- grants. getEntitlements() (src/server/services/billing/entitlements.ts)
-- sums every active (not expired, not revoked) grant's amount into the
-- corresponding PlanLimits field -- it can only ever increase an effective
-- limit, never decrease one below what the plan itself already grants.
--
-- Service-role-only, matching calendar_connections/document_upload_intents/
-- creator_credit_grants: RLS is enabled with NO client policy at all, so no
-- authenticated org member can read or write this table directly through
-- Supabase -- every grant/revoke goes through the audited superadmin-gated
-- service layer. This table is also created after
-- 20260826000000_harden_business_dna_table_privileges's
-- `ALTER DEFAULT PRIVILEGES ... REVOKE TRUNCATE, REFERENCES, TRIGGER (,
-- MAINTAIN on pg17+) ON TABLES FROM anon, authenticated`, so it never
-- inherits those excess grants either -- no repeat of that hardening is
-- needed here.

DO $$ BEGIN
  CREATE TYPE "EntitlementMetric" AS ENUM (
    'MAX_SEATS',
    'AI_MESSAGES_PER_USER_MONTH',
    'VOICE_ASSISTANTS',
    'VOICE_MINUTES_MONTH',
    'KB_STORAGE_MB',
    'ACTIVE_WORKFLOWS',
    'MAX_CONTACTS',
    'AUDIT_RETENTION_DAYS',
    'CREATOR_CREDITS_PER_MONTH'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "entitlement_grants" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       UUID NOT NULL,
  "metric"                "EntitlementMetric" NOT NULL,
  "amount"                INTEGER NOT NULL,
  "reason"                TEXT NOT NULL,
  "granted_by_user_id"    UUID,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"            TIMESTAMP(3),
  "revoked_at"            TIMESTAMP(3),
  "revoked_by_user_id"    UUID,
  CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entitlement_grants_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "entitlement_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "entitlement_grants_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "entitlement_grants_organization_id_metric_idx"
  ON "entitlement_grants"("organization_id", "metric");

ALTER TABLE "entitlement_grants" ENABLE ROW LEVEL SECURITY;
