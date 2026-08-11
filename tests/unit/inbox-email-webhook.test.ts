import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class DuplicateInboundMessageError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DuplicateInboundMessageError";
    }
  }
  return {
    recordInboundMessage: vi.fn(
      async (): Promise<{
        thread: { id: string };
        message: { id: string };
        duplicate: boolean;
      }> => ({
        thread: { id: "t1" },
        message: { id: "m1" },
        duplicate: false,
      }),
    ),
    limit: vi.fn(async () => ({
      success: true,
      reset: Date.now() + 60_000,
      limit: 60,
      remaining: 59,
    })),
    DuplicateInboundMessageError,
  };
});

vi.mock("@/server/services/inbox", () => ({
  recordInboundMessage: mocks.recordInboundMessage,
  DuplicateInboundMessageError: mocks.DuplicateInboundMessageError,
}));
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { inboxEmailWebhook: { limit: mocks.limit } },
}));

import { POST } from "@/app/api/v1/webhooks/inbox-email/route";

const SECRET = "a".repeat(32);
const ORG_ID = "11111111-1111-4111-8111-111111111111";

function request(
  body: unknown,
  headers: Record<string, string> = { "x-inbox-webhook-secret": SECRET },
) {
  return new Request("http://localhost/api/v1/webhooks/inbox-email", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validPayload = {
  organizationId: ORG_ID,
  fromAddress: "customer@example.com",
  toAddress: "inbox@syveka.ai",
  subject: "Question about pricing",
  body: "Hi, how much does this cost?",
  externalId: "ext-1",
};

describe("POST /api/v1/webhooks/inbox-email", () => {
  const originalSecret = process.env.INBOX_EMAIL_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INBOX_EMAIL_WEBHOOK_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.INBOX_EMAIL_WEBHOOK_SECRET = originalSecret;
  });

  it("fails closed when the webhook secret is not configured", async () => {
    delete process.env.INBOX_EMAIL_WEBHOOK_SECRET;
    const response = await POST(request(validPayload));
    expect(response.status).toBe(503);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects a request with no secret header", async () => {
    const response = await POST(request(validPayload, {}));
    expect(response.status).toBe(401);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    const response = await POST(
      request(validPayload, { "x-inbox-webhook-secret": "wrong-secret" }),
    );
    expect(response.status).toBe(401);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload", async () => {
    const response = await POST(request({ organizationId: "not-a-uuid" }));
    expect(response.status).toBe(400);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("rate-limits per organization", async () => {
    mocks.limit.mockResolvedValueOnce({
      success: false,
      reset: Date.now(),
      limit: 60,
      remaining: 0,
    });
    const response = await POST(request(validPayload));
    expect(response.status).toBe(429);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("accepts a valid signed payload and records the inbound message", async () => {
    const response = await POST(request(validPayload));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: false });
    expect(mocks.limit).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.recordInboundMessage).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        channel: "EMAIL",
        fromAddress: "customer@example.com",
        body: "Hi, how much does this cost?",
      }),
    );
  });

  it("surfaces webhook redelivery as a 200 duplicate, not an error", async () => {
    mocks.recordInboundMessage.mockResolvedValueOnce({
      thread: { id: "t1" },
      message: { id: "m1" },
      duplicate: true,
    });
    const response = await POST(request(validPayload));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });
  });

  it("returns 409 without leaking details on a cross-organization externalId collision", async () => {
    mocks.recordInboundMessage.mockRejectedValueOnce(
      new mocks.DuplicateInboundMessageError("collision"),
    );
    const response = await POST(request(validPayload));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "conflict" } });
  });
});
