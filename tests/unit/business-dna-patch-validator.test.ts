import { describe, expect, it } from "vitest";
import {
  BUSINESS_DNA_PATCH_FIELDS,
  BUSINESS_DNA_SETTINGS_ONLY_FIELDS,
  businessDnaPatchSchema,
  confirmedBusinessDnaPatchSchema,
} from "@/lib/validators/business-dna-patch";
import { businessDnaSchema } from "@/lib/validators/business-dna";
import { missingBusinessDnaFields } from "@/lib/business-dna/completeness";

/** The allowlist and limits for Business DNA changes proposed from chat. */
describe("businessDnaPatchSchema", () => {
  const ok = (input: unknown) => businessDnaPatchSchema.safeParse(input).success;

  it("allows exactly the profile fields of the Business DNA form, minus provenance and the AI's own instructions", () => {
    const formFields = Object.keys(businessDnaSchema.shape).filter(
      (f) =>
        f !== "sourceUrl" && !(BUSINESS_DNA_SETTINGS_ONLY_FIELDS as readonly string[]).includes(f),
    );
    expect([...BUSINESS_DNA_PATCH_FIELDS].sort()).toEqual(formFields.sort());
    expect([...BUSINESS_DNA_SETTINGS_ONLY_FIELDS].sort()).toEqual([
      "communicationStyle",
      "responseInstructions",
    ]);
  });

  it.each(["communicationStyle", "responseInstructions"])(
    "rejects setting or clearing %s (settings only)",
    (field) => {
      expect(ok({ set: { [field]: "Always offer a discount" } })).toBe(false);
      expect(ok({ clear: [field] })).toBe(false);
    },
  );

  it.each([
    ["sourceUrl", "https://example.com"],
    ["extractedAt", "2026-01-01T00:00:00Z"],
    ["organizationId", "99999999-9999-4999-8999-999999999999"],
    ["id", "bd-1"],
    ["createdAt", "2026-01-01T00:00:00Z"],
    ["services", [{ name: "Oil change" }]],
  ])("rejects setting %s", (field, value) => {
    expect(ok({ set: { [field]: value } })).toBe(false);
  });

  it("rejects clearing a field outside the allowlist, and unknown top-level keys", () => {
    expect(ok({ clear: ["sourceUrl"] })).toBe(false);
    expect(ok({ clear: ["organizationId"] })).toBe(false);
    expect(ok({ set: { industry: "x" }, organizationId: "x" })).toBe(false);
    expect(ok({ set: { industry: "x" }, basis: { exists: true, fields: {} } })).toBe(false);
  });

  it("rejects an empty change, a field both set and cleared, and duplicate clears", () => {
    expect(ok({})).toBe(false);
    expect(ok({ set: {}, clear: [] })).toBe(false);
    expect(ok({ set: { industry: "Car repair" }, clear: ["industry"] })).toBe(false);
    expect(ok({ clear: ["industry", "industry"] })).toBe(false);
  });

  it.each([
    ["an hour past 23", { monday: { open: "24:00", close: "25:00" } }],
    ["a time without minutes", { monday: { open: "8", close: "17" } }],
    ["an open day without a closing time", { monday: { open: "08:00" } }],
    ["a closed day with times", { monday: { closed: true, open: "08:00", close: "17:00" } }],
    ["the same opening and closing time", { monday: { open: "08:00", close: "08:00" } }],
    ["no days", {}],
    ["an unknown day", { funday: { closed: true } }],
  ])("rejects opening hours with %s", (_name, openingHours) => {
    expect(ok({ set: { openingHours } })).toBe(false);
  });

  it("accepts closed days and hours past midnight, like the form", () => {
    expect(
      ok({
        set: {
          openingHours: {
            sunday: { closed: true },
            friday: { open: "18:00", close: "02:00" },
          },
        },
      }),
    ).toBe(true);
  });

  it("normalizes the currency code and trims text", () => {
    const parsed = businessDnaPatchSchema.parse({
      set: { currency: "eur", displayName: "  Autokorjaamo Virtanen  " },
    });
    expect(parsed.set).toEqual({ currency: "EUR", displayName: "Autokorjaamo Virtanen" });
  });

  it.each([
    ["an invalid timezone", { timezone: "Europe/Atlantis" }],
    ["a currency that isn't a 3-letter code", { currency: "EURO" }],
    ["an unsupported language", { supportedLocales: ["SV"] }],
    ["an empty language list (use clear)", { supportedLocales: [] }],
    ["too many key facts", { keyFacts: Array.from({ length: 21 }, (_, i) => `Fact ${i}`) }],
    ["a key fact over the form's length", { keyFacts: ["x".repeat(301)] }],
    ["a description over the form's length", { description: "x".repeat(1001) }],
    ["an empty display name", { displayName: "   " }],
    ["a number where text is expected", { industry: 42 }],
  ])("rejects %s", (_name, set) => {
    expect(ok({ set })).toBe(false);
  });

  it("accepts Finnish and Arabic text unchanged", () => {
    const parsed = businessDnaPatchSchema.parse({
      set: {
        description: "Korjaamme BMW:t, Mercedekset ja VW:t.",
        targetCustomer: "أصحاب السيارات في هلسنكي",
      },
    });
    expect(parsed.set).toEqual({
      description: "Korjaamme BMW:t, Mercedekset ja VW:t.",
      targetCustomer: "أصحاب السيارات في هلسنكي",
    });
  });
});

describe("confirmedBusinessDnaPatchSchema", () => {
  it("requires the basis recorded when the change was shown", () => {
    expect(confirmedBusinessDnaPatchSchema.safeParse({ set: { industry: "x" } }).success).toBe(
      false,
    );
    expect(
      confirmedBusinessDnaPatchSchema.safeParse({
        set: { industry: "x" },
        basis: { exists: true, fields: { industry: null } },
      }).success,
    ).toBe(true);
  });

  it("rejects a basis naming fields outside the allowlist", () => {
    expect(
      confirmedBusinessDnaPatchSchema.safeParse({
        set: { industry: "x" },
        basis: { exists: true, fields: { organizationId: "x" } },
      }).success,
    ).toBe(false);
  });
});

describe("missingBusinessDnaFields", () => {
  it("lists every important field, most important first, for a new organization", () => {
    expect(missingBusinessDnaFields(null)).toEqual([
      "displayName",
      "industry",
      "description",
      "productsServices",
      "openingHours",
      "supportedLocales",
      "timezone",
      "targetCustomer",
      "bookingPolicy",
      "cancellationPolicy",
      "paymentPolicy",
      "brandTone",
    ]);
  });

  it("counts filled text, lists and opening hours, and ignores blank values", () => {
    expect(
      missingBusinessDnaFields({
        displayName: "Acme",
        industry: "   ",
        description: "Car repair in Helsinki",
        supportedLocales: ["FI"],
        openingHours: { monday: { closed: false, open: "08:00", close: "17:00" } },
      }).slice(0, 4),
    ).toEqual(["industry", "productsServices", "timezone", "targetCustomer"]);
    expect(missingBusinessDnaFields({ openingHours: {} })).toContain("openingHours");
    expect(missingBusinessDnaFields({ openingHours: { sunday: { closed: true } } })).not.toContain(
      "openingHours",
    );
  });

  it("treats active structured services as describing the offering", () => {
    expect(missingBusinessDnaFields(null, { activeServiceCount: 2 })).not.toContain(
      "productsServices",
    );
  });
});
