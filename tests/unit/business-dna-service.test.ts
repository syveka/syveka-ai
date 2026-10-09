import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput } from "@/lib/validators/business-dna";
import { Prisma } from "@/generated/prisma/client/client";

const { tenantDbMock, auditMock, resyncActiveAssistantsMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  resyncActiveAssistantsMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: {},
}));

vi.mock("@/server/services/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/server/services/voice", () => ({
  resyncActiveAssistants: resyncActiveAssistantsMock,
}));

import { getBusinessDNA, upsertBusinessDNA } from "@/server/services/business-dna";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function minimalInput(overrides: Partial<BusinessDNAInput> = {}): BusinessDNAInput {
  return {
    supportedLocales: [],
    keyFacts: [],
    ...overrides,
  };
}

type QueryArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function createMockDb() {
  return {
    businessDNA: {
      findFirst: vi.fn(async () => null as { id: string } | null),
      create: vi.fn(async ({ data }: QueryArgs) => ({
        id: "bd-new",
        ...data,
      })),
      update: vi.fn(async ({ data }: QueryArgs) => ({
        id: "bd-existing",
        ...data,
      })),
      /** Compare-and-set save: 1 when the loaded version was still current. */
      updateMany: vi.fn(async (_args: QueryArgs) => ({ count: 1 })),
    },
  };
}

const LOADED = "2026-10-09T10:00:00.000Z";

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

type MockDb = ReturnType<typeof createMockDb>;

