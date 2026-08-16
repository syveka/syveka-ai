import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDnaServiceInput } from "@/lib/validators/business-dna";

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

import {
  createBusinessDnaService,
  deactivateBusinessDnaService,
  listBusinessDnaServices,
  reactivateBusinessDnaService,
  updateBusinessDnaService,
} from "@/server/services/business-dna-services";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function minimalInput(overrides: Partial<BusinessDnaServiceInput> = {}): BusinessDnaServiceInput {
  return { name: "Haircut", isActive: true, sortOrder: 0, ...overrides };
}

type ServiceRow = {
  id: string;
  organizationId: string;
  businessDnaId: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  priceNote: string | null;
  durationMinutes: number | null;
  isActive: boolean;
  sortOrder: number;
};

/**
 * A minimal fake standing in for the real `tenantDb`-scoped Prisma client
 * extension: every read is pre-filtered to the org the mock was constructed
 * for, mirroring the real extension's behavior of silently returning zero
 * rows for another tenant's id rather than throwing or leaking existence.
 */
function createScopedDb(orgId: string, store: { services: ServiceRow[]; dnaId: string | null }) {
  return {
    businessDNA: {
      findFirst: vi.fn(async () => (store.dnaId ? { id: store.dnaId } : null)),
    },
    businessDnaService: {
      findMany: vi.fn(async () => store.services.filter((s) => s.organizationId === orgId)),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.services.find((s) => s.id === where.id && s.organizationId === orgId) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<ServiceRow, "id"> }) => {
        const row: ServiceRow = { id: `svc-${store.services.length + 1}`, ...data };
        store.services.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ServiceRow> }) => {
          const row = store.services.find((s) => s.id === where.id && s.organizationId === orgId);
          if (!row) throw new Error("record not found");
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
}

describe("business-dna-services service", () => {
  let storeA: { services: ServiceRow[]; dnaId: string | null };
  let storeB: { services: ServiceRow[]; dnaId: string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    storeA = { services: [], dnaId: "dna-a" };
    storeB = { services: [], dnaId: "dna-b" };
    tenantDbMock.mockImplementation((orgId: string) =>
      orgId === "org-a" ? createScopedDb("org-a", storeA) : createScopedDb("org-b", storeB),
    );
  });

  describe("listBusinessDnaServices", () => {
    it("only returns the caller's own org's services", async () => {
      storeA.services.push({
        id: "svc-a1",
        organizationId: "org-a",
        businessDnaId: "dna-a",
        name: "Org A service",
        description: null,
        priceCents: null,
        priceNote: null,
        durationMinutes: null,
        isActive: true,
        sortOrder: 0,
      });
      storeB.services.push({
        id: "svc-b1",
        organizationId: "org-b",
        businessDnaId: "dna-b",
        name: "Org B service",
        description: null,
        priceCents: null,
        priceNote: null,
        durationMinutes: null,
        isActive: true,
        sortOrder: 0,
      });

      const result = await listBusinessDnaServices(ctx("org-a"));

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("Org A service");
    });
  });

  describe("createBusinessDnaService", () => {
    it("throws when no Business DNA profile exists yet for the org", async () => {
      storeA.dnaId = null;
      await expect(createBusinessDnaService(ctx("org-a"), minimalInput())).rejects.toThrow(
        "Business DNA profile must be created before adding services",
      );
    });

    it("derives organizationId and businessDnaId from context, never from input", async () => {
      const service = await createBusinessDnaService(ctx("org-a"), minimalInput({ name: "Cut" }));

      expect(service.organizationId).toBe("org-a");
      expect(service.businessDnaId).toBe("dna-a");
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({
          action: "business_dna_service.create",
          resourceType: "business_dna_service",
        }),
      );
    });

    it("scopes creation to the calling org even when another org is active elsewhere", async () => {
      await createBusinessDnaService(ctx("org-b"), minimalInput({ name: "Org B cut" }));

      expect(storeA.services).toHaveLength(0);
      expect(storeB.services).toHaveLength(1);
      expect(storeB.services[0]!.organizationId).toBe("org-b");
    });
  });

  describe("updateBusinessDnaService — cross-tenant ID guessing", () => {
    beforeEach(() => {
      storeA.services.push({
        id: "shared-guessable-id",
        organizationId: "org-a",
        businessDnaId: "dna-a",
        name: "Org A's secret pricing",
        description: null,
        priceCents: 100_000,
        priceNote: null,
        durationMinutes: null,
        isActive: true,
        sortOrder: 0,
      });
    });

    it("updates a service that belongs to the caller's own org", async () => {
      const updated = await updateBusinessDnaService(ctx("org-a"), "shared-guessable-id", {
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
    });

    it("rejects updating another org's service even when the exact id is guessed", async () => {
      await expect(
        updateBusinessDnaService(ctx("org-b"), "shared-guessable-id", { name: "Hijacked" }),
      ).rejects.toThrow("Service not found");
      // The row itself must be provably untouched, not just the promise rejected.
      expect(storeA.services[0]!.name).toBe("Org A's secret pricing");
    });

    it("rejects updating a nonexistent id with the same error as a cross-tenant id (no existence leak)", async () => {
      await expect(
        updateBusinessDnaService(ctx("org-a"), "does-not-exist-anywhere", { name: "X" }),
      ).rejects.toThrow("Service not found");
    });

    it("only writes the fields explicitly present in the partial input", async () => {
      await updateBusinessDnaService(ctx("org-a"), "shared-guessable-id", { priceCents: 5000 });
      expect(storeA.services[0]!.priceCents).toBe(5000);
      expect(storeA.services[0]!.name).toBe("Org A's secret pricing");
    });
  });

  describe("deactivateBusinessDnaService / reactivateBusinessDnaService", () => {
    beforeEach(() => {
      storeA.services.push({
        id: "svc-toggle",
        organizationId: "org-a",
        businessDnaId: "dna-a",
        name: "Toggle me",
        description: null,
        priceCents: null,
        priceNote: null,
        durationMinutes: null,
        isActive: true,
        sortOrder: 0,
      });
    });

    it("deactivates without deleting the row (soft state)", async () => {
      const result = await deactivateBusinessDnaService(ctx("org-a"), "svc-toggle");
      expect(result.isActive).toBe(false);
      expect(storeA.services).toHaveLength(1);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "business_dna_service.deactivate" }),
      );
    });

    it("reactivates a previously deactivated service", async () => {
      await deactivateBusinessDnaService(ctx("org-a"), "svc-toggle");
      const result = await reactivateBusinessDnaService(ctx("org-a"), "svc-toggle");
      expect(result.isActive).toBe(true);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "business_dna_service.reactivate" }),
      );
    });

    it("rejects deactivating another org's service by guessed id", async () => {
      await expect(deactivateBusinessDnaService(ctx("org-b"), "svc-toggle")).rejects.toThrow(
        "Service not found",
      );
      expect(storeA.services[0]!.isActive).toBe(true);
    });
  });
});
