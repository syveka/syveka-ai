import { describe, expect, it } from "vitest";
import {
  businessDnaSchema,
  businessDnaServiceSchema,
  extractBusinessDnaRequestSchema,
  extractedBusinessDnaSchema,
  openingHoursSchema,
} from "@/lib/validators/business-dna";

describe("businessDnaSchema", () => {
  it("accepts a minimal empty submission and defaults arrays", () => {
    const parsed = businessDnaSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.supportedLocales).toEqual([]);
      expect(parsed.data.keyFacts).toEqual([]);
      expect(parsed.data.sourceUrl).toBeUndefined();
    }
  });

  it("rejects an unsupported locale", () => {
    const parsed = businessDnaSchema.safeParse({ supportedLocales: ["DE"] });
    expect(parsed.success).toBe(false);
  });

  it("rejects oversized free-text fields", () => {
    const parsed = businessDnaSchema.safeParse({ productsServices: "x".repeat(4001) });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 20 key facts", () => {
    const parsed = businessDnaSchema.safeParse({
      keyFacts: Array.from({ length: 21 }, (_, i) => `fact ${i}`),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a key fact over the per-item length limit", () => {
    const parsed = businessDnaSchema.safeParse({ keyFacts: ["x".repeat(301)] });
    expect(parsed.success).toBe(false);
  });

  it("treats an empty-string sourceUrl as absent", () => {
    const parsed = businessDnaSchema.safeParse({ sourceUrl: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sourceUrl).toBeUndefined();
  });

  it("rejects a non-URL sourceUrl", () => {
    const parsed = businessDnaSchema.safeParse({ sourceUrl: "not-a-url" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown top-level opening-hours key", () => {
    const parsed = businessDnaSchema.safeParse({
      openingHours: { funday: { open: "09:00", close: "17:00", closed: false } },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an organizationId supplied by the client", () => {
    const parsed = businessDnaSchema.safeParse({
      displayName: "Acme",
      organizationId: "00000000-0000-0000-0000-000000000999",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects arbitrary unknown top-level fields instead of silently stripping them", () => {
    const parsed = businessDnaSchema.safeParse({
      displayName: "Acme",
      isSuperadmin: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a well-formed IANA timezone", () => {
    const parsed = businessDnaSchema.safeParse({ timezone: "Europe/Helsinki" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.timezone).toBe("Europe/Helsinki");
  });

  it("rejects a timezone string that is not a real IANA zone", () => {
    const parsed = businessDnaSchema.safeParse({ timezone: "Not/A_Real_Zone" });
    expect(parsed.success).toBe(false);
  });

  it("treats an empty-string timezone as absent", () => {
    const parsed = businessDnaSchema.safeParse({ timezone: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.timezone).toBeUndefined();
  });

  it("accepts and uppercases a lowercase 3-letter currency code", () => {
    const parsed = businessDnaSchema.safeParse({ currency: "eur" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currency).toBe("EUR");
  });

  it("rejects a currency code that is not exactly 3 letters", () => {
    expect(businessDnaSchema.safeParse({ currency: "EURO" }).success).toBe(false);
    expect(businessDnaSchema.safeParse({ currency: "E1" }).success).toBe(false);
  });

  it("accepts the new structured policy fields independently of otherPolicies", () => {
    const parsed = businessDnaSchema.safeParse({
      cancellationPolicy: "24h notice",
      bookingPolicy: "Book ahead",
      refundPolicy: "No refunds",
      paymentPolicy: "Card only",
      otherPolicies: "See website",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cancellationPolicy).toBe("24h notice");
      expect(parsed.data.bookingPolicy).toBe("Book ahead");
      expect(parsed.data.refundPolicy).toBe("No refunds");
      expect(parsed.data.paymentPolicy).toBe("Card only");
      expect(parsed.data.otherPolicies).toBe("See website");
    }
  });

  it("rejects the legacy field name 'policies' as an unknown key (renamed to otherPolicies)", () => {
    const parsed = businessDnaSchema.safeParse({ policies: "No refunds" });
    expect(parsed.success).toBe(false);
  });
});

describe("openingHoursSchema", () => {
  it("accepts a fully specified week", () => {
    const parsed = openingHoursSchema.safeParse({
      monday: { open: "09:00", close: "17:00", closed: false },
      sunday: { closed: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an open day missing open/close times", () => {
    const parsed = openingHoursSchema.safeParse({ monday: { closed: false } });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed time string", () => {
    const parsed = openingHoursSchema.safeParse({
      monday: { open: "9am", close: "17:00", closed: false },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown fields inside a weekday", () => {
    const parsed = openingHoursSchema.safeParse({
      monday: { open: "09:00", close: "17:00", closed: false, organizationId: "other-org" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("extractBusinessDnaRequestSchema", () => {
  it("rejects a non-URL string", () => {
    expect(extractBusinessDnaRequestSchema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("accepts a well-formed https URL", () => {
    expect(extractBusinessDnaRequestSchema.safeParse({ url: "https://example.com" }).success).toBe(
      true,
    );
  });

  it("rejects unknown request fields", () => {
    expect(
      extractBusinessDnaRequestSchema.safeParse({
        url: "https://example.com",
        organizationId: "other-org",
      }).success,
    ).toBe(false);
  });
});

describe("extractedBusinessDnaSchema", () => {
  it("accepts a fully empty object (every field optional)", () => {
    expect(extractedBusinessDnaSchema.safeParse({}).success).toBe(true);
  });

  it("drops the request if an unsupported locale is present", () => {
    expect(extractedBusinessDnaSchema.safeParse({ supportedLocales: ["ZZ"] }).success).toBe(false);
  });

  it("rejects unknown top-level keys the model might hallucinate", () => {
    const result = extractedBusinessDnaSchema.safeParse({
      displayName: "Acme",
      competitorAnalysis: "should not be accepted",
    });
    expect(result.success).toBe(false);
  });
});

describe("businessDnaServiceSchema", () => {
  it("accepts a minimal service with just a name", () => {
    const parsed = businessDnaServiceSchema.safeParse({ name: "Haircut" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isActive).toBe(true);
      expect(parsed.data.sortOrder).toBe(0);
      expect(parsed.data.priceCents).toBeUndefined();
    }
  });

  it("rejects a missing/empty name", () => {
    expect(businessDnaServiceSchema.safeParse({}).success).toBe(false);
    expect(businessDnaServiceSchema.safeParse({ name: "" }).success).toBe(false);
    expect(businessDnaServiceSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("coerces a numeric-string priceCents to an integer", () => {
    const parsed = businessDnaServiceSchema.safeParse({ name: "Haircut", priceCents: "2500" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.priceCents).toBe(2500);
  });

  it("rejects a non-integer priceCents (e.g. a stray decimal major-unit value)", () => {
    const parsed = businessDnaServiceSchema.safeParse({ name: "Haircut", priceCents: 10.5 });
    expect(parsed.success).toBe(false);
  });

  it("rejects NaN priceCents (the deliberate fail-closed sentinel for malformed price input)", () => {
    const parsed = businessDnaServiceSchema.safeParse({ name: "Haircut", priceCents: Number.NaN });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative priceCents", () => {
    expect(businessDnaServiceSchema.safeParse({ name: "Haircut", priceCents: -1 }).success).toBe(
      false,
    );
  });

  it("rejects a negative durationMinutes", () => {
    expect(
      businessDnaServiceSchema.safeParse({ name: "Haircut", durationMinutes: -1 }).success,
    ).toBe(false);
  });

  it("rejects a client-supplied id, organizationId, or businessDnaId", () => {
    expect(
      businessDnaServiceSchema.safeParse({
        name: "Haircut",
        id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      businessDnaServiceSchema.safeParse({
        name: "Haircut",
        organizationId: "other-org",
      }).success,
    ).toBe(false);
    expect(
      businessDnaServiceSchema.safeParse({
        name: "Haircut",
        businessDnaId: "other-dna",
      }).success,
    ).toBe(false);
  });

  it("coerces the isActive checkbox presence into a boolean", () => {
    const parsed = businessDnaServiceSchema.safeParse({ name: "Haircut", isActive: "true" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isActive).toBe(true);
  });
});
