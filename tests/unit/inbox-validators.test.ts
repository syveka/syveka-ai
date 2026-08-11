import { describe, expect, it } from "vitest";
import {
  assignThreadSchema,
  createDraftMessageSchema,
  recordInboundMessageSchema,
  threadListQuerySchema,
  updateThreadStatusSchema,
} from "@/lib/validators/inbox";

describe("recordInboundMessageSchema", () => {
  it("accepts a minimal valid inbound message", () => {
    const parsed = recordInboundMessageSchema.safeParse({ channel: "EMAIL", body: "Hello" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown channel", () => {
    expect(
      recordInboundMessageSchema.safeParse({ channel: "CARRIER_PIGEON", body: "Hello" }).success,
    ).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(recordInboundMessageSchema.safeParse({ channel: "EMAIL", body: "" }).success).toBe(
      false,
    );
  });

  it("rejects a body over the length limit", () => {
    expect(
      recordInboundMessageSchema.safeParse({ channel: "EMAIL", body: "x".repeat(10_001) }).success,
    ).toBe(false);
  });

  it("rejects a malformed contactId", () => {
    expect(
      recordInboundMessageSchema.safeParse({
        channel: "EMAIL",
        body: "Hello",
        contactId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("treats an empty-string contactId as absent", () => {
    const parsed = recordInboundMessageSchema.safeParse({
      channel: "EMAIL",
      body: "Hello",
      contactId: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.contactId).toBeUndefined();
  });
});

describe("createDraftMessageSchema", () => {
  it("defaults aiGenerated to false", () => {
    const parsed = createDraftMessageSchema.safeParse({
      threadId: "11111111-1111-4111-8111-111111111111",
      body: "Thanks for reaching out!",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.aiGenerated).toBe(false);
  });

  it("rejects a missing threadId", () => {
    expect(createDraftMessageSchema.safeParse({ body: "Hello" }).success).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(
      createDraftMessageSchema.safeParse({
        threadId: "11111111-1111-4111-8111-111111111111",
        body: "",
      }).success,
    ).toBe(false);
  });
});

describe("threadListQuerySchema", () => {
  it("defaults limit to 25 and leaves filters optional", () => {
    const parsed = threadListQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(25);
      expect(parsed.data.status).toBeUndefined();
      expect(parsed.data.channel).toBeUndefined();
    }
  });

  it("rejects a limit over 100", () => {
    expect(threadListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(threadListQuerySchema.safeParse({ status: "ARCHIVED" }).success).toBe(false);
  });
});

describe("updateThreadStatusSchema", () => {
  it("accepts each valid status", () => {
    for (const status of ["OPEN", "PENDING", "CLOSED"]) {
      expect(updateThreadStatusSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects an invalid status", () => {
    expect(updateThreadStatusSchema.safeParse({ status: "ARCHIVED" }).success).toBe(false);
  });
});

describe("assignThreadSchema", () => {
  it("treats an empty-string assignedToId as unassignment", () => {
    const parsed = assignThreadSchema.safeParse({ assignedToId: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.assignedToId).toBeUndefined();
  });

  it("rejects a malformed assignedToId", () => {
    expect(assignThreadSchema.safeParse({ assignedToId: "not-a-uuid" }).success).toBe(false);
  });
});
