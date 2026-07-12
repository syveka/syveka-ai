import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, auditMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: {},
}));

vi.mock("@/server/services/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => ({}) as never),
  EntitlementError: class EntitlementError extends Error {},
}));

import {
  addCompanyNote,
  archiveCompany,
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  listCompanyOptions,
  restoreCompany,
  updateCompany,
} from "@/server/services/companies";

/** Loose shape for asserting on Prisma-style query arguments captured by mocks. */
type QueryArgs = {
  where: Record<string, unknown> & { OR?: unknown[] };
  data: Record<string, unknown>;
  include: {
    _count: { select: Record<string, unknown> };
    contacts: { where: unknown };
    activities: { take: number };
  } & Record<string, unknown>;
  select: Record<string, unknown>;
  take: number;
  skip: number;
  cursor: { id: string };
  orderBy: unknown;
};

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function companyRow(id: string, orgId: string) {
  return {
    id,
    organizationId: orgId,
    name: `${orgId} Company`,
    domain: "example.com",
    industry: "Software",
    archivedAt: null,
    deletedAt: null,
    _count: { contacts: 2, deals: 1 },
  };
}

function createMockDb(orgId: string) {
  return {
    company: {
      findMany: vi.fn(async (_args: QueryArgs) => [companyRow(`${orgId}-co1`, orgId)]),
      findFirst: vi.fn(async (_args: QueryArgs) => companyRow(`${orgId}-co1`, orgId)),
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => companyRow(`${orgId}-co1`, orgId)),
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-new`, ...data })),
      update: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-co1`, ...data })),
    },
    contact: {
      updateMany: vi.fn(async (_args: QueryArgs) => ({ count: 2 })),
    },
    activity: {
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-a1`, ...data })),
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

describe("companies service", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb("org-a");
    tenantDbMock.mockReturnValue(db);
  });

  describe("listCompanies", () => {
    it("scopes to the tenant and excludes deleted + archived rows by default", async () => {
      await listCompanies(ctx("org-a"), { archived: "active", limit: 25 });

      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      const args = db.company.findMany.mock.calls[0]![0]!;
      expect(args.where).toMatchObject({ deletedAt: null, archivedAt: null });
      expect(args.take).toBe(26);
    });

    it("searches name, domain and industry case-insensitively", async () => {
      await listCompanies(ctx(), { archived: "active", q: "acme", limit: 25 });

      const args = db.company.findMany.mock.calls[0]![0]!;
      expect(args.where.OR).toEqual([
        { name: { contains: "acme", mode: "insensitive" } },
        { domain: { contains: "acme", mode: "insensitive" } },
        { industry: { contains: "acme", mode: "insensitive" } },
      ]);
    });

    it("counts only non-deleted related contacts and deals", async () => {
      await listCompanies(ctx(), { archived: "active", limit: 25 });

      const args = db.company.findMany.mock.calls[0]![0]!;
      expect(args.include._count.select.contacts).toEqual({ where: { deletedAt: null } });
      expect(args.include._count.select.deals).toEqual({ where: { deletedAt: null } });
    });

    it("returns nextCursor only when more rows exist", async () => {
      const rows = [
        companyRow("co0", "org-a"),
        companyRow("co1", "org-a"),
        companyRow("co2", "org-a"),
      ];
      db.company.findMany.mockResolvedValueOnce(rows);

      const more = await listCompanies(ctx(), { archived: "active", limit: 2 });
      expect(more.data).toHaveLength(2);
      expect(more.nextCursor).toBe("co1");

      const done = await listCompanies(ctx(), { archived: "active", limit: 25 });
      expect(done.nextCursor).toBeUndefined();
    });
  });

  it("listCompanyOptions returns only active companies as id/name pairs", async () => {
    await listCompanyOptions(ctx());
    const args = db.company.findMany.mock.calls[0]![0]!;
    expect(args.where).toEqual({ deletedAt: null, archivedAt: null });
    expect(args.select).toEqual({ id: true, name: true });
  });

  it("getCompany excludes deleted companies and loads related records", async () => {
    await getCompany(ctx(), "co-1");
    const args = db.company.findFirst.mock.calls[0]![0]!;
    expect(args.where).toMatchObject({ id: "co-1", deletedAt: null });
    expect(args.include.contacts.where).toEqual({ deletedAt: null });
    expect(args.include.activities.take).toBe(50);
  });

  describe("mutations", () => {
    it("creates a company and audits it", async () => {
      await createCompany(ctx("org-a"), { name: "Acme Oy", domain: "acme.fi" });

      const data = db.company.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        name: "Acme Oy",
        domain: "acme.fi",
        industry: null,
        website: null,
      });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "company.create", resourceType: "company" }),
      );
    });

    it("updates a company after confirming it exists in the tenant", async () => {
      await updateCompany(ctx(), "co-1", { name: "Renamed" });

      expect(db.company.findFirstOrThrow).toHaveBeenCalled();
      const data = db.company.update.mock.calls[0]![0]!.data;
      expect(data.name).toBe("Renamed");
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "company.update" }),
      );
    });

    it("archives and restores", async () => {
      await archiveCompany(ctx(), "co-1");
      expect(db.company.update.mock.calls[0]![0]!.data.archivedAt).toBeInstanceOf(Date);

      await restoreCompany(ctx(), "co-1");
      expect(db.company.update.mock.calls[1]![0]!.data.archivedAt).toBeNull();
    });

    it("soft-deletes and detaches remaining contacts", async () => {
      await deleteCompany(ctx(), "co-1");

      expect(db.contact.updateMany).toHaveBeenCalledWith({
        where: { companyId: "co-1" },
        data: { companyId: null },
      });
      expect(db.company.update.mock.calls[0]![0]!.data.deletedAt).toBeInstanceOf(Date);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "company.delete" }),
      );
    });
  });

  it("adds a NOTE activity to the company timeline", async () => {
    await addCompanyNote(ctx("org-a"), "co-1", { body: "Renewal discussion\nAgreed to extend." });

    const data = db.activity.create.mock.calls[0]![0]!.data;
    expect(data).toMatchObject({
      organizationId: "org-a",
      userId: "user-1",
      type: "NOTE",
      subject: "Renewal discussion",
      body: "Renewal discussion\nAgreed to extend.",
    });
    expect(data.contactId).toBeUndefined();
  });

  it("uses the caller's org for every operation (tenant isolation)", async () => {
    const dbB = createMockDb("org-b");
    tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

    const result = await listCompanies(ctx("org-b"), { archived: "active", limit: 25 });

    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(result.data[0]?.id).toBe("org-b-co1");
    expect(db.company.findMany).not.toHaveBeenCalled();
  });
});
