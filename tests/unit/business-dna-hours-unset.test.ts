import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput, OpeningHours } from "@/lib/validators/business-dna";
import { Prisma } from "@/generated/prisma/client/client";

/**
 * The Business DNA form always submits all seven days, and a day nobody
 * touched is "closed, 09:00-17:00". Saving the form untouched used to store
 * that week, so the AI then told customers the business is closed every day
 * and the completeness check counted opening hours as filled. A first save
 * of exactly that week now stores no hours (unset). Every deliberate week is
 * still stored as sent.
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
import { DAY_KEYS, normalizeOpeningHours } from "@/lib/business-dna/opening-hours";

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "OWNER",
  locale: "en",
};
const LOADED = "2026-11-22T10:00:00.000Z";

/** Exactly what the form submits when nobody touched the opening hours. */
const untouchedWeek = (): OpeningHours => normalizeOpeningHours(null);

const input = (openingHours: OpeningHours | null): BusinessDNAInput => ({
  displayName: "Acme",
  supportedLocales: [],
  keyFacts: [],
  openingHours,
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

const createdHours = () => db.businessDNA.create.mock.calls[0]![0]!.data.openingHours;
const updatedHours = () => db.businessDNA.updateMany.mock.calls[0]![0]!.data.openingHours;

describe("saving the Business DNA form with untouched opening hours", () => {
  it("the untouched week is all seven days closed with the default times", () => {
    const week = untouchedWeek();
    expect(Object.keys(week)).toEqual([...DAY_KEYS]);
    for (const day of DAY_KEYS) {
      expect(week[day]).toEqual({ closed: true, open: "09:00", close: "17:00" });
    }
  });

  it("a first save (no profile yet) stores no opening hours", async () => {
    const result = await upsertBusinessDNA(ctx, input(untouchedWeek()), null);
    expect(createdHours()).toBe(Prisma.JsonNull);
    expect(result).toMatchObject({ ok: true });
  });

  it("a save over a profile with no stored hours stores no opening hours", async () => {
    db.businessDNA.findFirst
      .mockResolvedValueOnce({ openingHours: null })
      .mockResolvedValueOnce({ id: "bd-1", openingHours: null });
    const result = await upsertBusinessDNA(ctx, input(untouchedWeek()), LOADED);
    expect(updatedHours()).toBe(Prisma.JsonNull);
    expect(result).toMatchObject({ ok: true, record: { openingHours: null } });
  });

  it("an all-closed week over stored hours is stored: the user closed every day", async () => {
    db.businessDNA.findFirst
      .mockResolvedValueOnce({
        openingHours: { monday: { closed: false, open: "08:00", close: "16:00" } },
      })
      .mockResolvedValueOnce({ id: "bd-1" });
    await upsertBusinessDNA(ctx, input(untouchedWeek()), LOADED);
    expect(updatedHours()).toEqual(untouchedWeek());
  });

  it("a week with an open day is stored", async () => {
    const week = { ...untouchedWeek(), monday: { closed: false, open: "09:00", close: "17:00" } };
    await upsertBusinessDNA(ctx, input(week), null);
    expect(createdHours()).toEqual(week);
  });

  it("an all-closed week with a changed time is stored", async () => {
    const week = { ...untouchedWeek(), friday: { closed: true, open: "09:00", close: "18:00" } };
    await upsertBusinessDNA(ctx, input(week), null);
    expect(createdHours()).toEqual(week);
  });

  it("a week missing a day is stored as sent", async () => {
    const week: OpeningHours = untouchedWeek();
    delete week.sunday;
    await upsertBusinessDNA(ctx, input(week), null);
    expect(createdHours()).toEqual(week);
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
