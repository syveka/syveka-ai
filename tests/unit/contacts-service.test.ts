import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, auditMock, assertWithinLimitMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  assertWithinLimitMock: vi.fn(async () => ({}) as never),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: {},
}));

vi.mock("@/server/services/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: assertWithinLimitMock,
  EntitlementError: class EntitlementError extends Error {},
}));

import {
  addContactNote,
  archiveContact,
  archivedWhere,
  createContact,
  deleteContact,
  listContacts,
  noteSubject,
  restoreContact,
  updateContact,
} from "@/server/services/contacts";

/** Loose shape for asserting on Prisma-style query arguments captured by mocks. */
type QueryArgs = {
  where: Record<string, unknown> & { OR?: unknown[] };
  data: Record<string, unknown>;
  include: Record<string, unknown>;
  select: Record<string, unknown>;
  take: number;
  skip: number;
  cursor: { id: string };
  orderBy: unknown;
};

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MEMBER", locale: "en" };
}

function contactRow(id: string, orgId: string) {
  return {
    id,
    organizationId: orgId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    status: "LEAD",
    companyId: null as string | null,
    archivedAt: null,
    deletedAt: null,
    company: null,
    tags: [],
  };
}

function createMockDb(orgId: string) {
  return {
    contact: {
      findMany: vi.fn(async (_args: QueryArgs) => [contactRow(`${orgId}-c1`, orgId)]),
      findFirst: vi.fn(async (_args: QueryArgs) => contactRow(`${orgId}-c1`, orgId)),
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => contactRow(`${orgId}-c1`, orgId)),
      count: vi.fn(async (_args: QueryArgs) => 3),
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-new`, ...data })),
      update: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-c1`, ...data })),
    },
    company: {
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => ({ id: "company-1" })),
    },
    activity: {
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-a1`, ...data })),
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

describe("contacts service", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb("org-a");
    tenantDbMock.mockReturnValue(db);
  });

  describe("archivedWhere", () => {
    it("defaults to active records", () => {
      expect(archivedWhere(undefined)).toEqual({ archivedAt: null });
      expect(archivedWhere("active")).toEqual({ archivedAt: null });
    });

    it("supports archived and all", () => {
      expect(archivedWhere("archived")).toEqual({ archivedAt: { not: null } });
      expect(archivedWhere("all")).toEqual({});
    });
  });

  describe("noteSubject", () => {
    it("uses the first line only", () => {
      expect(noteSubject("First line\nSecond line")).toBe("First line");
    });

    it("truncates long lines with an ellipsis", () => {
      const subject = noteSubject("x".repeat(300));
      expect(subject.length).toBe(120);
      expect(subject.endsWith("…")).toBe(true);
    });
  });

  describe("listContacts", () => {
    it("scopes queries to the tenant and excludes deleted + archived rows by default", async () => {
      await listContacts(ctx("org-a"), { archived: "active", limit: 25 });

      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      const args = db.contact.findMany.mock.calls[0]![0]!;
      expect(args.where).toMatchObject({ deletedAt: null, archivedAt: null });
      expect(args.take).toBe(26);
    });

    it("applies status, company and archived filters", async () => {
      await listContacts(ctx(), {
        archived: "archived",
        status: "CUSTOMER",
        companyId: "company-1",
        limit: 10,
      });

      const args = db.contact.findMany.mock.calls[0]![0]!;
      expect(args.where).toMatchObject({
        deletedAt: null,
        archivedAt: { not: null },
        status: "CUSTOMER",
        companyId: "company-1",
      });
    });

    it("builds a case-insensitive search across name, email and phone", async () => {
      await listContacts(ctx(), { archived: "active", q: "ada l", limit: 25 });

      const args = db.contact.findMany.mock.calls[0]![0]!;
      expect(args.where.OR).toEqual([
        { firstName: { contains: "ada l", mode: "insensitive" } },
        { lastName: { contains: "ada l", mode: "insensitive" } },
        { email: { contains: "ada l", mode: "insensitive" } },
        { phone: { contains: "adal" } },
      ]);
    });

    it("paginates with a cursor and reports nextCursor when more rows exist", async () => {
      const rows = [
        contactRow("c0", "org-a"),
        contactRow("c1", "org-a"),
        contactRow("c2", "org-a"),
      ];
      db.contact.findMany.mockResolvedValueOnce(rows);

      const result = await listContacts(ctx(), {
        archived: "active",
        cursor: "11111111-1111-4111-8111-111111111111",
        limit: 2,
      });

      const args = db.contact.findMany.mock.calls[0]![0]!;
      expect(args.cursor).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
      expect(args.skip).toBe(1);
      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBe("c1");
    });
  });

  describe("createContact", () => {
    it("enforces the plan limit and audits the creation", async () => {
      await createContact(ctx("org-a"), {
        firstName: "Ada",
        status: "LEAD",
        gdprConsent: false,
      });

      expect(assertWithinLimitMock).toHaveBeenCalledWith("org-a", { kind: "contacts", current: 3 });
      const data = db.contact.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        firstName: "Ada",
        ownerId: "user-1",
        companyId: null,
      });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "contact.create", resourceType: "contact" }),
      );
    });

    it("verifies the company belongs to the tenant before linking", async () => {
      await createContact(ctx(), {
        firstName: "Ada",
        companyId: "company-1",
        status: "LEAD",
        gdprConsent: false,
      });

      expect(db.company.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "company-1", deletedAt: null }),
        }),
      );
    });

    it("does not touch companies when no company is linked", async () => {
      await createContact(ctx(), { firstName: "Ada", status: "LEAD", gdprConsent: false });
      expect(db.company.findFirstOrThrow).not.toHaveBeenCalled();
    });

    it("rejects a cross-tenant company id", async () => {
      db.company.findFirstOrThrow.mockRejectedValueOnce(new Error("Not found"));

      await expect(
        createContact(ctx(), {
          firstName: "Ada",
          companyId: "22222222-2222-4222-8222-222222222222",
          status: "LEAD",
          gdprConsent: false,
        }),
      ).rejects.toThrow();
      expect(db.contact.create).not.toHaveBeenCalled();
    });
  });

  describe("updateContact", () => {
    it("clears the company link when none is provided", async () => {
      await updateContact(ctx(), "contact-1", {
        firstName: "Ada",
        status: "CUSTOMER",
        gdprConsent: false,
      });

      const data = db.contact.update.mock.calls[0]![0]!.data;
      expect(data.companyId).toBeNull();
      expect(data.status).toBe("CUSTOMER");
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "contact.update" }),
      );
    });
  });

  describe("archive / restore / delete", () => {
    it("archives by setting archivedAt", async () => {
      await archiveContact(ctx(), "contact-1");
      const data = db.contact.update.mock.calls[0]![0]!.data;
      expect(data.archivedAt).toBeInstanceOf(Date);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "contact.archive" }),
      );
    });

    it("restores by clearing archivedAt", async () => {
      await restoreContact(ctx(), "contact-1");
      const data = db.contact.update.mock.calls[0]![0]!.data;
      expect(data.archivedAt).toBeNull();
    });

    it("soft-deletes by setting deletedAt", async () => {
      await deleteContact(ctx(), "contact-1");
      const data = db.contact.update.mock.calls[0]![0]!.data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "contact.delete" }),
      );
    });
  });

  describe("addContactNote", () => {
    it("creates a NOTE activity linked to the contact and its company", async () => {
      const linked = contactRow("contact-1", "org-a");
      linked.companyId = "company-1";
      db.contact.findFirstOrThrow.mockResolvedValueOnce(linked);

      await addContactNote(ctx("org-a"), "contact-1", { body: "Spoke on the phone\nDetails…" });

      const data = db.activity.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        userId: "user-1",
        contactId: "contact-1",
        companyId: "company-1",
        type: "NOTE",
        subject: "Spoke on the phone",
        body: "Spoke on the phone\nDetails…",
      });
    });
  });

  it("uses the caller's org for every operation (tenant isolation)", async () => {
    const dbB = createMockDb("org-b");
    tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

    const result = await listContacts(ctx("org-b"), { archived: "active", limit: 25 });

    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(result.data[0]?.id).toBe("org-b-c1");
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });
});
