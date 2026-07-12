import { describe, expect, it } from "vitest";
import {
  companyListQuerySchema,
  companySchema,
  contactListQuerySchema,
  contactSchema,
  noteSchema,
} from "@/lib/validators/crm";

describe("contactSchema", () => {
  it("applies defaults for a minimal contact", () => {
    const parsed = contactSchema.parse({ firstName: "Ada" });
    expect(parsed.firstName).toBe("Ada");
    expect(parsed.status).toBe("LEAD");
    expect(parsed.gdprConsent).toBe(false);
    expect(parsed.email).toBeUndefined();
    expect(parsed.companyId).toBeUndefined();
  });

  it("normalizes empty form fields to undefined", () => {
    const parsed = contactSchema.parse({
      firstName: "Ada",
      lastName: "",
      email: "",
      phone: "",
      title: "",
      companyId: "",
    });
    expect(parsed.lastName).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
    expect(parsed.title).toBeUndefined();
    expect(parsed.companyId).toBeUndefined();
  });

  it("trims whitespace", () => {
    const parsed = contactSchema.parse({ firstName: "  Ada  ", lastName: " Lovelace " });
    expect(parsed.firstName).toBe("Ada");
    expect(parsed.lastName).toBe("Lovelace");
  });

  it("rejects an empty first name", () => {
    expect(contactSchema.safeParse({ firstName: "   " }).success).toBe(false);
    expect(contactSchema.safeParse({}).success).toBe(false);
  });

  it("rejects invalid email and company id", () => {
    expect(contactSchema.safeParse({ firstName: "A", email: "not-an-email" }).success).toBe(false);
    expect(contactSchema.safeParse({ firstName: "A", companyId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("rejects unknown statuses", () => {
    expect(contactSchema.safeParse({ firstName: "A", status: "VIP" }).success).toBe(false);
  });

  it("coerces the gdprConsent checkbox value", () => {
    expect(contactSchema.parse({ firstName: "A", gdprConsent: "true" }).gdprConsent).toBe(true);
  });
});

describe("companySchema", () => {
  it("applies defaults for a minimal company", () => {
    const parsed = companySchema.parse({ name: "Acme Oy" });
    expect(parsed.name).toBe("Acme Oy");
    expect(parsed.domain).toBeUndefined();
    expect(parsed.website).toBeUndefined();
  });

  it("normalizes empty form fields to undefined", () => {
    const parsed = companySchema.parse({
      name: "Acme",
      domain: "",
      industry: "",
      size: "",
      website: "",
      businessId: "",
    });
    expect(parsed.domain).toBeUndefined();
    expect(parsed.industry).toBeUndefined();
    expect(parsed.website).toBeUndefined();
    expect(parsed.businessId).toBeUndefined();
  });

  it("requires a name", () => {
    expect(companySchema.safeParse({ name: "" }).success).toBe(false);
    expect(companySchema.safeParse({}).success).toBe(false);
  });

  it("requires website to be a valid URL when present", () => {
    expect(companySchema.safeParse({ name: "Acme", website: "not-a-url" }).success).toBe(false);
    expect(companySchema.parse({ name: "Acme", website: "https://acme.fi" }).website).toBe(
      "https://acme.fi",
    );
  });
});

describe("noteSchema", () => {
  it("rejects empty or whitespace-only notes", () => {
    expect(noteSchema.safeParse({ body: "" }).success).toBe(false);
    expect(noteSchema.safeParse({ body: "   " }).success).toBe(false);
  });

  it("accepts a normal note and enforces max length", () => {
    expect(noteSchema.parse({ body: "Called about renewal" }).body).toBe("Called about renewal");
    expect(noteSchema.safeParse({ body: "x".repeat(4001) }).success).toBe(false);
  });
});

describe("list query schemas", () => {
  it("contact list defaults", () => {
    const parsed = contactListQuerySchema.parse({});
    expect(parsed.limit).toBe(25);
    expect(parsed.archived).toBe("active");
    expect(parsed.status).toBeUndefined();
  });

  it("coerces limit and validates bounds", () => {
    expect(contactListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(contactListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("validates archived filter and cursor", () => {
    expect(contactListQuerySchema.parse({ archived: "all" }).archived).toBe("all");
    expect(contactListQuerySchema.safeParse({ archived: "nope" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);
  });

  it("company list defaults and filters", () => {
    const parsed = companyListQuerySchema.parse({});
    expect(parsed.limit).toBe(25);
    expect(parsed.archived).toBe("active");
    expect(companyListQuerySchema.parse({ archived: "archived" }).archived).toBe("archived");
  });
});
