-- Creator Studio v1 foundation (docs/creator-studio.md): AI character
-- profiles, reference assets, generations, templates, campaigns, posts,
-- social account connections, and a reserve/commit/release credit ledger.
-- All tables are tenant-scoped (organization_id, enforced app-side by
-- tenantDb() and DB-side by RLS below) except creator_templates, whose
-- organization_id is nullable for global platform-curated templates — same
-- pattern as prompts.

DO $$ BEGIN
  CREATE TYPE "CreatorProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorAssetSource" AS ENUM ('UPLOAD', 'GENERATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorAssetValidationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorGenerationType" AS ENUM ('IMAGE', 'IMAGE_TO_VIDEO', 'CAPTION', 'VOICE', 'CAMPAIGN_ASSET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorGenerationStatus" AS ENUM ('QUEUED', 'GENERATING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorCampaignApprovalMode" AS ENUM ('MANUAL', 'APPROVAL', 'AUTOPILOT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorPostApprovalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreatorPostPublishStatus" AS ENUM ('NOT_SCHEDULED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CreditTransactionType" AS ENUM ('GRANT', 'RESERVE', 'COMMIT', 'RELEASE', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "creator_profiles" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      UUID NOT NULL,
  "owner_user_id"        UUID,
  "display_name"         TEXT NOT NULL,
  "slug"                 TEXT NOT NULL,
  "status"               "CreatorProfileStatus" NOT NULL DEFAULT 'DRAFT',
  "description"          TEXT,
  "avatar_asset_id"      UUID,
  "consent_confirmed_at" TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_profiles_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_profiles_organization_id_slug_key"
  ON "creator_profiles"("organization_id", "slug");
CREATE INDEX IF NOT EXISTS "creator_profiles_organization_id_status_idx"
  ON "creator_profiles"("organization_id", "status");

CREATE TABLE IF NOT EXISTS "creator_reference_assets" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "creator_profile_id" UUID NOT NULL,
  "organization_id"    UUID NOT NULL,
  "storage_path"       TEXT NOT NULL,
  "asset_type"         TEXT NOT NULL,
  "mime_type"          TEXT NOT NULL,
  "size_bytes"         INTEGER NOT NULL,
  "source"             "CreatorAssetSource" NOT NULL DEFAULT 'UPLOAD',
  "validation_status"  "CreatorAssetValidationStatus" NOT NULL DEFAULT 'PENDING',
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_reference_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_reference_assets_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_reference_assets_creator_profile_id_fkey" FOREIGN KEY ("creator_profile_id")
    REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_reference_assets_organization_id_creator_profile_id_idx"
  ON "creator_reference_assets"("organization_id", "creator_profile_id");

CREATE TABLE IF NOT EXISTS "creator_templates" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID,
  "name"             TEXT NOT NULL,
  "slug"             TEXT NOT NULL,
  "category"         TEXT NOT NULL,
  "prompt_template"  TEXT NOT NULL,
  "generation_type"  "CreatorGenerationType" NOT NULL,
  "aspect_ratio"     TEXT NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "metadata"         JSONB NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_templates_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_templates_organization_id_category_active_idx"
  ON "creator_templates"("organization_id", "category", "active");

CREATE TABLE IF NOT EXISTS "creator_generations" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      UUID NOT NULL,
  "creator_profile_id"   UUID,
  "generation_type"      "CreatorGenerationType" NOT NULL,
  "provider"             TEXT NOT NULL,
  "model"                TEXT NOT NULL,
  "prompt"               TEXT NOT NULL,
  "negative_prompt"      TEXT,
  "template_id"          UUID,
  "input_asset_ids"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "output_asset_ids"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "output"               JSONB,
  "status"               "CreatorGenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "credits_reserved"     INTEGER NOT NULL DEFAULT 0,
  "credits_consumed"     INTEGER NOT NULL DEFAULT 0,
  "latency_ms"           INTEGER,
  "provider_request_id"  TEXT,
  "error_code"           TEXT,
  "error_message_safe"   TEXT,
  "created_by_id"        UUID NOT NULL,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"         TIMESTAMP(3),
  CONSTRAINT "creator_generations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_generations_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_generations_creator_profile_id_fkey" FOREIGN KEY ("creator_profile_id")
    REFERENCES "creator_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "creator_generations_template_id_fkey" FOREIGN KEY ("template_id")
    REFERENCES "creator_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_generations_organization_id_creator_profile_id_created_at_idx"
  ON "creator_generations"("organization_id", "creator_profile_id", "created_at");
CREATE INDEX IF NOT EXISTS "creator_generations_organization_id_status_idx"
  ON "creator_generations"("organization_id", "status");

CREATE TABLE IF NOT EXISTS "creator_campaigns" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        UUID NOT NULL,
  "name"                   TEXT NOT NULL,
  "objective"              TEXT,
  "status"                 "CreatorCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "target_platforms"       "SocialPlatform"[] NOT NULL DEFAULT ARRAY[]::"SocialPlatform"[],
  "target_languages"       "Locale"[] NOT NULL DEFAULT ARRAY[]::"Locale"[],
  "target_posts_per_week"  INTEGER,
  "starts_at"              TIMESTAMP(3),
  "ends_at"                TIMESTAMP(3),
  "approval_mode"          "CreatorCampaignApprovalMode" NOT NULL DEFAULT 'APPROVAL',
  "autopilot_enabled"      BOOLEAN NOT NULL DEFAULT false,
  "autopilot_rules"        JSONB,
  "created_by_id"          UUID NOT NULL,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_campaigns_organization_id_status_idx"
  ON "creator_campaigns"("organization_id", "status");

CREATE TABLE IF NOT EXISTS "social_accounts" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      UUID NOT NULL,
  "platform"             "SocialPlatform" NOT NULL,
  "external_account_id"  TEXT NOT NULL,
  "display_name"         TEXT NOT NULL,
  "access_token_enc"     TEXT,
  "refresh_token_enc"    TEXT,
  "scopes"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"               "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "token_expires_at"     TIMESTAMP(3),
  "last_error"           TEXT,
  "last_checked_at"      TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_accounts_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_accounts_organization_id_platform_external_account_id_key"
  ON "social_accounts"("organization_id", "platform", "external_account_id");
CREATE INDEX IF NOT EXISTS "social_accounts_organization_id_status_idx"
  ON "social_accounts"("organization_id", "status");

CREATE TABLE IF NOT EXISTS "creator_posts" (
  "id"                        UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"           UUID NOT NULL,
  "campaign_id"                UUID,
  "creator_profile_id"        UUID,
  "asset_ids"                 TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "caption"                   TEXT,
  "hashtags"                  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "platform"                  "SocialPlatform" NOT NULL,
  "social_account_id"         UUID,
  "approval_status"           "CreatorPostApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  "content_version"           INTEGER NOT NULL DEFAULT 1,
  "approved_content_version"  INTEGER,
  "approved_by_id"            UUID,
  "approved_at"               TIMESTAMP(3),
  "scheduled_for"             TIMESTAMP(3),
  "publish_status"            "CreatorPostPublishStatus" NOT NULL DEFAULT 'NOT_SCHEDULED',
  "external_post_id"          TEXT,
  "publish_attempt_count"     INTEGER NOT NULL DEFAULT 0,
  "published_at"              TIMESTAMP(3),
  "last_error_code"           TEXT,
  "last_error_safe"           TEXT,
  "created_by_id"             UUID NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_posts_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_posts_campaign_id_fkey" FOREIGN KEY ("campaign_id")
    REFERENCES "creator_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "creator_posts_creator_profile_id_fkey" FOREIGN KEY ("creator_profile_id")
    REFERENCES "creator_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "creator_posts_social_account_id_fkey" FOREIGN KEY ("social_account_id")
    REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_posts_organization_id_publish_status_scheduled_for_idx"
  ON "creator_posts"("organization_id", "publish_status", "scheduled_for");
CREATE INDEX IF NOT EXISTS "creator_posts_organization_id_campaign_id_idx"
  ON "creator_posts"("organization_id", "campaign_id");
CREATE INDEX IF NOT EXISTS "creator_posts_organization_id_approval_status_idx"
  ON "creator_posts"("organization_id", "approval_status");

CREATE TABLE IF NOT EXISTS "creator_credit_balances" (
  "organization_id"    UUID NOT NULL,
  "available_credits"  INTEGER NOT NULL DEFAULT 0,
  "reserved_credits"   INTEGER NOT NULL DEFAULT 0,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creator_credit_balances_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "creator_credit_balances_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "creator_credit_transactions" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   UUID NOT NULL,
  "generation_id"      UUID,
  "type"              "CreditTransactionType" NOT NULL,
  "amount"            INTEGER NOT NULL,
  "reason"            TEXT,
  "created_by_id"     UUID,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_credit_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_credit_transactions_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creator_credit_transactions_generation_id_fkey" FOREIGN KEY ("generation_id")
    REFERENCES "creator_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "creator_credit_transactions_organization_id_created_at_idx"
  ON "creator_credit_transactions"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "creator_credit_transactions_generation_id_idx"
  ON "creator_credit_transactions"("generation_id");

CREATE TABLE IF NOT EXISTS "creator_credit_grants" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   UUID NOT NULL,
  "period_start"      TIMESTAMP(3) NOT NULL,
  "amount"            INTEGER NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_credit_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_credit_grants_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_credit_grants_organization_id_period_start_key"
  ON "creator_credit_grants"("organization_id", "period_start");

ALTER TABLE "creator_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_reference_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_credit_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_credit_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creator_credit_grants" ENABLE ROW LEVEL SECURITY;

-- Client-facing RLS policies (mirrors prisma/sql/003_rls.sql's generic
-- tenant CRUD / read-only patterns; kept here too so a fresh migrate deploy
-- is never client-unprotected even before prisma/sql/003_rls.sql is re-run).
-- creator_reference_assets, social_accounts (holds encrypted token columns),
-- and the three credit tables are server-service-only (no client policy) —
-- same rationale as calendar_connections/document_upload_intents: token
-- material and balance mutation must only ever go through the audited,
-- rate-limited service layer, never a direct Supabase client query.

CREATE POLICY "creator_profiles_select" ON "creator_profiles" FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());
CREATE POLICY "creator_profiles_insert" ON "creator_profiles" FOR INSERT TO authenticated
  WITH CHECK (organization_id = auth_org_id());
CREATE POLICY "creator_profiles_update" ON "creator_profiles" FOR UPDATE TO authenticated
  USING (organization_id = auth_org_id());
CREATE POLICY "creator_profiles_delete" ON "creator_profiles" FOR DELETE TO authenticated
  USING (organization_id = auth_org_id() AND auth_role() IN ('OWNER', 'ADMIN', 'MANAGER'));

CREATE POLICY "creator_templates_select" ON "creator_templates" FOR SELECT TO authenticated
  USING (organization_id IS NULL OR organization_id = auth_org_id());

CREATE POLICY "creator_generations_select" ON "creator_generations" FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());

CREATE POLICY "creator_campaigns_select" ON "creator_campaigns" FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());
CREATE POLICY "creator_campaigns_insert" ON "creator_campaigns" FOR INSERT TO authenticated
  WITH CHECK (organization_id = auth_org_id());
CREATE POLICY "creator_campaigns_update" ON "creator_campaigns" FOR UPDATE TO authenticated
  USING (organization_id = auth_org_id());
CREATE POLICY "creator_campaigns_delete" ON "creator_campaigns" FOR DELETE TO authenticated
  USING (organization_id = auth_org_id() AND auth_role() IN ('OWNER', 'ADMIN', 'MANAGER'));

CREATE POLICY "creator_posts_select" ON "creator_posts" FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());
