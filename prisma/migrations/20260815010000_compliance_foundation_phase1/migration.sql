-- Trust & Compliance foundation, Phase 1 (Issue #74).
--
-- Syveka's own internal security/compliance domain: one reusable
-- ComplianceControl -> ControlFrameworkMapping[] -> ComplianceEvidence[]
-- model (Step 3), plus risk, policy, incident, subprocessor, GDPR
-- processing-record (ROPA), data-subject-request, retention, DPIA-lite
-- assessment, access-review, certification, and a dedicated append-only
-- compliance audit log.
--
-- Every table here is Syveka-platform-level, not tenant-owned: gated by
-- requireSuperadmin() at the service layer, excluded from TENANT_MODELS
-- (src/server/db/tenant.ts), RLS enabled with zero policies -- the same
-- deny-all-except-service-role pattern already used for
-- stripe_webhook_events (20260815000000_stripe_webhook_event_ledger) and
-- inbox_mailboxes. See docs/compliance/ARCHITECTURE.md.
--
-- compliance_audit_log is a dedicated table rather than a reuse of
-- audit_logs: audit_logs.organization_id is NOT NULL with
-- ON DELETE CASCADE to organizations because it is tenant-scoped by
-- design -- these actions have no organization to cascade from.

-- CreateEnum
CREATE TYPE "ComplianceFramework" AS ENUM ('GDPR', 'ISO27001', 'NIS2', 'SOC2', 'HIPAA');

-- CreateEnum
CREATE TYPE "ControlImplementationStatus" AS ENUM ('IMPLEMENTED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'EXTERNAL_VERIFICATION_REQUIRED');

-- CreateEnum
CREATE TYPE "ClaimVerificationState" AS ENUM ('TECHNICALLY_IMPLEMENTED', 'INTERNALLY_REVIEWED', 'EXTERNAL_AUDIT_REQUIRED', 'EXTERNALLY_VERIFIED', 'CERTIFIED');

-- CreateEnum
CREATE TYPE "ControlCategory" AS ENUM ('GOVERNANCE', 'ACCESS_CONTROL', 'DATA_PROTECTION', 'CRYPTOGRAPHY', 'LOGGING_MONITORING', 'INCIDENT_MANAGEMENT', 'BUSINESS_CONTINUITY', 'SUPPLIER_RISK', 'SECURE_DEVELOPMENT', 'PHYSICAL_ENVIRONMENTAL', 'HUMAN_RESOURCES', 'ASSET_MANAGEMENT', 'NETWORK_SECURITY');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('CI_RUN', 'TEST_SUITE', 'SECURITY_SCAN', 'DEPENDENCY_AUDIT', 'SECRET_SCAN', 'RLS_TEST', 'MIGRATION', 'AUDIT_LOG', 'ACCESS_REVIEW', 'POLICY_DOCUMENT', 'VENDOR_REVIEW', 'MANUAL_ATTESTATION', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceResultStatus" AS ENUM ('PASS', 'FAIL', 'PARTIAL', 'NOT_APPLICABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'APPROVED', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('DETECTED', 'INVESTIGATING', 'CONTAINED', 'REMEDIATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "NotificationRequirement" AS ENUM ('UNKNOWN', 'YES', 'NO');

-- CreateEnum
CREATE TYPE "SubprocessorRole" AS ENUM ('PROCESSOR', 'SUBPROCESSOR', 'CONTROLLER', 'JOINT_CONTROLLER');

-- CreateEnum
CREATE TYPE "TransferSafeguard" AS ENUM ('UNKNOWN', 'NONE', 'SCC', 'ADEQUACY_DECISION', 'OTHER_SAFEGUARD');

-- CreateEnum
CREATE TYPE "DpaStatus" AS ENUM ('UNKNOWN', 'NOT_REQUIRED', 'PENDING', 'SIGNED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('UNKNOWN', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETE');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTERESTS', 'PUBLIC_TASK', 'LEGITIMATE_INTERESTS');

-- CreateEnum
CREATE TYPE "DpiaRequirement" AS ENUM ('UNKNOWN', 'NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'COMPLETE');

-- CreateEnum
CREATE TYPE "DsrType" AS ENUM ('ACCESS', 'EXPORT', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION', 'PORTABILITY');

-- CreateEnum
CREATE TYPE "IdentityVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DsrStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RetentionExecutionStatus" AS ENUM ('SCHEDULED', 'EXECUTED', 'SKIPPED', 'HELD');

-- CreateEnum
CREATE TYPE "AssessmentType" AS ENUM ('NEW_AI_FEATURE', 'NEW_INTEGRATION', 'SENSITIVE_PROCESSING', 'HIGH_RISK_PROCESSING', 'MAJOR_DATA_FLOW_CHANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "AccessReviewScope" AS ENUM ('PRIVILEGED_USERS', 'ORG_ADMINS', 'API_KEYS', 'SERVICE_ACCOUNTS', 'INTERNAL_ADMIN_ROLES');

-- CreateTable
CREATE TABLE IF NOT EXISTS "compliance_controls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "control_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ControlCategory" NOT NULL,
    "implementation_status" "ControlImplementationStatus" NOT NULL DEFAULT 'MISSING',
    "verification_state" "ClaimVerificationState" NOT NULL DEFAULT 'TECHNICALLY_IMPLEMENTED',
    "owner_user_id" UUID,
    "review_date" TIMESTAMP(3),
    "implementation_notes" TEXT,
    "exception_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "control_framework_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "control_id" UUID NOT NULL,
    "framework" "ComplianceFramework" NOT NULL,
    "framework_reference" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_framework_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "compliance_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "control_id" UUID NOT NULL,
    "source_type" "EvidenceSourceType" NOT NULL,
    "source_identifier" TEXT NOT NULL,
    "result_status" "EvidenceResultStatus" NOT NULL,
    "summary" TEXT NOT NULL,
    "content_hash" TEXT,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "review_due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "compliance_risks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "risk_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "asset_or_system" TEXT NOT NULL,
    "threat_description" TEXT NOT NULL,
    "likelihood" "RiskLevel" NOT NULL,
    "impact" "RiskLevel" NOT NULL,
    "inherent_risk_level" "RiskLevel" NOT NULL,
    "mitigation_control_id" UUID,
    "residual_risk_level" "RiskLevel",
    "owner_user_id" UUID,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "review_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "security_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "owner_user_id" UUID,
    "effective_date" TIMESTAMP(3),
    "review_date" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "document_ref" TEXT NOT NULL,
    "acknowledgement_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "policy_acknowledgements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "security_incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "incident_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'DETECTED',
    "detected_at" TIMESTAMP(3) NOT NULL,
    "occurred_at" TIMESTAMP(3),
    "affected_organization_id" UUID,
    "affected_systems" TEXT,
    "affected_data_categories" TEXT,
    "containment_notes" TEXT,
    "remediation_notes" TEXT,
    "owner_user_id" UUID,
    "postmortem_ref" TEXT,
    "notification_required" "NotificationRequirement" NOT NULL DEFAULT 'UNKNOWN',
    "notification_early_warning_due_at" TIMESTAMP(3),
    "notification_authority_due_at" TIMESTAMP(3),
    "notification_final_report_due_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "incident_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "incident_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "subprocessors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "service_purpose" TEXT NOT NULL,
    "data_categories" TEXT NOT NULL,
    "role" "SubprocessorRole" NOT NULL DEFAULT 'SUBPROCESSOR',
    "region" TEXT,
    "data_residency" TEXT,
    "international_transfer" "TransferSafeguard" NOT NULL DEFAULT 'UNKNOWN',
    "dpa_status" "DpaStatus" NOT NULL DEFAULT 'UNKNOWN',
    "security_review_status" "ReviewStatus" NOT NULL DEFAULT 'UNKNOWN',
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "owner_user_id" UUID,
    "review_date" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subprocessors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "processing_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "activity_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "data_categories" TEXT NOT NULL,
    "data_subject_categories" TEXT NOT NULL,
    "lawful_basis" "LawfulBasis" NOT NULL,
    "recipients" TEXT,
    "processor_notes" TEXT,
    "retention_period" TEXT NOT NULL,
    "international_transfers" TEXT,
    "safeguards" TEXT,
    "system_location" TEXT,
    "owner_user_id" UUID,
    "review_date" TIMESTAMP(3),
    "dpia_status" "DpiaRequirement" NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "data_subject_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_key" TEXT NOT NULL,
    "request_type" "DsrType" NOT NULL,
    "subject_contact_reference" TEXT NOT NULL,
    "related_organization_id" UUID,
    "received_at" TIMESTAMP(3) NOT NULL,
    "identity_verification_status" "IdentityVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "status" "DsrStatus" NOT NULL DEFAULT 'RECEIVED',
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "assigned_owner_user_id" UUID,
    "completed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "dsr_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsr_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "retention_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "data_category" TEXT NOT NULL,
    "retention_period" TEXT NOT NULL,
    "tenant_overridable" BOOLEAN NOT NULL DEFAULT false,
    "legal_hold_supported" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "retention_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "retention_policy_id" UUID,
    "data_category" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "status" "RetentionExecutionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "record_count" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "privacy_security_assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_key" TEXT NOT NULL,
    "assessment_type" "AssessmentType" NOT NULL,
    "feature_or_system" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "risks_identified" TEXT,
    "safeguards" TEXT,
    "owner_user_id" UUID,
    "dpia_required" "DpiaRequirement" NOT NULL DEFAULT 'UNKNOWN',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'UNKNOWN',
    "review_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_security_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "access_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_key" TEXT NOT NULL,
    "scope" "AccessReviewScope" NOT NULL,
    "performed_by_user_id" UUID,
    "performed_at" TIMESTAMP(3) NOT NULL,
    "findings_summary" TEXT NOT NULL,
    "stale_access_found" BOOLEAN NOT NULL DEFAULT false,
    "actions_taken" TEXT,
    "next_review_due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "certifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "framework" "ComplianceFramework" NOT NULL,
    "certification_type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "issuer" TEXT,
    "issue_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "verification_reference" TEXT,
    "verification_state" "ClaimVerificationState" NOT NULL DEFAULT 'INTERNALLY_REVIEWED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "compliance_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "compliance_controls_control_key_key" ON "compliance_controls"("control_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_controls_category_idx" ON "compliance_controls"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_controls_implementation_status_idx" ON "compliance_controls"("implementation_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "control_framework_mappings_framework_idx" ON "control_framework_mappings"("framework");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "control_framework_mappings_control_id_framework_framework_r_key" ON "control_framework_mappings"("control_id", "framework", "framework_reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_evidence_control_id_idx" ON "compliance_evidence"("control_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_evidence_review_due_at_idx" ON "compliance_evidence"("review_due_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "compliance_risks_risk_key_key" ON "compliance_risks"("risk_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_risks_status_idx" ON "compliance_risks"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "security_policies_policy_key_version_key" ON "security_policies"("policy_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "policy_acknowledgements_policy_id_user_id_key" ON "policy_acknowledgements"("policy_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "security_incidents_incident_key_key" ON "security_incidents"("incident_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "security_incidents_status_idx" ON "security_incidents"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "security_incidents_affected_organization_id_idx" ON "security_incidents"("affected_organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "incident_events_incident_id_occurred_at_idx" ON "incident_events"("incident_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subprocessors_name_key" ON "subprocessors"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "processing_records_activity_key_key" ON "processing_records"("activity_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "data_subject_requests_request_key_key" ON "data_subject_requests"("request_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "data_subject_requests_status_idx" ON "data_subject_requests"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "data_subject_requests_related_organization_id_idx" ON "data_subject_requests"("related_organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dsr_events_request_id_occurred_at_idx" ON "dsr_events"("request_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "retention_policies_data_category_key" ON "retention_policies"("data_category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "retention_executions_status_idx" ON "retention_executions"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "privacy_security_assessments_assessment_key_key" ON "privacy_security_assessments"("assessment_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "access_reviews_review_key_key" ON "access_reviews"("review_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "certifications_framework_idx" ON "certifications"("framework");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_audit_log_resource_type_resource_id_idx" ON "compliance_audit_log"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_audit_log_created_at_idx" ON "compliance_audit_log"("created_at");

-- AddForeignKey
ALTER TABLE "control_framework_mappings" ADD CONSTRAINT "control_framework_mappings_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "compliance_controls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evidence" ADD CONSTRAINT "compliance_evidence_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "compliance_controls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_risks" ADD CONSTRAINT "compliance_risks_mitigation_control_id_fkey" FOREIGN KEY ("mitigation_control_id") REFERENCES "compliance_controls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "security_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "security_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsr_events" ADD CONSTRAINT "dsr_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "data_subject_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_executions" ADD CONSTRAINT "retention_executions_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "retention_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Server-only tables: RLS enabled, zero policies (deny-all for
-- PostgREST/anon/authenticated; only the Prisma service-role connection,
-- gated by requireSuperadmin(), can access these).
ALTER TABLE "compliance_controls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "control_framework_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_risks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_acknowledgements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "incident_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subprocessors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processing_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_subject_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dsr_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retention_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privacy_security_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "certifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_audit_log" ENABLE ROW LEVEL SECURITY;
