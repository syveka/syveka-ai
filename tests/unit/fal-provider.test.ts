import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FalCreatorMediaProvider — fetch and Supabase Storage both mocked, so this
 * never makes a real network/storage call. Proves the request/response
 * mapping (reference-asset signing, fal.ai queue flow, output persistence)
 * against fal.ai's documented API shape, not against a live account.
 */

const originalFalKey = process.env.FAL_API_KEY;

const createSignedUrlMock = vi.fn(async () => ({
  data: { signedUrl: "https://storage.example/signed/ref.png" },
  error: null,
}));
const uploadMock = vi.fn(async () => ({ error: null }));
const storageFromMock = vi.fn(() => ({
  createSignedUrl: createSignedUrlMock,
  upload: uploadMock,
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ storage: { from: storageFromMock } }),
}));

describe("FalCreatorMediaProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.FAL_API_KEY = "test-fal-key";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env.FAL_API_KEY = originalFalKey;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function queueResponses(finalBody: unknown) {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(finalBody), { status: 200 }))
      // download of the fal.ai output URL, for persistFalOutput()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  }

  it("generateCharacterImage submits a text-to-image job and persists the result to storage", async () => {
    queueResponses({ images: [{ url: "https://fal.media/out.png", content_type: "image/png" }] });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateCharacterImage({
      prompt: "a business portrait",
      referenceAssets: [],
      aspectRatio: "1:1",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.mimeType).toBe("image/png");
    expect(result.outputStoragePath).toMatch(/^fal\/.+\.png$/);
    expect(result.providerRequestId).toBe("https://fal.media/out.png");
    // The mocked download body is exactly 3 bytes (new Uint8Array([1, 2, 3])
    // in queueResponses) — sizeBytes must reflect the real uploaded payload,
    // not a hardcoded placeholder.
    expect(result.sizeBytes).toBe(3);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(submitBody.prompt).toBe("a business portrait");
  });

  it("generateImageFromCharacter signs an UPLOAD asset from the reference-assets bucket", async () => {
    queueResponses({ images: [{ url: "https://fal.media/out2.png", content_type: "image/png" }] });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateImageFromCharacter({
      prompt: "same character, new outfit",
      referenceAssets: [{ storagePath: "org-a/profile/ref.png", source: "UPLOAD" }],
      aspectRatio: "4:5",
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(storageFromMock).toHaveBeenCalledWith("creator-reference-assets");
    expect(createSignedUrlMock).toHaveBeenCalledWith("org-a/profile/ref.png", 600);
    const submitUrl = fetchMock.mock.calls[0]![0];
    expect(submitUrl).toBe("https://queue.fal.run/fal-ai/flux/dev/image-to-image");
    const submitBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(submitBody.image_url).toBe("https://storage.example/signed/ref.png");
  });

  it("generateImageFromCharacter signs a GENERATED asset from the generated-media bucket", async () => {
    queueResponses({ images: [{ url: "https://fal.media/out3.png", content_type: "image/png" }] });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateImageFromCharacter({
      prompt: "same character, new outfit",
      referenceAssets: [{ storagePath: "org-a/fal/out.png", source: "GENERATED" }],
      aspectRatio: "4:5",
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(storageFromMock).toHaveBeenCalledWith("creator-generated-media");
    expect(createSignedUrlMock).toHaveBeenCalledWith("org-a/fal/out.png", 600);
  });

  it("generateVideoFromImage signs an UPLOAD source asset from the reference-assets bucket", async () => {
    queueResponses({ video: { url: "https://fal.media/out.mp4", content_type: "video/mp4" } });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateVideoFromImage({
      sourceAsset: { storagePath: "org-a/profile/ref.png", source: "UPLOAD" },
      aspectRatio: "9:16",
      durationSeconds: 10,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(storageFromMock).toHaveBeenCalledWith("creator-reference-assets");
    expect(result.durationSeconds).toBe(10);
    expect(result.mimeType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(3);
    const submitUrl = fetchMock.mock.calls[0]![0];
    expect(submitUrl).toContain("kling-video");
  });

  it("generateVideoFromImage signs a GENERATED source asset from the generated-media bucket", async () => {
    queueResponses({ video: { url: "https://fal.media/out2.mp4", content_type: "video/mp4" } });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateVideoFromImage({
      sourceAsset: { storagePath: "org-a/generated/img.png", source: "GENERATED" },
      aspectRatio: "9:16",
      durationSeconds: 5,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(storageFromMock).toHaveBeenCalledWith("creator-generated-media");
    expect(createSignedUrlMock).toHaveBeenCalledWith("org-a/generated/img.png", 600);
  });

  it("falls back to the Kling v2.1 Standard model when FAL_IMAGE_TO_VIDEO_MODEL is unset", async () => {
    delete process.env.FAL_IMAGE_TO_VIDEO_MODEL;
    queueResponses({ video: { url: "https://fal.media/out3.mp4", content_type: "video/mp4" } });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateVideoFromImage({
      sourceAsset: { storagePath: "org-a/profile/ref.png", source: "UPLOAD" },
      aspectRatio: "1:1",
      durationSeconds: 5,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    const submitUrl = fetchMock.mock.calls[0]![0];
    // v1.5 Standard no longer exists in fal.ai's catalog (confirmed live) —
    // the fallback must be v2.1 Standard, proven live end-to-end.
    expect(submitUrl).toBe("https://queue.fal.run/fal-ai/kling-video/v2.1/standard/image-to-video");
  });

  it("prefers FAL_IMAGE_TO_VIDEO_MODEL over the fallback when set", async () => {
    process.env.FAL_IMAGE_TO_VIDEO_MODEL = "fal-ai/kling-video/v9.9/custom/image-to-video";
    queueResponses({ video: { url: "https://fal.media/out4.mp4", content_type: "video/mp4" } });

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateVideoFromImage({
      sourceAsset: { storagePath: "org-a/profile/ref.png", source: "UPLOAD" },
      aspectRatio: "1:1",
      durationSeconds: 5,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    const submitUrl = fetchMock.mock.calls[0]![0];
    expect(submitUrl).toBe("https://queue.fal.run/fal-ai/kling-video/v9.9/custom/image-to-video");
    delete process.env.FAL_IMAGE_TO_VIDEO_MODEL;
  });

  it("propagates a fal.ai job error rather than silently returning a placeholder", async () => {
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
        new Response(JSON.stringify({ status: "ERROR", error: "NSFW content detected" }), {
          status: 200,
        }),
      );

    const { FalCreatorMediaProvider } = await import("@/server/ai/creator/fal-provider");
    const provider = new FalCreatorMediaProvider();
    const resultPromise = provider.generateCharacterImage({
      prompt: "x",
      referenceAssets: [],
      aspectRatio: "1:1",
    });
    const assertion = expect(resultPromise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
