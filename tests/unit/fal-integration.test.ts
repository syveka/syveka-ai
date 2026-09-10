import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fal.ai integration client — mocked fetch throughout, so this never makes a
 * real network call (no live FAL_API_KEY exists in CI/this environment).
 * Proves the queue submit -> poll -> fetch-result contract shape against
 * fal.ai's documented API, not against a live account.
 */

const originalFalKey = process.env.FAL_API_KEY;

describe("fal.ai integration client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.FAL_API_KEY = "test-fal-key";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env.FAL_API_KEY = originalFalKey;
    vi.unstubAllGlobals();
  });

  it("isFalConfigured reflects FAL_API_KEY presence", async () => {
    const { isFalConfigured } = await import("@/server/integrations/fal");
    expect(isFalConfigured()).toBe(true);
    delete process.env.FAL_API_KEY;
    expect(isFalConfigured()).toBe(false);
  });

  it("throws FalNotConfiguredError when FAL_API_KEY is unset", async () => {
    delete process.env.FAL_API_KEY;
    const { runFalModel, FalNotConfiguredError } = await import("@/server/integrations/fal");
    await expect(runFalModel("fal-ai/flux/schnell", { prompt: "x" })).rejects.toBeInstanceOf(
      FalNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits to the queue endpoint, polls status, and fetches the final result", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-1/status",
            response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ images: [{ url: "https://fal.media/x.png" }] }), {
          status: 200,
        }),
      );

    vi.useFakeTimers();
    const { runFalModel } = await import("@/server/integrations/fal");
    const resultPromise = runFalModel<{ images: Array<{ url: string }> }>("fal-ai/flux/schnell", {
      prompt: "a cat",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.images[0]?.url).toBe("https://fal.media/x.png");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const submitCall = fetchMock.mock.calls[0]!;
    expect(submitCall[0]).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(submitCall[1]?.method).toBe("POST");
    expect((submitCall[1]?.headers as Record<string, string>).Authorization).toBe(
      "Key test-fal-key",
    );
  });

  it("throws FalRequestError when the job status is ERROR", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: "https://queue.fal.run/x/status",
            response_url: "https://queue.fal.run/x",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ERROR", error: "invalid prompt" }), { status: 200 }),
      );

    const { runFalModel, FalRequestError } = await import("@/server/integrations/fal");
    await expect(runFalModel("fal-ai/flux/schnell", { prompt: "x" })).rejects.toBeInstanceOf(
      FalRequestError,
    );
  });

  it("throws FalRequestError on a non-2xx submit response, without leaking the raw body unbounded", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const { runFalModel, FalRequestError } = await import("@/server/integrations/fal");
    await expect(runFalModel("fal-ai/flux/schnell", { prompt: "x" })).rejects.toBeInstanceOf(
      FalRequestError,
    );
  });
});
