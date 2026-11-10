import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";

/**
 * The real createOrganization and switchOrganization over a fake Prisma and a
 * fake Supabase admin client. The root client has no create methods for the
 * transactional rows, so a write outside the transaction fails the test.
 */
const m = vi.hoisted(() => ({
  steps: [] as string[],
  takenSlugs: new Set<string>(),
  findOrganization: vi.fn(),
  findMembership: vi.fn(),
  updateUser: vi.fn(),
  transaction: vi.fn(),
  txOrganizationCreate: vi.fn(),
  txMemberCreate: vi.fn(),
  txSubscriptionCreate: vi.fn(),
  txPipelineCreate: vi.fn(),
  updateUserById: vi.fn(),
  createSupabaseAdmin: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: { findUnique: m.findOrganization },
    organizationMember: { findUnique: m.findMembership },
    user: { update: m.updateUser },
    $transaction: m.transaction,
  },
}));
vi.mock("@/server/supabase/server", () => ({ createSupabaseAdmin: m.createSupabaseAdmin }));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));

import { createOrganization, switchOrganization } from "@/server/services/organizations";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const baseParams = { userId: USER_ID, name: "Acme Oy", defaultLocale: "FI" as const };

beforeEach(() => {
  vi.clearAllMocks();
  m.steps.length = 0;
  m.takenSlugs.clear();
  m.findOrganization.mockImplementation(async ({ where }: { where: { slug: string } }) =>
    m.takenSlugs.has(where.slug) ? { id: "taken" } : null,
  );
  m.findMembership.mockResolvedValue(null);
  m.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    m.steps.push("tx:begin");
    const result = await fn({
      organization: { create: m.txOrganizationCreate },
      organizationMember: { create: m.txMemberCreate },
      subscription: { create: m.txSubscriptionCreate },
      pipeline: { create: m.txPipelineCreate },
    });
    m.steps.push("tx:commit");
    return result;
  });
  m.txOrganizationCreate.mockImplementation(async ({ data }: { data: object }) => {
    m.steps.push("organization");
    return { id: ORG_ID, ...data };
  });
  m.txMemberCreate.mockImplementation(async () => m.steps.push("member"));
  m.txSubscriptionCreate.mockImplementation(async () => m.steps.push("subscription"));
  m.txPipelineCreate.mockImplementation(async () => m.steps.push("pipeline"));
  m.updateUserById.mockImplementation(async () => {
    m.steps.push("last_active_org");
    return { data: {}, error: null };
  });
  m.createSupabaseAdmin.mockReturnValue({ auth: { admin: { updateUserById: m.updateUserById } } });
  m.updateUser.mockImplementation(async () => m.steps.push("onboardedAt"));
  m.audit.mockImplementation(async () => m.steps.push("audit"));
});

describe("createOrganization", () => {
  it("creates the OWNER member, FREE subscription and default pipeline in one transaction", async () => {
    const org = await createOrganization(baseParams);

    expect(org.id).toBe(ORG_ID);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.steps.slice(0, 6)).toEqual([
      "tx:begin",
      "organization",
      "member",
      "subscription",
      "pipeline",
      "tx:commit",
    ]);
    expect(m.txOrganizationCreate).toHaveBeenCalledWith({
      data: {
        name: "Acme Oy",
        slug: "acme-oy",
        businessId: null,
        defaultLocale: "FI",
        settings: {},
      },
    });
    expect(m.txMemberCreate).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, userId: USER_ID, role: "OWNER" },
    });
    expect(m.txSubscriptionCreate).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, plan: "FREE", status: "ACTIVE", seats: 1 },
    });
    expect(m.txPipelineCreate).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_ID,
        name: "Myyntiputki",
        isDefault: true,
        stages: { create: DEFAULT_PIPELINE_STAGES.map((stage) => ({ ...stage })) },
      },
    });
  });

  it("stores a supplied business id and industry on the organization", async () => {
    await createOrganization({ ...baseParams, businessId: "1234567-8", industry: "Retail" });

    expect(m.txOrganizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: "1234567-8",
        settings: { industry: "Retail" },
      }),
    });
  });

  it("gives a colliding slug the first free numeric suffix", async () => {
    m.takenSlugs.add("acme-oy");
    m.takenSlugs.add("acme-oy-2");

    await createOrganization(baseParams);

    expect(m.txOrganizationCreate.mock.calls[0]![0].data.slug).toBe("acme-oy-3");
    expect(m.findOrganization.mock.calls.map((call) => call[0].where.slug)).toEqual([
      "acme-oy",
      "acme-oy-2",
      "acme-oy-3",
    ]);
  });

  it("falls back to the slug org for a name with no slug characters", async () => {
    await createOrganization({ ...baseParams, name: "!!!" });

    expect(m.txOrganizationCreate.mock.calls[0]![0].data.slug).toBe("org");
  });

  it("after the commit, sets last_active_org and onboardedAt, then audits", async () => {
    await createOrganization(baseParams);

    expect(m.steps.slice(6)).toEqual(["last_active_org", "onboardedAt", "audit"]);
    expect(m.updateUserById).toHaveBeenCalledWith(USER_ID, {
      app_metadata: { last_active_org: ORG_ID },
    });
    expect(m.updateUser).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { onboardedAt: expect.any(Date) },
    });
    expect(m.audit).toHaveBeenCalledWith(
      { orgId: ORG_ID, userId: USER_ID },
      { action: "org.create", resourceType: "organization", resourceId: ORG_ID },
    );
  });

  it("activates nothing when a write inside the transaction fails", async () => {
    m.txPipelineCreate.mockRejectedValueOnce(new Error("insert failed"));

    await expect(createOrganization(baseParams)).rejects.toThrow("insert failed");

    expect(m.updateUserById).not.toHaveBeenCalled();
    expect(m.updateUser).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("switchOrganization", () => {
  it("looks up the caller's own membership of that organization", async () => {
    await expect(switchOrganization(USER_ID, ORG_ID)).rejects.toThrow();

    expect(m.findMembership).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: ORG_ID, userId: USER_ID } },
    });
  });

  it("refuses a non-member and never touches the session claim", async () => {
    await expect(switchOrganization(USER_ID, ORG_ID)).rejects.toThrow(
      "Not a member of this organization",
    );

    expect(m.createSupabaseAdmin).not.toHaveBeenCalled();
    expect(m.updateUserById).not.toHaveBeenCalled();
  });

  it("sets last_active_org for a member", async () => {
    m.findMembership.mockResolvedValue({ id: "membership-1", role: "MEMBER" });

    await switchOrganization(USER_ID, ORG_ID);

    expect(m.updateUserById).toHaveBeenCalledTimes(1);
    expect(m.updateUserById).toHaveBeenCalledWith(USER_ID, {
      app_metadata: { last_active_org: ORG_ID },
    });
  });
});
