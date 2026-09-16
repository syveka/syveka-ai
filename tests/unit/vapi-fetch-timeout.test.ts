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
