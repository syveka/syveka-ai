import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for vapiFetch()'s request timeout (src/server/integrations/vapi.ts)
 * -- previously a hung Vapi request blocked the caller indefinitely (bounded
 * only by the platform's own function timeout), with no distinguishable
 * error. Exercised through buyPhoneNumber(), the simplest exported wrapper
 * around vapiFetch -- vapiFetch itself is not exported.
 */
vi.mock("@/env", () => ({
  getVapiEnv: () => ({
    VAPI_API_KEY: "test",
    VAPI_WEBHOOK_SECRET: "a".repeat(32),
    VAPI_WEBHOOK_CREDENTIAL_ID: "cred_test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

import { buyPhoneNumber, VAPI_FETCH_TIMEOUT_MS } from "@/server/integrations/vapi";

const originalFetch = global.fetch;

describe("vapiFetch — request timeout", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("converts an AbortSignal timeout into a clear, descriptive error rather than hanging", async () => {
    const timeoutError = new DOMException("The operation was aborted.", "TimeoutError");
    global.fetch = vi.fn().mockRejectedValue(timeoutError);

    await expect(buyPhoneNumber("vapi-assistant-1")).rejects.toThrow(
      `timed out after ${VAPI_FETCH_TIMEOUT_MS}ms`,
    );
  });

  it("passes an AbortSignal with the documented timeout to every request", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "num-1", number: "+358401234567" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await buyPhoneNumber("vapi-assistant-1");

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not misclassify a genuine (non-timeout) network error as a timeout", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(buyPhoneNumber("vapi-assistant-1")).rejects.toThrow("fetch failed");
  });

  it("still surfaces a normal non-2xx response as before (timeout handling doesn't swallow it)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "This area code is currently not available." }), {
        status: 400,
      }),
    );

    await expect(buyPhoneNumber("vapi-assistant-1")).rejects.toThrow("400");
  });
});

/**
 * Vapi doesn't document whether PATCH /assistant/{id} merges or replaces a nested
 * object, so an update must not depend on it: artifactPlan options set in the dashboard
 * are read and sent back unchanged, with only recordingEnabled set by us.
 */
describe("upsertVapiAssistant — the assistant's other artifactPlan options are kept", () => {
  const cfg = {
    name: "Reception",
    firstMessage: "Hei!",
    systemPrompt: "You are the front desk.",
    language: "fi" as const,
    voiceProvider: "azure",
    voiceId: null,
    serverUrl: "https://app.example.com/api/v1/voice/webhook",
    serverCredentialId: "cred_test",
    tools: [],
    transferNumber: null,
    maxDurationSeconds: 900,
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("updating sends back the dashboard's artifactPlan options with recording on", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        json({
          id: "va-1",
          artifactPlan: {
            recordingFormat: "mp3",
            recordingPath: "/synthetic",
            recordingEnabled: false,
          },
        }),
      )
      .mockResolvedValueOnce(json({ id: "va-1" }));

    await upsertVapiAssistant(cfg, "va-1");

    const [getUrl, getInit] = fetchMock.mock.calls[0]!;
    expect(String(getUrl)).toMatch(/\/assistant\/va-1$/);
    expect(getInit?.method ?? "GET").toBe("GET");
    const [, patchInit] = fetchMock.mock.calls[1]!;
    expect(patchInit?.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit?.body)).artifactPlan).toEqual({
      recordingFormat: "mp3",
      recordingPath: "/synthetic",
      recordingEnabled: true,
    });
  });

  it("an assistant without an artifactPlan gets only recordingEnabled", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(json({ id: "va-2" }))
      .mockResolvedValueOnce(json({ id: "va-2" }));

    await upsertVapiAssistant(cfg, "va-2");

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).artifactPlan).toEqual({
      recordingEnabled: true,
    });
  });

  it("if the current assistant can't be read, nothing is updated", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    await expect(upsertVapiAssistant(cfg, "va-3")).rejects.toThrow("503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creating a new assistant sends only the documented recording field (no read)", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(json({ id: "va-new" }));

    await upsertVapiAssistant(cfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).artifactPlan).toEqual({
      recordingEnabled: true,
    });
  });
});
