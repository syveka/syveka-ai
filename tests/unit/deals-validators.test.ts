import { describe, expect, it } from "vitest";
import {
  dealSchema,
  dealTaskSchema,
  moveDealSchema,
  pipelineStageSchema,
} from "@/lib/validators/crm";

const STAGE_ID = "11111111-1111-4111-8111-111111111111";

describe("dealSchema", () => {
  it("applies defaults for a minimal deal", () => {
    const parsed = dealSchema.parse({ title: "ERP rollout", stageId: STAGE_ID });
    expect(parsed.title).toBe("ERP rollout");
    expect(parsed.valueCents).toBe(0);
    expect(parsed.currency).toBe("EUR");
    expect(parsed.probability).toBeUndefined();
    expect(parsed.contactId).toBeUndefined();
    expect(parsed.ownerId).toBeUndefined();
  });

  it("normalizes empty form fields to undefined", () => {
    const parsed = dealSchema.parse({
      title: "Deal",
      stageId: STAGE_ID,
      probability: "",
      contactId: "",
      companyId: "",
      ownerId: "",
      expectedCloseAt: "",
    });
    expect(parsed.probability).toBeUndefined();
    expect(parsed.contactId).toBeUndefined();
    expect(parsed.companyId).toBeUndefined();
    expect(parsed.ownerId).toBeUndefined();
    expect(parsed.expectedCloseAt).toBeUndefined();
  });

  it("coerces numeric form strings", () => {
    const parsed = dealSchema.parse({
      title: "Deal",
      stageId: STAGE_ID,
      valueCents: "150000",
      probability: "75",
    });
    expect(parsed.valueCents).toBe(150_000);
    expect(parsed.probability).toBe(75);
  });

  it("rejects invalid probability, value and currency", () => {
    const base = { title: "Deal", stageId: STAGE_ID };
    expect(dealSchema.safeParse({ ...base, probability: "101" }).success).toBe(false);
    expect(dealSchema.safeParse({ ...base, probability: "-1" }).success).toBe(false);
    expect(dealSchema.safeParse({ ...base, valueCents: "-5" }).success).toBe(false);
    expect(dealSchema.safeParse({ ...base, currency: "BTC" }).success).toBe(false);
  });

  it("rejects a missing or malformed stage id and empty title", () => {
    expect(dealSchema.safeParse({ title: "Deal" }).success).toBe(false);
    expect(dealSchema.safeParse({ title: "Deal", stageId: "nope" }).success).toBe(false);
    expect(dealSchema.safeParse({ title: "   ", stageId: STAGE_ID }).success).toBe(false);
  });

  it("accepts ISO dates and rejects garbage dates", () => {
    expect(
      dealSchema.parse({ title: "D", stageId: STAGE_ID, expectedCloseAt: "2026-08-15" })
        .expectedCloseAt,
    ).toBe("2026-08-15");
    expect(
      dealSchema.safeParse({ title: "D", stageId: STAGE_ID, expectedCloseAt: "not-a-date" })
        .success,
    ).toBe(false);
  });
});

describe("moveDealSchema", () => {
  it("requires uuids and defaults position to 0", () => {
    const parsed = moveDealSchema.parse({ dealId: STAGE_ID, stageId: STAGE_ID });
    expect(parsed.position).toBe(0);
    expect(moveDealSchema.safeParse({ dealId: "x", stageId: STAGE_ID }).success).toBe(false);
    expect(
      moveDealSchema.safeParse({ dealId: STAGE_ID, stageId: STAGE_ID, position: -1 }).success,
    ).toBe(false);
  });
});

describe("dealTaskSchema", () => {
  it("requires a title and accepts an optional datetime-local due date", () => {
    const parsed = dealTaskSchema.parse({ title: "Send proposal", dueAt: "2026-08-01T09:00" });
    expect(parsed.title).toBe("Send proposal");
    expect(parsed.dueAt).toBe("2026-08-01T09:00");
    expect(dealTaskSchema.parse({ title: "T", dueAt: "" }).dueAt).toBeUndefined();
    expect(dealTaskSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(dealTaskSchema.safeParse({ title: "T", dueAt: "later" }).success).toBe(false);
  });
});

describe("pipelineStageSchema", () => {
  it("applies open/0 defaults and validates ranges", () => {
    const parsed = pipelineStageSchema.parse({ name: "Demo" });
    expect(parsed.kind).toBe("open");
    expect(parsed.probability).toBe(0);
    expect(pipelineStageSchema.parse({ name: "Demo", probability: "60" }).probability).toBe(60);
    expect(pipelineStageSchema.safeParse({ name: "" }).success).toBe(false);
    expect(pipelineStageSchema.safeParse({ name: "D", probability: 101 }).success).toBe(false);
    expect(pipelineStageSchema.safeParse({ name: "D", kind: "half" }).success).toBe(false);
  });
});
