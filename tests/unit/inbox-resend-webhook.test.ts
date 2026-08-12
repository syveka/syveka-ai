import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ResendInboundModule from "@/server/channels/email/resend-inbound";

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
    resolveOrgIdByMailboxAddress: vi.fn(async (): Promise<string | null> => null),
    verifyResendWebhookSignature: vi.fn(async () => true),
    fetchReceivedEmailContent: vi.fn(async () => ({ text: "Hi there", html: null })),
    limit: vi.fn(async () => ({
      success: true,
      reset: Date.now() + 60_000,
      limit: 60,
      remaining: 59,
    })),
    getResendEnv: vi.fn(() => ({ RESEND_API_KEY: "re_test", EMAIL_FROM: "Acme <a@acme.test>" })),
    DuplicateInboundMessageError,
  };
});

vi.mock("@/server/services/inbox", () => ({
  recordInboundMessage: mocks.recordInboundMessage,
  DuplicateInboundMessageError: mocks.DuplicateInboundMessageError,
}));
vi.mock("@/server/services/inbox-mailbox", () => ({
  resolveOrgIdByMailboxAddress: mocks.resolveOrgIdByMailboxAddress,
}));
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { inboxEmailWebhook: { limit: mocks.limit } },
}));
vi.mock("@/env", () => ({ getResendEnv: mocks.getResendEnv }));
vi.mock("@/server/channels/email/resend-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof ResendInboundModule>();
  return {
    ...actual,
    verifyResendWebhookSignature: mocks.verifyResendWebhookSignature,
    fetchReceivedEmailContent: mocks.fetchReceivedEmailContent,
  };
});

import { POST } from "@/app/api/v1/webhooks/inbox-email/resend/route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const validEvent = {
  type: "email.received",
  data: {
    email_id: "email_123",
    from: "customer@example.com",
    to: ["acme-oy@inbox.syveka.ai"],
    subject: "Question",
  },
};

function request(body: unknown, includeHeaders = true) {
  return new Request("http://localhost/api/v1/webhooks/inbox-email/resend", {
    method: "POST",
    headers: includeHeaders
      ? { "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,sig" }
      : {},
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/webhooks/inbox-email/resend", () => {
  const originalSecret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = "whsec_test";
    mocks.verifyResendWebhookSignature.mockResolvedValue(true);
    mocks.resolveOrgIdByMailboxAddress.mockResolvedValue(ORG_ID);
    mocks.fetchReceivedEmailContent.mockResolvedValue({ text: "Hi there", html: null });
  });

  afterAll(() => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = originalSecret;
  });

  it("fails closed when RESEND_INBOUND_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    const response = await POST(request(validEvent));
    expect(response.status).toBe(503);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("passes the presented svix headers through to signature verification", async () => {
    await POST(request(validEvent, true));
    expect(mocks.verifyResendWebhookSignature).toHaveBeenCalledWith(
      expect.any(String),
      { "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,sig" },
      "whsec_test",
    );
  });

  it("rejects a request with an invalid signature", async () => {
    mocks.verifyResendWebhookSignature.mockResolvedValueOnce(false);
    const response = await POST(request(validEvent));
    expect(response.status).toBe(401);
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("acknowledges (without acting) an event type other than email.received", async () => {
    const response = await POST(request({ type: "email.delivered", data: {} }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, skipped: true });
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("fails closed with a generic 401 when none of the event's recipients match a registered mailbox", async () => {
    mocks.resolveOrgIdByMailboxAddress.mockResolvedValueOnce(null);
    const response = await POST(request(validEvent));
    expect(response.status).toBe(401);
    expect(mocks.fetchReceivedEmailContent).not.toHaveBeenCalled();
    expect(mocks.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("resolves the org from the recipient address, fetches the full body, and records the canonical message", async () => {
    const response = await POST(request(validEvent));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: false });

    expect(mocks.resolveOrgIdByMailboxAddress).toHaveBeenCalledWith(
      "acme-oy@inbox.syveka.ai",
      "EMAIL",
    );
    expect(mocks.fetchReceivedEmailContent).toHaveBeenCalledWith("email_123", "re_test");
    expect(mocks.recordInboundMessage).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        channel: "EMAIL",
        fromAddress: "customer@example.com",
        toAddress: "acme-oy@inbox.syveka.ai",
        subject: "Question",
        body: "Hi there",
        externalId: "email_123",
      }),
    );
  });

  it("tries each recipient address in the event's `to` array until one resolves", async () => {
    mocks.resolveOrgIdByMailboxAddress.mockResolvedValueOnce(null).mockResolvedValueOnce(ORG_ID);
    const response = await POST(
      request({
        ...validEvent,
        data: { ...validEvent.data, to: ["nobody@elsewhere.example", "acme-oy@inbox.syveka.ai"] },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.resolveOrgIdByMailboxAddress).toHaveBeenCalledTimes(2);
  });

  it("rate-limits per resolved organization before fetching content", async () => {
    mocks.limit.mockResolvedValueOnce({
      success: false,
      reset: Date.now(),
      limit: 60,
      remaining: 0,
    });
    const response = await POST(request(validEvent));
    expect(response.status).toBe(429);
    expect(mocks.fetchReceivedEmailContent).not.toHaveBeenCalled();
  });

  it("surfaces webhook redelivery as a 200 duplicate", async () => {
    mocks.recordInboundMessage.mockResolvedValueOnce({
      thread: { id: "t1" },
      message: { id: "m1" },
      duplicate: true,
    });
    const response = await POST(request(validEvent));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });
  });

  it("returns 409 without leaking details on a cross-organization externalId collision", async () => {
    mocks.recordInboundMessage.mockRejectedValueOnce(
      new mocks.DuplicateInboundMessageError("collision"),
    );
    const response = await POST(request(validEvent));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "conflict" } });
  });
});
