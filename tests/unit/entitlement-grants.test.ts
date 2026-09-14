import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscriptionFindUnique: vi.fn(),
  grantFindMany: vi.fn(),
  grantCreate: vi.fn(),
  grantUpdate: vi.fn(),
  grantFindUniqueOrThrow: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  requireSuperadminMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    subscription: { findUnique: mocks.subscriptionFindUnique },
    entitlementGrant: {
      findMany: mocks.grantFindMany,
      create: mocks.grantCreate,
      update: mocks.grantUpdate,
      findUniqueOrThrow: mocks.grantFindUniqueOrThrow,
    },
  },
  tenantDb: vi.fn(),
}));
vi.mock("@/server/integrations/redis", () => ({
  redis: { get: mocks.redisGet, set: mocks.redisSet, del: mocks.redisDel },
}));
vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: mocks.requireSuperadminMock }));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));

import { getEntitlements, listActiveGrants } from "@/server/services/billing/entitlements";
import {
  grantEntitlementOverride,
  revokeEntitlementOverride,
  InvalidGrantError,
} from "@/server/services/billing/entitlement-grants";
import { AuthError } from "@/server/auth/session";
import { PLAN_LIMITS } from "@/server/services/billing/plans";

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    organizationId: "org-a",
    metric: "VOICE_ASSISTANTS",
    amount: 1,
    reason: "Pilot smoke test",
    grantedByUserId: "admin-1",
    createdAt: new Date("2026-09-14T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    ...overrides,
  };
}

