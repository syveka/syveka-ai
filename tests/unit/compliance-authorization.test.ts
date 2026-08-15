import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every compliance service function must call requireSuperadmin() before
 * touching data (Step 16: "ordinary users cannot perform privileged
 * compliance actions"), and none of the 18 new tables may be tenant-scoped
 * or carry a Supabase-authenticated RLS policy (Step 16: these are
 * Syveka-platform data, not tenant data -- see
 * docs/compliance/ARCHITECTURE.md). TENANT_MODELS exclusion itself is
 * covered by tests/unit/tenant-models-coverage.test.ts; this file covers
 * the service-layer gate and the RLS declaration.
 */

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(async () => ({ userId: "superadmin-1", email: "admin@syveka.ai" })),
  create: vi.fn(async (_args: unknown) => ({ id: "row-1" })),
  update: vi.fn(async (_args: unknown) => ({ id: "row-1" })),
  upsert: vi.fn(async (_args: unknown) => ({ id: "row-1" })),
  findMany: vi.fn(async (_args?: unknown) => []),
  findUnique: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
  count: vi.fn(async (_args?: unknown) => 0),
  auditCreate: vi.fn(async (_args: unknown) => ({ id: "audit-1" })),
}));

vi.mock("@/server/auth/superadmin", () => ({
  requireSuperadmin: mocks.requireSuperadmin,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
}));

function makeModel() {
  return {
    create: mocks.create,
    update: mocks.update,
    upsert: mocks.upsert,
    findMany: mocks.findMany,
    findUnique: mocks.findUnique,
    count: mocks.count,
  };
}

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    complianceControl: makeModel(),
    controlFrameworkMapping: makeModel(),
    complianceEvidence: makeModel(),
    complianceRisk: makeModel(),
    securityPolicy: makeModel(),
    policyAcknowledgement: makeModel(),
    securityIncident: makeModel(),
    incidentEvent: makeModel(),
    subprocessor: makeModel(),
    processingRecord: makeModel(),
    dataSubjectRequest: makeModel(),
    dsrEvent: makeModel(),
    retentionPolicy: makeModel(),
    retentionExecution: makeModel(),
    privacySecurityAssessment: makeModel(),
    accessReview: makeModel(),
    certification: makeModel(),
    complianceAuditLog: { create: mocks.auditCreate },
    organizationMember: makeModel(),
    apiKey: makeModel(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSuperadmin.mockResolvedValue({ userId: "superadmin-1", email: "admin@syveka.ai" });
  mocks.create.mockResolvedValue({ id: "row-1" });
  mocks.update.mockResolvedValue({ id: "row-1" });
  mocks.upsert.mockResolvedValue({ id: "row-1" });
  mocks.findMany.mockResolvedValue([]);
  mocks.findUnique.mockResolvedValue({ id: "row-1", verificationState: "TECHNICALLY_IMPLEMENTED" });
  mocks.count.mockResolvedValue(0);
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
});

const deniedError = () => {
  const err = new Error("Superadmin required");
  (err as { status?: number }).status = 403;
  return err;
};

