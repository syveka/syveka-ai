import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput, OpeningHours } from "@/lib/validators/business-dna";
import { Prisma } from "@/generated/prisma/client/client";

/**
 * The Business DNA form always rendered all seven days, and a day nobody
 * touched is "closed, 09:00-17:00". Saving the form untouched used to store
 * that week, so the AI then told customers the business is closed every day
 * and the completeness check counted opening hours as filled. The form now
 * sends opening hours only when the user changed them; the save then keeps
 * whatever is stored (keepOpeningHours). Any week that is sent, including a
 * deliberately all-closed one, is stored exactly as sent.
 */
const { tenantDbMock } = vi.hoisted(() => ({ tenantDbMock: vi.fn() }));

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock, unscopedPrisma: {} }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/voice", () => ({
  resyncActiveAssistants: vi.fn(async () => undefined),
}));

import { upsertBusinessDNA } from "@/server/services/business-dna";
import { buildBusinessDnaPromptBlock } from "@/server/business-dna/context";
import type { BusinessDnaContext } from "@/server/business-dna/context";
import { missingBusinessDnaFields } from "@/lib/business-dna/completeness";
import { normalizeOpeningHours } from "@/lib/business-dna/opening-hours";

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "OWNER",
  locale: "en",
};
const LOADED = "2026-11-22T10:00:00.000Z";
const KEEP = { keepOpeningHours: true };

/** Seven closed days with the default times: untouched, or chosen on purpose. */
const allClosedWeek = (): OpeningHours => normalizeOpeningHours(null);
const storedWeek = { monday: { closed: false, open: "08:00", close: "16:00" } };

const input = (openingHours?: OpeningHours | null): BusinessDNAInput => ({
  displayName: "Acme",
  supportedLocales: [],
  keyFacts: [],
  ...(openingHours !== undefined ? { openingHours } : {}),
});

type QueryArgs = { data: Record<string, unknown> };

function mockDb() {
  return {
    businessDNA: {
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: "bd-new", ...data })),
      updateMany: vi.fn(async (_args: QueryArgs) => ({ count: 1 })),
    },
  };
}

let db: ReturnType<typeof mockDb>;
beforeEach(() => {
  vi.clearAllMocks();
  db = mockDb();
  tenantDbMock.mockReturnValue(db);
});

const created = () => db.businessDNA.create.mock.calls[0]![0]!.data;
const updated = () => db.businessDNA.updateMany.mock.calls[0]![0]!.data;

describe("opening hours the user did not touch (form sends none)", () => {
  it("(a) a first save stores no opening hours", async () => {
    await upsertBusinessDNA(ctx, input(), null, KEEP);
    expect(created().openingHours).toBe(Prisma.JsonNull);
  });

  it("(b) an unrelated edit while hours are unset leaves them unset", async () => {
    db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1", openingHours: null });
    const result = await upsertBusinessDNA(ctx, input(), LOADED, KEEP);
    expect(updated()).not.toHaveProperty("openingHours");
    expect(updated().displayName).toBe("Acme");
    expect(result).toMatchObject({ ok: true, record: { openingHours: null } });
  });

  it("(c) an unrelated edit keeps stored hours exactly as stored", async () => {
    db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1", openingHours: storedWeek });
    const result = await upsertBusinessDNA(ctx, input(), LOADED, KEEP);
    expect(updated()).not.toHaveProperty("openingHours");
    expect(result).toMatchObject({ ok: true, record: { openingHours: storedWeek } });
  });
});

describe("opening hours that are sent are stored as sent", () => {
  it("(d) a deliberately all-closed week saved for the first time is stored", async () => {
    await upsertBusinessDNA(ctx, input(allClosedWeek()), null, { keepOpeningHours: false });
    expect(created().openingHours).toEqual(allClosedWeek());
  });

  it("(e) an explicit all-closed week from the API is stored, also with no stored hours", async () => {
    db.businessDNA.findFirst.mockResolvedValue({ id: "bd-1", openingHours: null });
    await upsertBusinessDNA(ctx, input(allClosedWeek()), LOADED);
    expect(updated().openingHours).toEqual(allClosedWeek());
  });

  it("(f) an explicit clear still clears stored hours", async () => {
    db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1", openingHours: null });
    const result = await upsertBusinessDNA(ctx, input(null), LOADED);
    expect(updated().openingHours).toBe(Prisma.JsonNull);
    expect(result).toMatchObject({ ok: true, record: { openingHours: null } });
  });

  it("without keepOpeningHours (the API's full replace), omitted hours still clear", async () => {
    db.businessDNA.findFirst.mockResolvedValueOnce({ id: "bd-1", openingHours: null });
    await upsertBusinessDNA(ctx, input(), LOADED);
    expect(updated().openingHours).toBe(Prisma.JsonNull);
  });
});

describe("unset opening hours downstream", () => {
  const profile = (openingHours: unknown): BusinessDnaContext => ({
    displayName: "Acme",
    industry: null,
    description: null,
    productsServices: null,
    supportedLocales: [],
    timezone: null,
    brandTone: null,
    communicationStyle: null,
    responseInstructions: null,
    openingHours,
    cancellationPolicy: null,
    bookingPolicy: null,
    refundPolicy: null,
    paymentPolicy: null,
    otherPolicies: null,
    currency: null,
    quoteInstructions: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
    services: [],
  });

  it("are absent from the AI prompt context", () => {
    const block = buildBusinessDnaPromptBlock(profile(null))!;
    expect(block).toContain("Acme");
    expect(block).not.toContain("Opening hours");
    expect(block).not.toMatch(/closed/i);
  });

  it("are reported missing by the completeness check", () => {
    expect(missingBusinessDnaFields({ openingHours: null })).toContain("openingHours");
  });
});
