import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Step 8/11 guardrails: notification/legal applicability is never inferred
 * automatically, and identity must be verified before a data-subject
 * request can be processed past intake.
 */

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(async () => ({ userId: "superadmin-1", email: "admin@syveka.ai" })),
  dsrCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "dsr-1",
    ...args.data,
  })),
  dsrFindUnique: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
  dsrUpdate: vi.fn(async (_args: unknown) => ({ id: "dsr-1" })),
  incidentCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "inc-1",
    ...args.data,
  })),
  auditCreate: vi.fn(async (_args: unknown) => ({ id: "audit-1" })),
}));

vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: mocks.requireSuperadmin }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    dataSubjectRequest: {
      create: mocks.dsrCreate,
      findUnique: mocks.dsrFindUnique,
      update: mocks.dsrUpdate,
    },
    securityIncident: { create: mocks.incidentCreate },
    complianceAuditLog: { create: mocks.auditCreate },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSuperadmin.mockResolvedValue({ userId: "superadmin-1", email: "admin@syveka.ai" });
  mocks.dsrCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "dsr-1",
    ...args.data,
  }));
  mocks.dsrUpdate.mockResolvedValue({ id: "dsr-1" });
  mocks.incidentCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "inc-1",
    ...args.data,
  }));
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
});

describe("data subject requests", () => {
  it("computes a 30-day default deadline from receivedAt when none is given", async () => {
    const { createDataSubjectRequest } = await import("@/server/services/compliance/dsr");
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");
    const request = await createDataSubjectRequest({
      requestKey: "DSR-1",
      requestType: "ACCESS",
      subjectContactReference: "person@example.com",
      receivedAt,
    });
    expect(request.deadlineAt).toEqual(new Date("2026-01-31T00:00:00.000Z"));
  });

  it("respects an explicit deadlineAt override instead of the 30-day default", async () => {
    const { createDataSubjectRequest } = await import("@/server/services/compliance/dsr");
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");
    const deadlineAt = new Date("2026-01-10T00:00:00.000Z");
    const request = await createDataSubjectRequest({
      requestKey: "DSR-2",
      requestType: "ERASURE",
      subjectContactReference: "person@example.com",
      receivedAt,
      deadlineAt,
    });
    expect(request.deadlineAt).toEqual(deadlineAt);
  });

  it("blocks moving status to IN_PROGRESS before identity is VERIFIED", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce({
      id: "dsr-1",
      identityVerificationStatus: "UNVERIFIED",
    });
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(updateDsrStatus("dsr-1", "IN_PROGRESS")).rejects.toThrow(
      /Identity must be verified/,
    );
    expect(mocks.dsrUpdate).not.toHaveBeenCalled();
  });

  it("allows moving status to WITHDRAWN even when identity is unverified", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce({
      id: "dsr-1",
      identityVerificationStatus: "UNVERIFIED",
    });
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(updateDsrStatus("dsr-1", "WITHDRAWN")).resolves.toBeDefined();
    expect(mocks.dsrUpdate).toHaveBeenCalledTimes(1);
  });

  it("allows moving status to REJECTED even when identity is unverified (regression: rejecting because identity couldn't be verified must stay reachable)", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce({
      id: "dsr-1",
      identityVerificationStatus: "UNVERIFIED",
    });
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(
      updateDsrStatus("dsr-1", "REJECTED", "identity could not be verified"),
    ).resolves.toBeDefined();
    expect(mocks.dsrUpdate).toHaveBeenCalledTimes(1);
  });

  it("still blocks moving status to COMPLETED before identity is VERIFIED", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce({
      id: "dsr-1",
      identityVerificationStatus: "PENDING",
    });
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(updateDsrStatus("dsr-1", "COMPLETED")).rejects.toThrow(
      /Identity must be verified/,
    );
    expect(mocks.dsrUpdate).not.toHaveBeenCalled();
  });

  it("throws a clear error when the request does not exist", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce(null);
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(updateDsrStatus("missing-id", "WITHDRAWN")).rejects.toThrow(/not found/i);
    expect(mocks.dsrUpdate).not.toHaveBeenCalled();
  });

  it("allows moving status forward once identity is VERIFIED", async () => {
    mocks.dsrFindUnique.mockResolvedValueOnce({
      id: "dsr-1",
      identityVerificationStatus: "VERIFIED",
    });
    const { updateDsrStatus } = await import("@/server/services/compliance/dsr");
    await expect(updateDsrStatus("dsr-1", "IN_PROGRESS")).resolves.toBeDefined();
    expect(mocks.dsrUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("security incidents", () => {
  it("never sets notificationRequired to YES/NO on creation -- always starts UNKNOWN", async () => {
    const { createIncident } = await import("@/server/services/compliance/incidents");
    const incident = await createIncident({
      incidentKey: "INC-1",
      title: "T",
      description: "D",
      severity: "HIGH",
      detectedAt: new Date(),
    });
    expect(incident.notificationRequired).toBeUndefined(); // not set by the service -> DB default (UNKNOWN) applies
  });
});