describe("compliance domain: every write path requires superadmin", () => {
  it.each([
    [
      "controls.createControl",
      async () => {
        const { createControl } = await import("@/server/services/compliance/controls");
        return createControl({
          controlKey: "K",
          title: "T",
          description: "D",
          category: "GOVERNANCE",
        });
      },
    ],
    [
      "risks.createRisk",
      async () => {
        const { createRisk } = await import("@/server/services/compliance/risks");
        return createRisk({
          riskKey: "R",
          title: "T",
          description: "D",
          category: "c",
          assetOrSystem: "a",
          threatDescription: "t",
          likelihood: "LOW",
          impact: "LOW",
          inherentRiskLevel: "LOW",
        });
      },
    ],
    [
      "policies.createPolicy",
      async () => {
        const { createPolicy } = await import("@/server/services/compliance/policies");
        return createPolicy({ policyKey: "P", title: "T", version: "1", documentRef: "docs/x.md" });
      },
    ],
    [
      "incidents.createIncident",
      async () => {
        const { createIncident } = await import("@/server/services/compliance/incidents");
        return createIncident({
          incidentKey: "INC-1",
          title: "T",
          description: "D",
          severity: "LOW",
          detectedAt: new Date(),
        });
      },
    ],
    [
      "subprocessors.createSubprocessor",
      async () => {
        const { createSubprocessor } = await import("@/server/services/compliance/subprocessors");
        return createSubprocessor({ name: "Vendor", servicePurpose: "p", dataCategories: "c" });
      },
    ],
    [
      "processingRecords.createProcessingRecord",
      async () => {
        const { createProcessingRecord } =
          await import("@/server/services/compliance/processing-records");
        return createProcessingRecord({
          activityKey: "A",
          name: "N",
          purpose: "p",
          dataCategories: "c",
          dataSubjectCategories: "d",
          lawfulBasis: "CONTRACT",
          retentionPeriod: "12 months",
        });
      },
    ],
    [
      "dsr.createDataSubjectRequest",
      async () => {
        const { createDataSubjectRequest } = await import("@/server/services/compliance/dsr");
        return createDataSubjectRequest({
          requestKey: "DSR-1",
          requestType: "ACCESS",
          subjectContactReference: "ref",
          receivedAt: new Date(),
        });
      },
    ],
    [
      "retention.createRetentionPolicy",
      async () => {
        const { createRetentionPolicy } = await import("@/server/services/compliance/retention");
        return createRetentionPolicy({ dataCategory: "contacts", retentionPeriod: "36 months" });
      },
    ],
    [
      "assessments.createAssessment",
      async () => {
        const { createAssessment } = await import("@/server/services/compliance/assessments");
        return createAssessment({
          assessmentKey: "AS-1",
          assessmentType: "NEW_AI_FEATURE",
          featureOrSystem: "x",
          reason: "r",
        });
      },
    ],
    [
      "accessReviews.recordAccessReview",
      async () => {
        const { recordAccessReview } = await import("@/server/services/compliance/access-reviews");
        return recordAccessReview({
          reviewKey: "AR-1",
          scope: "PRIVILEGED_USERS",
          performedAt: new Date(),
          findingsSummary: "ok",
        });
      },
    ],
    [
      "certifications.createCertification",
      async () => {
        const { createCertification } = await import("@/server/services/compliance/certifications");
        return createCertification({
          framework: "GDPR",
          certificationType: "self-assessment",
          scope: "s",
          verificationState: "TECHNICALLY_IMPLEMENTED",
        });
      },
    ],
  ])("%s throws when the caller is not a superadmin", async (_name, run) => {
    mocks.requireSuperadmin.mockRejectedValueOnce(deniedError());
    await expect(run()).rejects.toThrow("Superadmin required");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("compliance domain: superadmin actions are audit-logged", () => {
  it("createControl writes a ComplianceAuditLog entry with no organizationId field", async () => {
    const { createControl } = await import("@/server/services/compliance/controls");
    await createControl({ controlKey: "K2", title: "T", description: "D", category: "GOVERNANCE" });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const auditArgs = mocks.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArgs.data).not.toHaveProperty("organizationId");
    expect(auditArgs.data.action).toBe("compliance_control.create");
  });
});

describe("compliance domain: RLS is declared for every new table, with zero policies", () => {
  const migrationSql = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260815010000_compliance_foundation_phase1/migration.sql",
    ),
    "utf8",
  );

  const newTables = [
    "compliance_controls",
    "control_framework_mappings",
    "compliance_evidence",
    "compliance_risks",
    "security_policies",
    "policy_acknowledgements",
    "security_incidents",
    "incident_events",
    "subprocessors",
    "processing_records",
    "data_subject_requests",
    "dsr_events",
    "retention_policies",
    "retention_executions",
    "privacy_security_assessments",
    "access_reviews",
    "certifications",
    "compliance_audit_log",
  ];

  it.each(newTables)("%s enables row level security", (table) => {
    expect(migrationSql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
  });

  it("declares no CREATE POLICY for any new table (deny-all, service-role-only access)", () => {
    expect(migrationSql).not.toMatch(/CREATE POLICY/i);
  });
});