describe("getEntitlements + internal entitlement grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null); // cache miss on every call unless a test says otherwise
  });

  it("1. FREE org without any grant has voiceAssistants=0 and voiceMinutesMonth=0", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null); // no subscription row → FREE default
    mocks.grantFindMany.mockResolvedValue([]);

    const ent = await getEntitlements("org-a");

    expect(ent.plan).toBe("FREE");
    expect(ent.voiceAssistants).toBe(0);
    expect(ent.voiceMinutesMonth).toBe(0);
  });

  it("2. FREE org with active grants: plan stays FREE, effective voiceAssistants/voiceMinutesMonth increase", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      plan: "FREE",
      status: "ACTIVE",
      seats: 1,
      updatedAt: new Date(),
    });
    mocks.grantFindMany.mockResolvedValue([
      grantRow({ id: "g1", metric: "VOICE_ASSISTANTS", amount: 1 }),
      grantRow({ id: "g2", metric: "VOICE_MINUTES_MONTH", amount: 10 }),
    ]);

    const ent = await getEntitlements("org-a");

    expect(ent.plan).toBe("FREE");
    expect(ent.voiceAssistants).toBe(1);
    expect(ent.voiceMinutesMonth).toBe(10);
  });

  it("3. an expired grant does not apply", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    // listActiveGrants itself filters expired rows at the query level -- simulate
    // the DB correctly excluding it by having the mock return an empty result,
    // proving getEntitlements does not add anything when there's nothing active.
    mocks.grantFindMany.mockResolvedValue([]);

    const ent = await getEntitlements("org-a");

    expect(ent.voiceAssistants).toBe(0);
  });

  it("listActiveGrants queries only non-revoked, non-expired-or-null-expiry rows", async () => {
    mocks.grantFindMany.mockResolvedValue([]);
    await listActiveGrants("org-a");

    expect(mocks.grantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-a",
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it("4. a revoked grant does not apply (excluded by the active-grants query)", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    // A revoked grant would never be returned by the real revokedAt:null filter --
    // simulate that by returning empty, same as the expired case.
    mocks.grantFindMany.mockResolvedValue([]);

    const ent = await getEntitlements("org-a");

    expect(ent.voiceAssistants).toBe(0);
  });

  it("5. multiple valid grants for the same metric add correctly", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.grantFindMany.mockResolvedValue([
      grantRow({ id: "g1", metric: "VOICE_MINUTES_MONTH", amount: 10 }),
      grantRow({ id: "g2", metric: "VOICE_MINUTES_MONTH", amount: 5 }),
    ]);

    const ent = await getEntitlements("org-a");

    expect(ent.voiceMinutesMonth).toBe(15);
  });

  it("6a. grantEntitlementOverride rejects a zero or negative amount", async () => {
    mocks.requireSuperadminMock.mockResolvedValue({ userId: "admin-1", email: "a@syveka.com" });

    await expect(
      grantEntitlementOverride({
        organizationId: "org-a",
        metric: "VOICE_ASSISTANTS",
        amount: 0,
        reason: "test",
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      grantEntitlementOverride({
        organizationId: "org-a",
        metric: "VOICE_ASSISTANTS",
        amount: -1,
        reason: "test",
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("6b. getEntitlements never returns a value below the plan's own limit (grants are additive only)", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.grantFindMany.mockResolvedValue([
      grantRow({ id: "g1", metric: "VOICE_ASSISTANTS", amount: 1 }),
    ]);

    const ent = await getEntitlements("org-a");

    expect(ent.voiceAssistants).toBeGreaterThanOrEqual(PLAN_LIMITS.FREE.voiceAssistants);
  });

  it("7a. a non-superadmin cannot grant an entitlement override", async () => {
    mocks.requireSuperadminMock.mockRejectedValue(new AuthError("Superadmin required", 403));

    await expect(
      grantEntitlementOverride({
        organizationId: "org-a",
        metric: "VOICE_ASSISTANTS",
        amount: 1,
        reason: "test",
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("7b. a non-superadmin cannot revoke an entitlement override", async () => {
    mocks.requireSuperadminMock.mockRejectedValue(new AuthError("Superadmin required", 403));

    await expect(revokeEntitlementOverride("grant-1")).rejects.toBeInstanceOf(AuthError);
    expect(mocks.grantUpdate).not.toHaveBeenCalled();
  });

  it("8a. granting an override invalidates the org's cached entitlements", async () => {
    mocks.requireSuperadminMock.mockResolvedValue({ userId: "admin-1", email: "a@syveka.com" });
    mocks.grantCreate.mockResolvedValue(grantRow());

    await grantEntitlementOverride({
      organizationId: "org-a",
      metric: "VOICE_ASSISTANTS",
      amount: 1,
      reason: "Pilot smoke test",
    });

    expect(mocks.redisDel).toHaveBeenCalledWith("ent:org-a");
  });

  it("8b. revoking an override invalidates the org's cached entitlements", async () => {
    mocks.requireSuperadminMock.mockResolvedValue({ userId: "admin-1", email: "a@syveka.com" });
    mocks.grantFindUniqueOrThrow.mockResolvedValue(grantRow());
    mocks.grantUpdate.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    await revokeEntitlementOverride("grant-1");

    expect(mocks.redisDel).toHaveBeenCalledWith("ent:org-a");
  });

  it("9. granting or revoking an override never touches the Subscription table", async () => {
    mocks.requireSuperadminMock.mockResolvedValue({ userId: "admin-1", email: "a@syveka.com" });
    mocks.grantCreate.mockResolvedValue(grantRow());
    mocks.grantFindUniqueOrThrow.mockResolvedValue(grantRow());
    mocks.grantUpdate.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    await grantEntitlementOverride({
      organizationId: "org-a",
      metric: "VOICE_ASSISTANTS",
      amount: 1,
      reason: "Pilot smoke test",
    });
    await revokeEntitlementOverride("grant-1");

    expect(mocks.subscriptionFindUnique).not.toHaveBeenCalled();
  });

  it("10a. STARTER/PRO/ENTERPRISE behavior is correct with no grants", async () => {
    for (const plan of ["STARTER", "PRO", "ENTERPRISE"] as const) {
      mocks.redisGet.mockResolvedValue(null);
      mocks.subscriptionFindUnique.mockResolvedValue({
        plan,
        status: "ACTIVE",
        seats: 1,
        updatedAt: new Date(),
      });
      mocks.grantFindMany.mockResolvedValue([]);

      const ent = await getEntitlements("org-a");
      expect(ent.plan).toBe(plan);
      expect(ent.voiceAssistants).toBe(PLAN_LIMITS[plan].voiceAssistants);
    }
  });

  it("10b. ENTERPRISE's unlimited (Number.MAX_SAFE_INTEGER) fields stay unlimited even with an active grant", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      plan: "ENTERPRISE",
      status: "ACTIVE",
      seats: 1,
      updatedAt: new Date(),
    });
    mocks.grantFindMany.mockResolvedValue([
      grantRow({ id: "g1", metric: "VOICE_ASSISTANTS", amount: 5 }),
    ]);

    const ent = await getEntitlements("org-a");

    expect(ent.voiceAssistants).toBe(Number.MAX_SAFE_INTEGER);
  });
});
