import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which Meta failures may have published. Only the request that publishes
 * (Instagram media_publish, Facebook photos/videos) can leave the outcome
 * unknown: no response, a timeout or a 5xx there is PublishOutcomeUnknownError
 * (never retried automatically). A definite Graph error (4xx), and any failure
 * before that request, published nothing and stays an ordinary MetaApiError.
 * Every request carries a timeout, so a hung request can't outlive the job.
 */

const originalAppId = process.env.META_APP_ID;
const originalAppSecret = process.env.META_APP_SECRET;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const graphError = (status: number) =>
  json({ error: { message: "Invalid parameter", code: 100 } }, status);
const noResponse = () => Promise.reject(new TypeError("fetch failed"));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env.META_APP_ID = originalAppId;
  process.env.META_APP_SECRET = originalAppSecret;
  vi.unstubAllGlobals();
});

async function client() {
  const meta = await import("@/server/integrations/meta/client");
  const { PublishOutcomeUnknownError } = await import("@/server/social/types");
  return { ...meta, PublishOutcomeUnknownError };
}

/** Container created and ready; the final media_publish answers with `last`. */
function instagramUpTo(last: () => Response | Promise<Response>) {
  fetchMock
    .mockResolvedValueOnce(json({ id: "container-1" }))
    .mockResolvedValueOnce(json({ status_code: "FINISHED" }))
    .mockImplementationOnce(last);
}

const publishInstagram = (c: Awaited<ReturnType<typeof client>>) =>
  c.publishInstagramMedia("ig-1", "page-token", {
    imageUrl: "https://storage.test/x.png",
    caption: "hi",
    isVideo: false,
  });

describe("Instagram", () => {
  it.each([
    ["no response", noResponse],
    ["a 500", () => json({ error: { message: "Internal" } }, 500)],
    ["a 503 without a body", () => new Response("", { status: 503 })],
    ["success without an id", () => json({})],
  ])("media_publish with %s: outcome unknown", async (_label, last) => {
    const c = await client();
    instagramUpTo(last);
    await expect(publishInstagram(c)).rejects.toBeInstanceOf(c.PublishOutcomeUnknownError);
  });

  it.each([
    ["a 400", () => graphError(400)],
    ["a 429", () => graphError(429)],
  ])("media_publish with %s: a definite failure, nothing published", async (_l, last) => {
    const c = await client();
    instagramUpTo(last);
    const error = await publishInstagram(c).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(c.MetaApiError);
    expect(error).not.toBeInstanceOf(c.PublishOutcomeUnknownError);
  });

  it("a failure creating the container published nothing", async () => {
    const c = await client();
    fetchMock.mockImplementationOnce(noResponse);
    const error = await publishInstagram(c).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(c.MetaApiError);
    expect(error).not.toBeInstanceOf(c.PublishOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failure while waiting for the container published nothing", async () => {
    const c = await client();
    fetchMock
      .mockResolvedValueOnce(json({ id: "container-1" }))
      .mockImplementationOnce(() => json({ error: { message: "down" } }, 500));
    const error = await publishInstagram(c).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(c.PublishOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // media_publish never called
  });

  it("a successful publish is unchanged", async () => {
    const c = await client();
    instagramUpTo(() => json({ id: "ig-media-1" }));
    await expect(publishInstagram(c)).resolves.toEqual({ postId: "ig-media-1" });
  });
});

describe("Facebook", () => {
  it("photo publish without a response: outcome unknown", async () => {
    const c = await client();
    fetchMock.mockImplementationOnce(noResponse);
    await expect(
      c.publishFacebookPhoto("page-1", "page-token", { imageUrl: "https://x/y.png", caption: "" }),
    ).rejects.toBeInstanceOf(c.PublishOutcomeUnknownError);
  });

  it("video publish with a 502: outcome unknown", async () => {
    const c = await client();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    await expect(
      c.publishFacebookVideo("page-1", "page-token", { videoUrl: "https://x/y.mp4", caption: "" }),
    ).rejects.toBeInstanceOf(c.PublishOutcomeUnknownError);
  });

  it("photo publish rejected with a 400: a definite failure", async () => {
    const c = await client();
    fetchMock.mockResolvedValueOnce(graphError(400));
    const error = await c
      .publishFacebookPhoto("page-1", "page-token", { imageUrl: "https://x/y.png", caption: "" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(c.MetaApiError);
    expect(error).not.toBeInstanceOf(c.PublishOutcomeUnknownError);
  });
});

describe("request timeouts", () => {
  it("every Graph request carries a timeout signal", async () => {
    const c = await client();
    instagramUpTo(() => json({ id: "ig-media-1" }));
    await publishInstagram(c);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("a request that doesn't answer in time fails instead of holding the job", async () => {
    const c = await client();
    const expired = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(expired);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) =>
      init.signal!.aborted ? Promise.reject(init.signal!.reason) : Promise.resolve(json({})),
    );
    try {
      const error = await publishInstagram(c).catch((e: unknown) => e);
      expect(timeout).toHaveBeenCalledWith(c.GRAPH_REQUEST_TIMEOUT_MS);
      expect(error).toBeInstanceOf(c.MetaApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
});
