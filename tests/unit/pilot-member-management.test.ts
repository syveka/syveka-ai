import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * The real changeMemberRole and removeMember, over the real tenantDb extension
 * and a stateful fake Prisma. Another organization's row is unreachable because
 * tenantDb adds organizationId to the where clause and the fake honours it.
 */
type Row = Record<string, unknown>;

const s = vi.hoisted(() => {
  const state = { members: [] as Array<Record<string, unknown>>, writes: [] as string[] };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  type Args = { where: Record<string, unknown>; data?: Record<string, unknown> };
  const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
    organizationMember: {
      // A copy, as a database returns: a later update mustn't change a row already read.
      findFirst: async ({ where }) => {
        const found = state.members.find((row) => matches(row, where));
        return found ? { ...found } : null;
      },
      findFirstOrThrow: async ({ where }) => {
        const row = state.members.find((candidate) => matches(candidate, where));
        if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return row;
      },
      update: async ({ where, data }) => {
        state.writes.push("organizationMember.update");
        const row = state.members.find((candidate) => matches(candidate, where));
        if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return Object.assign(row, data);
      },
      delete: async ({ where }) => {
        state.writes.push("organizationMember.delete");
        const index = state.members.findIndex((candidate) => matches(candidate, where));
        if (index < 0) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return state.members.splice(index, 1)[0];
      },
    },
    bookingType: {
      updateMany: async () => {
        state.writes.push("bookingType.updateMany");
        return { count: 0 };
      },
    },
    calendarConnection: { findMany: async () => [] },
  };
  const extended = (allOperations: (input: unknown) => Promise<unknown>) =>
    new Proxy(
      {},
      {
        get: (_target, modelKey) =>
          new Proxy(
            {},
            {
              get: (_inner, operation) => (args: Args) =>
                allOperations({
                  model: String(modelKey).charAt(0).toUpperCase() + String(modelKey).slice(1),
                  operation: String(operation),
                  args,
                  query: (finalArgs: Args) =>
                    models[String(modelKey)]![String(operation)]!(finalArgs),
                }),
            },
          ),
      },
    );
  return {
    state,
    audit: vi.fn(),
    countActiveSeats: vi.fn(async () => 1),
    prisma: {
      ...models,
      $extends: (config: {
        query: { $allModels: { $allOperations: (input: unknown) => Promise<unknown> } };
      }) => extended(config.query.$allModels.$allOperations),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(models),
    },
  };
});

vi.mock("@/server/db/prisma", () => ({ prisma: s.prisma }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseAdmin: vi.fn() }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: s.audit }));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  getEntitlements: vi.fn(),
}));
vi.mock("@/server/services/billing/seats", () => ({
  countActiveSeats: s.countActiveSeats,
  lockOrgSeats: vi.fn(),
}));

import { changeMemberRole, MemberError, removeMember } from "@/server/services/members";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_USER = "11111111-1111-4111-8111-111111111111";
const OWNER_USER = "22222222-2222-4222-8222-222222222222";
const REGULAR_USER = "33333333-3333-4333-8333-333333333333";

const ctx: TenantContext = {
  userId: ADMIN_USER,
  email: "admin@example.test",
  orgId: ORG_A,
  role: "ADMIN",
  locale: "en",
};
const member = (id: string, organizationId: string, userId: string, role: string): Row => ({
  id,
  organizationId,
  userId,
  role,
});
const row = (id: string) => s.state.members.find((candidate) => candidate.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  s.state.writes.length = 0;
  s.state.members = [
    member("m-self", ORG_A, ADMIN_USER, "ADMIN"),
    member("m-owner", ORG_A, OWNER_USER, "OWNER"),
    member("m-regular", ORG_A, REGULAR_USER, "MEMBER"),
    member("m-foreign", ORG_B, REGULAR_USER, "MEMBER"),
  ];
});

describe("changeMemberRole", () => {
  it("changes an ordinary member of the caller's organization and audits it", async () => {
    await changeMemberRole(ctx, "m-regular", "VIEWER");

    expect(row("m-regular")!.role).toBe("VIEWER");
    expect(s.state.writes).toEqual(["organizationMember.update"]);
    expect(s.audit).toHaveBeenCalledWith(ctx, {
      action: "member.role_change",
      resourceType: "organization_member",
      resourceId: "m-regular",
      before: { role: "MEMBER" },
      after: { role: "VIEWER" },
    });
  });

  it.each([
    ["the owner", "m-owner", "owner_role", "OWNER"],
    ["the caller themselves", "m-self", "own_role", "ADMIN"],
    ["another organization's member", "m-foreign", "not_found", "MEMBER"],
  ])("refuses %s and writes nothing", async (_name, memberId, code, originalRole) => {
    const error = await changeMemberRole(ctx, memberId, "VIEWER").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MemberError);
    expect(error).toMatchObject({ code });
    expect(row(memberId)!.role).toBe(originalRole);
    expect(s.state.writes).toEqual([]);
    expect(s.audit).not.toHaveBeenCalled();
  });

  it("answers an unknown id with not_found", async () => {
    await expect(changeMemberRole(ctx, "m-missing", "VIEWER")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(s.state.writes).toEqual([]);
  });
});

describe("removeMember", () => {
  it("removes an ordinary member of the caller's organization and audits it", async () => {
    await removeMember(ctx, "m-regular");

    expect(row("m-regular")).toBeUndefined();
    expect(row("m-foreign")).toBeDefined();
    expect(s.state.writes).toContain("organizationMember.delete");
    expect(s.audit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "member.remove", resourceId: "m-regular" }),
    );
  });

  it.each([
    ["the owner", "m-owner"],
    ["another organization's member", "m-foreign"],
    ["an unknown id", "m-missing"],
  ])("refuses %s and writes nothing", async (_name, memberId) => {
    const before = structuredClone(s.state.members);

    await expect(removeMember(ctx, memberId)).rejects.toThrow();

    expect(s.state.members).toEqual(before);
    expect(s.state.writes).toEqual([]);
    expect(s.countActiveSeats).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });
});