describe("business-dna service", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    tenantDbMock.mockReturnValue(db);
  });

  describe("getBusinessDNA", () => {
    it("scopes the lookup to the caller's tenant", async () => {
      await getBusinessDNA(ctx("org-a"));
      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      expect(db.businessDNA.findFirst).toHaveBeenCalledWith({});
    });
  });

  describe("upsertBusinessDNA", () => {
    it("creates a new profile when none exists and audits the creation", async () => {
      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "Acme" }),
        null,
      );

      expect(db.businessDNA.create).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.updateMany).not.toHaveBeenCalled();
      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        displayName: "Acme",
        industry: null,
        keyFacts: [],
      });
      expect(result).toMatchObject({ ok: true, record: { id: "bd-new" } });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "business_dna.create", resourceType: "business_dna" }),
      );
    });

    it("updates the existing profile instead of creating a second one, only at the loaded version", async () => {
      db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1" });

      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "Acme v2" }),
        LOADED,
      );

      expect(db.businessDNA.updateMany).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.create).not.toHaveBeenCalled();
      expect(db.businessDNA.updateMany.mock.calls[0]![0]!.where).toEqual({
        updatedAt: new Date(LOADED),
      });
      expect(result).toMatchObject({ ok: true, record: { id: "bd-1" } });
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "business_dna.update" }),
      );
    });

    it("reports the version it wrote, even if another change landed right after the save", async () => {
      // Read after the compare-and-set: already a newer version (e.g. a chat change).
      db.businessDNA.findFirst.mockResolvedValueOnce({
        id: "bd-1",
        updatedAt: new Date("2026-10-09T23:59:59.000Z"),
      } as never);

      const result = await upsertBusinessDNA(ctx("org-a"), minimalInput(), LOADED);

      const written = db.businessDNA.updateMany.mock.calls[0]![0]!.data.updatedAt as Date;
      expect(written).toBeInstanceOf(Date);
      expect(result).toMatchObject({ ok: true, record: { updatedAt: written } });
    });

    it("returns exactly what it wrote, not a change that landed after it", async () => {
      db.businessDNA.findFirst.mockResolvedValueOnce({
        id: "bd-1",
        displayName: "Changed in chat right after",
        openingHours: { monday: { closed: true } },
      } as never);

      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "From the form" }),
        LOADED,
      );

      expect(result).toMatchObject({
        ok: true,
        record: { id: "bd-1", displayName: "From the form", openingHours: null },
      });
    });

    it("saves nothing when the profile changed since it was loaded (e.g. in chat)", async () => {
      db.businessDNA.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "Stale form" }),
        LOADED,
      );

      expect(result).toEqual({ ok: false, reason: "conflict" });
      expect(db.businessDNA.create).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
      expect(resyncActiveAssistantsMock).not.toHaveBeenCalled();
    });

    it("saves nothing when a profile was created since a form with no profile was loaded", async () => {
      db.businessDNA.create.mockRejectedValueOnce(uniqueViolation());

      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "Stale form" }),
        null,
      );

      expect(result).toEqual({ ok: false, reason: "conflict" });
      expect(db.businessDNA.updateMany).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("lets other database errors fail the save", async () => {
      db.businessDNA.create.mockRejectedValueOnce(new Error("connection lost"));

      await expect(upsertBusinessDNA(ctx("org-a"), minimalInput(), null)).rejects.toThrow(
        "connection lost",
      );
    });

    it("stamps extractedAt when a sourceUrl is present", async () => {
      await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ sourceUrl: "https://example.com" }),
        null,
      );

      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data.sourceUrl).toBe("https://example.com");
      expect(data.extractedAt).toBeInstanceOf(Date);
    });

    it("clears provenance when no sourceUrl is submitted", async () => {
      await upsertBusinessDNA(ctx("org-a"), minimalInput(), null);

      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data.sourceUrl).toBeNull();
      expect(data.extractedAt).toBeNull();
    });

    it("maps every new structured field through to the write, never dropping one", async () => {
      await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({
          description: "A neighborhood bakery",
          timezone: "Europe/Helsinki",
          responseInstructions: "Always greet warmly",
          cancellationPolicy: "24h notice",
          bookingPolicy: "Book ahead",
          refundPolicy: "No refunds",
          paymentPolicy: "Card only",
          otherPolicies: "See website",
          currency: "EUR",
          quoteInstructions: "Always include VAT",
        }),
        null,
      );

      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        description: "A neighborhood bakery",
        timezone: "Europe/Helsinki",
        responseInstructions: "Always greet warmly",
        cancellationPolicy: "24h notice",
        bookingPolicy: "Book ahead",
        refundPolicy: "No refunds",
        paymentPolicy: "Card only",
        otherPolicies: "See website",
        currency: "EUR",
        quoteInstructions: "Always include VAT",
      });
    });

    it("uses the caller's org for every operation (tenant isolation)", async () => {
      const dbB = createMockDb();
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await upsertBusinessDNA(ctx("org-b"), minimalInput({ displayName: "Org B" }), null);

      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
      expect(dbB.businessDNA.create).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.create).not.toHaveBeenCalled();
    });

    it("re-syncs any already-live voice assistant after a successful save (a saved profile must not silently leave the assistant stale)", async () => {
      await upsertBusinessDNA(ctx("org-a"), minimalInput({ displayName: "Acme" }), null);

      expect(resyncActiveAssistantsMock).toHaveBeenCalledTimes(1);
      expect(resyncActiveAssistantsMock).toHaveBeenCalledWith("org-a");
    });

    it("still returns the saved record after triggering the resync (resync is a fire-and-await follow-up, not a precondition of success)", async () => {
      const result = await upsertBusinessDNA(
        ctx("org-a"),
        minimalInput({ displayName: "Acme" }),
        null,
      );

      expect(result).toMatchObject({ ok: true, record: { id: "bd-new" } });
      // resyncActiveAssistants (voice.ts) is independently proven to never
      // throw, even on internal failure - see
      // tests/unit/voice-business-dna.test.ts's "resyncActiveAssistants"
      // describe block. This test only proves upsertBusinessDNA calls it
      // and returns normally, not that upsertBusinessDNA adds its own
      // redundant error handling around it.
      expect(resyncActiveAssistantsMock).toHaveBeenCalledTimes(1);
    });
  });
});
