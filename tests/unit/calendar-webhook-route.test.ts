import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleProviderWebhookMock } = vi.hoisted(() => ({
  handleProviderWebhookMock: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock("@/server/services/calendar-sync", () => ({
  handleProviderWebhook: handleProviderWebhookMock,
}));

import { POST } from "@/app/api/v1/webhooks/calendar/[provider]/route";

function req(provider: string, init: RequestInit & { search?: string } = {}) {
  const { search, ...rest } = init;
  return {
    request: new Request(`http://localhost/api/v1/webhooks/calendar/${provider}${search ?? ""}`, {
      method: "POST",
      ...rest,
    }),
    params: Promise.resolve({ provider }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handleProviderWebhookMock.mockResolvedValue(true);
});

describe("Google webhook flow", () => {
  it("valid channel ID + channel token triggers exactly one sync", async () => {
    const { request, params } = req("google", {
      headers: { "x-goog-channel-id": "chan-1", "x-goog-channel-token": "secret-1" },
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(handleProviderWebhookMock).toHaveBeenCalledTimes(1);
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "GOOGLE",
      subscriptionId: "chan-1",
      presentedSecret: "secret-1",
    });
  });

  it("missing token is passed through as null (verification itself lives in the service)", async () => {
    const { request, params } = req("google", {
      headers: { "x-goog-channel-id": "chan-1" },
    });
    await POST(request, { params });
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "GOOGLE",
      subscriptionId: "chan-1",
      presentedSecret: null,
    });
  });

  it("no channel id at all triggers no lookup", async () => {
    const { request, params } = req("google", {});
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(handleProviderWebhookMock).not.toHaveBeenCalled();
  });

  it("preserves the same acknowledgement response whether verification succeeds or fails", async () => {
    handleProviderWebhookMock.mockResolvedValue(false); // unknown id or bad secret
    const { request, params } = req("google", {
      headers: { "x-goog-channel-id": "chan-1", "x-goog-channel-token": "wrong" },
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("Microsoft webhook flow", () => {
  it("preserves the validationToken handshake exactly, returning text/plain", async () => {
    const { request, params } = req("microsoft", { search: "?validationToken=abc123" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toBe("abc123");
    expect(handleProviderWebhookMock).not.toHaveBeenCalled();
  });

  it("valid clientState triggers sync", async () => {
    const { request, params } = req("microsoft", {
      body: JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: "secret-1" }] }),
    });
    await POST(request, { params });
    expect(handleProviderWebhookMock).toHaveBeenCalledTimes(1);
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "MICROSOFT",
      subscriptionId: "sub-1",
      presentedSecret: "secret-1",
    });
  });

  it("missing clientState is passed through as null", async () => {
    const { request, params } = req("microsoft", {
      body: JSON.stringify({ value: [{ subscriptionId: "sub-1" }] }),
    });
    await POST(request, { params });
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "MICROSOFT",
      subscriptionId: "sub-1",
      presentedSecret: null,
    });
  });

  it("a mixed multi-subscription batch verifies each item independently", async () => {
    const { request, params } = req("microsoft", {
      body: JSON.stringify({
        value: [
          { subscriptionId: "sub-1", clientState: "secret-1" },
          { subscriptionId: "sub-2", clientState: "secret-2" },
        ],
      }),
    });
    await POST(request, { params });
    expect(handleProviderWebhookMock).toHaveBeenCalledTimes(2);
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "MICROSOFT",
      subscriptionId: "sub-1",
      presentedSecret: "secret-1",
    });
    expect(handleProviderWebhookMock).toHaveBeenCalledWith({
      provider: "MICROSOFT",
      subscriptionId: "sub-2",
      presentedSecret: "secret-2",
    });
  });

  it("duplicate identical notification pairs trigger no duplicate sync", async () => {
    const { request, params } = req("microsoft", {
      body: JSON.stringify({
        value: [
          { subscriptionId: "sub-1", clientState: "secret-1" },
          { subscriptionId: "sub-1", clientState: "secret-1" },
        ],
      }),
    });
    await POST(request, { params });
    expect(handleProviderWebhookMock).toHaveBeenCalledTimes(1);
  });

  it("always acknowledges the batch with the same public response shape", async () => {
    handleProviderWebhookMock.mockResolvedValue(false);
    const { request, params } = req("microsoft", {
      body: JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: "wrong" }] }),
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("unknown provider", () => {
  it("rejects with 404 before any lookup", async () => {
    const { request, params } = req("aol");
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
    expect(handleProviderWebhookMock).not.toHaveBeenCalled();
  });
});
