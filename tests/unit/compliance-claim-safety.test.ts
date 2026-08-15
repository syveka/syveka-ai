import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Step 18 claim safety: an uncertified framework must never be storable as
 * CERTIFIED/EXTERNALLY_VERIFIED without the metadata that would make the
 * claim checkable. See docs/compliance/SECURITY_CLAIMS.md.
 */

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(async () => ({ userId: "superadmin-1", email: "admin@syveka.ai" })),
  create: vi.fn(async (_args: unknown) => ({ id: "cert-1" })),
  update: vi.fn(async (_args: unknown) => ({ id: "cert-1" })),
  findUnique: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
  auditCreate: vi.fn(async (_args: unknown) => ({ id: "audit-1" })),
}));

vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: mocks.requireSuperadmin }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    certification: { create: mocks.create, update: mocks.update, findUnique: mocks.findUnique },
    complianceAuditLog: { create: mocks.auditCreate },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSuperadmin.mockResolvedValue({ userId: "superadmin-1", email: "admin@syveka.ai" });
  mocks.create.mockResolvedValue({ id: "cert-1" });
  mocks.update.mockResolvedValue({ id: "cert-1" });
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
});

describe("certification claim safety", () => {
  it("allows TECHNICALLY_IMPLEMENTED / INTERNALLY_REVIEWED / EXTERNAL_AUDIT_REQUIRED without issuer or reference", async () => {
    const { createCertification } = await import("@/server/services/compliance/certifications");
    for (const verificationState of [
      "TECHNICALLY_IMPLEMENTED",
      "INTERNALLY_REVIEWED",
      "EXTERNAL_AUDIT_REQUIRED",
    ] as const) {
      await expect(
        createCertification({
          framework: "ISO27001",
          certificationType: "ISO/IEC 27001",
          scope: "platform",
          verificationState,
        }),
      ).resolves.toBeDefined();
    }
  });

  it.each(["EXTERNALLY_VERIFIED", "CERTIFIED"] as const)(
    "rejects %s with neither issuer nor verificationReference",
    async (verificationState) => {
      const { createCertification } = await import("@/server/services/compliance/certifications");
      await expect(
        createCertification({
          framework: "ISO27001",
          certificationType: "ISO/IEC 27001",
          scope: "platform",
          verificationState,
        }),
      ).rejects.toThrow(/Cannot mark a certification/);
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("rejects CERTIFIED with an issuer but no verificationReference", async () => {
    const { createCertification } = await import("@/server/services/compliance/certifications");
    await expect(
      createCertification({
        framework: "SOC2",
        certificationType: "SOC 2 Type II",
        scope: "platform",
        issuer: "Some Auditor LLC",
        verificationState: "CERTIFIED",
      }),
    ).rejects.toThrow(/Cannot mark a certification/);
  });

  it("accepts CERTIFIED with both issuer and verificationReference populated", async () => {
    const { createCertification } = await import("@/server/services/compliance/certifications");
    await expect(
      createCertification({
        framework: "SOC2",
        certificationType: "SOC 2 Type II",
        scope: "platform",
        issuer: "Some Auditor LLC",
        verificationReference: "https://example.com/report/123",
        verificationState: "CERTIFIED",
      }),
    ).resolves.toBeDefined();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("blocks downgrading-into-CERTIFIED via update just as strictly as create", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "cert-1",
      framework: "GDPR",
      certificationType: "self-assessment",
      scope: "platform",
      issuer: null,
      verificationReference: null,
      verificationState: "INTERNALLY_REVIEWED",
    });
    const { updateCertification } = await import("@/server/services/compliance/certifications");
    await expect(updateCertification("cert-1", { verificationState: "CERTIFIED" })).rejects.toThrow(
      /Cannot mark a certification/,
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
