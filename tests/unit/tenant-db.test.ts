import { describe, expect, it, vi } from "vitest";

/**
 * Exercises tenantDb()'s Prisma extension interceptor directly (src/server/db/tenant.ts),
 * rather than mocking it away as every other test in this suite does - this is the one
 * place that needs the real $allOperations logic under test. `./prisma`'s `prisma` export
 * is mocked so `tenantDb()`'s call to `prisma.$extends(config)` never touches a real
 * PrismaClient; we capture `config` and invoke `$allOperations` the same way Prisma's
 * runtime would.
 */
const mocks = vi.hoisted(() => ({
  $extends: vi.fn((config: unknown) => config),
}));

vi.mock("@/server/db/prisma", () => ({ prisma: { $extends: mocks.$extends } }));

import { tenantDb } from "@/server/db/tenant";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B_ATTACKER_SUPPLIED = "bbbbbbbb-0000-4000-8000-000000000002";

type AllOperationsFn = (input: {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

function getAllOperations(): AllOperationsFn {
  tenantDb(ORG_A);
  const config = mocks.$extends.mock.calls.at(-1)?.[0] as {
    query: { $allModels: { $allOperations: AllOperationsFn } };
  };
  return config.query.$allModels.$allOperations;
}

describe("tenantDb() write-payload tenant scoping (src/server/db/tenant.ts)", () => {
  it("create: overrides a spoofed organizationId in the data payload (safe baseline)", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    await allOperations({
      model: "Document",
      operation: "create",
      args: { data: { organizationId: ORG_B_ATTACKER_SUPPLIED, title: "x" } },
      query,
    });
    expect(query).toHaveBeenCalledWith({ data: { organizationId: ORG_A, title: "x" } });
  });

  it("update: overrides a spoofed organizationId in the data payload, not just where", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    const args = {
      where: { id: "doc-1" },
      data: { organizationId: ORG_B_ATTACKER_SUPPLIED, title: "renamed" },
    };
    await allOperations({ model: "Document", operation: "update", args, query });

    // Exact equality (not toMatchObject): proves the override doesn't come at the
    // cost of silently dropping other where/data fields the caller supplied.
    expect(query).toHaveBeenCalledWith({
      where: { id: "doc-1", organizationId: ORG_A },
      data: { organizationId: ORG_A, title: "renamed" },
    });
  });

  it("upsert: overrides a spoofed organizationId in both the create and update payloads", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    const args = {
      where: { id: "doc-1" },
      create: { organizationId: ORG_B_ATTACKER_SUPPLIED, title: "new" },
      update: { organizationId: ORG_B_ATTACKER_SUPPLIED, title: "changed" },
    };
    await allOperations({ model: "Document", operation: "upsert", args, query });

    expect(query).toHaveBeenCalledWith({
      where: { id: "doc-1", organizationId: ORG_A },
      create: { organizationId: ORG_A, title: "new" },
      update: { organizationId: ORG_A, title: "changed" },
    });
  });

  it("upsert: still injects organizationId when create/update omit it entirely", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    const args = {
      where: { id: "doc-1" },
      create: { title: "new" },
      update: { title: "changed" },
    };
    await allOperations({ model: "Document", operation: "upsert", args, query });

    expect(query).toHaveBeenCalledWith({
      where: { id: "doc-1", organizationId: ORG_A },
      create: { organizationId: ORG_A, title: "new" },
      update: { organizationId: ORG_A, title: "changed" },
    });
  });

  it("updateMany: overrides a spoofed organizationId in the data payload, not just where", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    const args = {
      where: { collectionId: "col-1" },
      data: { organizationId: ORG_B_ATTACKER_SUPPLIED, title: "bulk-renamed" },
    };
    await allOperations({ model: "Document", operation: "updateMany", args, query });

    expect(query).toHaveBeenCalledWith({
      where: { collectionId: "col-1", organizationId: ORG_A },
      data: { organizationId: ORG_A, title: "bulk-renamed" },
    });
  });

  it("delete: injects organizationId into where (no data payload exists for delete)", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    await allOperations({
      model: "Document",
      operation: "delete",
      args: { where: { id: "doc-1" } },
      query,
    });
    expect(query).toHaveBeenCalledWith({ where: { id: "doc-1", organizationId: ORG_A } });
  });

  it("non-tenant model: passes args through untouched", async () => {
    const allOperations = getAllOperations();
    const query = vi.fn(async (args: unknown) => args);
    const args = { data: { organizationId: ORG_B_ATTACKER_SUPPLIED } };
    await allOperations({ model: "User", operation: "create", args, query });
    expect(query).toHaveBeenCalledWith(args);
  });
});
