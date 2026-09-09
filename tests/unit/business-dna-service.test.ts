import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput } from "@/lib/validators/business-dna";

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
    },
  };
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
      const record = await upsertBusinessDNA(ctx("org-a"), minimalInput({ displayName: "Acme" }));

      expect(db.businessDNA.create).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.update).not.toHaveBeenCalled();
      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        displayName: "Acme",
        industry: null,
        keyFacts: [],
      });
      expect(record.id).toBe("bd-new");
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "business_dna.create", resourceType: "business_dna" }),
      );
    });

    it("updates the existing profile instead of creating a second one", async () => {
      db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1" });

      await upsertBusinessDNA(ctx("org-a"), minimalInput({ displayName: "Acme v2" }));

      expect(db.businessDNA.update).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.create).not.toHaveBeenCalled();
      expect(db.businessDNA.update.mock.calls[0]![0]!.where).toEqual({ id: "bd-1" });
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "business_dna.update" }),
      );
    });

    it("stamps extractedAt when a sourceUrl is present", async () => {
      await upsertBusinessDNA(ctx("org-a"), minimalInput({ sourceUrl: "https://example.com" }));

      const data = db.businessDNA.create.mock.calls[0]![0]!.data;
      expect(data.sourceUrl).toBe("https://example.com");
      expect(data.extractedAt).toBeInstanceOf(Date);
    });

    it("clears provenance when no sourceUrl is submitted", async () => {
      await upsertBusinessDNA(ctx("org-a"), minimalInput());

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

      await upsertBusinessDNA(ctx("org-b"), minimalInput({ displayName: "Org B" }));

      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
      expect(dbB.businessDNA.create).toHaveBeenCalledTimes(1);
      expect(db.businessDNA.create).not.toHaveBeenCalled();
    });

    it("re-syncs any already-live voice assistant after a successful save (a saved profile must not silently leave the assistant stale)", async () => {
      await upsertBusinessDNA(ctx("org-a"), minimalInput({ displayName: "Acme" }));

      expect(resyncActiveAssistantsMock).toHaveBeenCalledTimes(1);
      expect(resyncActiveAssistantsMock).toHaveBeenCalledWith("org-a");
    });

    it("still returns the saved record after triggering the resync (resync is a fire-and-await follow-up, not a precondition of success)", async () => {
      const record = await upsertBusinessDNA(ctx("org-a"), minimalInput({ displayName: "Acme" }));

      expect(record.id).toBe("bd-new");
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
