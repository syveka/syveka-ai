import { describe, expect, it } from "vitest";
import {
  businessDnaSchema,
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
