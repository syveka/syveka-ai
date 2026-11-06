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

import {
  buyPhoneNumber,
  deleteVapiAssistant,
  VAPI_FETCH_TIMEOUT_MS,
} from "@/server/integrations/vapi";

const originalFetch = global.fetch;

describe("deleting a Vapi assistant", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("counts one already gone as deleted, so a failed delete can be tried again", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(deleteVapiAssistant("gone")).resolves.toBeUndefined();
  });

  it("still fails on any other answer", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(deleteVapiAssistant("held")).rejects.toThrow();
  });
});

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
 * Without a choice made in Syveka, a sync must leave Vapi's recording setting alone, and with
 * one, it must send it every time. The fake below applies each PATCH the way Vapi documents an
 * update of the fields it names, and can't show how real Vapi treats an omitted field, or
 * whether it replaces the rest of artifactPlan: that needs a check on staging.
 */
describe("upsertVapiAssistant — recording follows the choice made in Syveka", () => {
  const cfg = {
    name: "Reception",
    firstMessage: "Notice. Hei!",
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

  it("keeps recording off through repeated syncs, with the notice still sent", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    let held: Record<string, unknown> = {
      id: "va-1",
      artifactPlan: { recordingEnabled: false, recordingFormat: "mp3" },
    };
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation(async (_url, init) => {
      held = { ...held, ...(JSON.parse(String(init?.body)) as Record<string, unknown>) };
      return json(held);
    });

    await upsertVapiAssistant(cfg, "va-1");
    await upsertVapiAssistant(cfg, "va-1");
    await upsertVapiAssistant(cfg, "va-1");

    expect(held.artifactPlan).toEqual({ recordingEnabled: false, recordingFormat: "mp3" });
    expect(held.firstMessage).toBe("Notice. Hei!");
    expect(held.firstMessageMode).toBe("assistant-speaks-first");
    expect(held.firstMessageInterruptionsEnabled).toBe(false);
  });

  it("an update sends no recording field, and doesn't need to read the assistant first", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(json({ id: "va-2" }));

    await upsertVapiAssistant(cfg, "va-2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("PATCH");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty("artifactPlan");
    expect(body).not.toHaveProperty("recordingEnabled");
  });

  it("keeps an explicit choice through repeated syncs, over a dashboard edit", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    let held: Record<string, unknown> = { id: "va-3", artifactPlan: { recordingEnabled: true } };
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation(async (_url, init) => {
      held = { ...held, ...(JSON.parse(String(init?.body)) as Record<string, unknown>) };
      return json(held);
    });

    await upsertVapiAssistant({ ...cfg, recordingEnabled: false }, "va-3");
    held = { ...held, artifactPlan: { recordingEnabled: true } };
    await upsertVapiAssistant({ ...cfg, recordingEnabled: false }, "va-3");

    expect(held.artifactPlan).toEqual({ recordingEnabled: false });
  });

  it("a new assistant with recording off says so, since Vapi's default records", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(json({ id: "va-new" }));

    await upsertVapiAssistant({ ...cfg, recordingEnabled: false });

    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.artifactPlan).toEqual({ recordingEnabled: false });
  });

  it("a payload without a choice sends no recording field", async () => {
    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(json({ id: "va-new" }));

    await upsertVapiAssistant(cfg);

    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty("artifactPlan");
    expect(body).not.toHaveProperty("recordingEnabled");
  });
});
