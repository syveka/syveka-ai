import { describe, expect, it } from "vitest";
import zod3ToolInputSchemas from "./fixtures/tool-input-schemas.zod3.json";
import { TOOL_REGISTRY, zodToJsonSchema } from "@/server/ai/tools";
import { isoDateTime } from "@/lib/validators/datetime";
import { confirmedBusinessDnaPatchSchema } from "@/lib/validators/business-dna-patch";
import { contactSchema } from "@/lib/validators/crm";
import { publicBookingSchema } from "@/lib/validators/booking";

/**
 * The Zod 3 → 4 upgrade keeps what the app accepts and what it tells the
 * model. Each case here is a place where Zod 4's defaults differ from Zod 3's
 * and the code was adjusted to keep the Zod 3 behaviour.
 */

const tool = (name: string) => {
  const found = TOOL_REGISTRY.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe("tool input schemas sent to the model", () => {
  it("are exactly what Zod 3 produced (main 67f8961, zod 3.25.76)", () => {
    const current = Object.fromEntries(
      TOOL_REGISTRY.map((t) => [t.name, zodToJsonSchema(t.schema)]),
    );
    expect(current).toEqual(zod3ToolInputSchemas);
  });
});

describe("timestamps (Zod 4's datetime() requires seconds by default)", () => {
  it.each(["2026-10-24T10:00Z", "2026-10-24T10:00:00Z", "2026-10-24T10:00:00.123Z"])(
    "accepts %s",
    (value) => {
      expect(isoDateTime().safeParse(value).success).toBe(true);
    },
  );

  it.each(["2026-10-24T10:00:00+02:00", "2026-10-24", "2026-10-24T10:00", "2026-10-24T25:00Z"])(
    "rejects %s",
    (value) => {
      expect(isoDateTime().safeParse(value).success).toBe(false);
    },
  );

  it("still lets a model book a meeting at a minute-precision time", () => {
    const parsed = tool("bookMeeting").schema.safeParse({
      title: "Intro call",
      startsAt: "2026-10-24T10:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("still lets a guest book a minute-precision slot", () => {
    const parsed = publicBookingSchema.safeParse({
      startsAt: "2026-10-24T10:00Z",
      name: "Guest",
      email: "guest@example.com",
      timezone: "Europe/Helsinki",
      consent: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ids (Zod 4's uuid() accepts only RFC 9562 versions and variants)", () => {
  it.each(["11111111-1111-1111-1111-111111111111", "3f1c2a4e-8b7d-0c3e-0a1f-2b3c4d5e6f70"])(
    "accepts the 8-4-4-4-12 hex id %s, as Zod 3 did",
    (contactId) => {
      const parsed = tool("logActivity").schema.safeParse({
        contactId,
        type: "NOTE",
        subject: "Hi",
      });
      expect(parsed.success).toBe(true);
    },
  );

  it.each([
    "3f1c2a4e8b7d4c3e9a1f2b3c4d5e6f70",
    "not-a-uuid",
    "{3f1c2a4e-8b7d-4c3e-9a1f-2b3c4d5e6f70}",
  ])("rejects %s", (contactId) => {
    const parsed = tool("logActivity").schema.safeParse({ contactId, type: "NOTE", subject: "Hi" });
    expect(parsed.success).toBe(false);
  });
});

describe("a confirmed Business DNA change (Zod 4's record() of an enum requires every key)", () => {
  const base = { set: { industry: "Dental" }, basis: { exists: true, fields: { industry: null } } };

  it("accepts a basis holding only the fields that change", () => {
    expect(confirmedBusinessDnaPatchSchema.safeParse(base).success).toBe(true);
  });

  it("still refuses a basis field that isn't a Business DNA field", () => {
    const parsed = confirmedBusinessDnaPatchSchema.safeParse({
      ...base,
      basis: { exists: true, fields: { industry: null, ownerEmail: "x@example.com" } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('optional form fields ("" means not given)', () => {
  it("leave out what wasn't filled in", () => {
    const parsed = contactSchema.parse({ firstName: "Ada", lastName: "", email: "" });
    expect(parsed.firstName).toBe("Ada");
    expect(parsed.lastName).toBeUndefined();
    expect(parsed.email).toBeUndefined();
  });

  it("still validate what was filled in", () => {
    expect(contactSchema.safeParse({ firstName: "Ada", email: "not-an-email" }).success).toBe(
      false,
    );
  });
});
