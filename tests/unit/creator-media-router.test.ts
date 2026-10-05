import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = {
  falKey: process.env.FAL_API_KEY,
  pin: process.env.CREATOR_MEDIA_PROVIDER,
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("Creator Studio media provider routing", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.FAL_API_KEY;
    delete process.env.CREATOR_MEDIA_PROVIDER;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restore("FAL_API_KEY", ORIGINAL.falKey);
    restore("CREATOR_MEDIA_PROVIDER", ORIGINAL.pin);
  });

  it("routes to the mock provider outside production when FAL_API_KEY is unset", async () => {
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("mock");
  });

  it("routes to fal.ai automatically once FAL_API_KEY is configured", async () => {
    process.env.FAL_API_KEY = "test-key";
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("fal");
  });

  it("an explicit CREATOR_MEDIA_PROVIDER pin overrides config-presence auto-detection", async () => {
    process.env.FAL_API_KEY = "test-key";
    process.env.CREATOR_MEDIA_PROVIDER = "mock";
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("mock");
  });

  it("re-resolves when the underlying configuration changes between calls", async () => {
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("mock");
    process.env.FAL_API_KEY = "test-key";
    expect(getRoutedCreatorMediaProvider().name).toBe("fal");
  });

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("fails closed instead of silently serving mock media when FAL_API_KEY is unset", async () => {
      const { getRoutedCreatorMediaProvider, CreatorMediaProviderUnavailableError } =
        await import("@/server/ai/creator/router");
      expect(() => getRoutedCreatorMediaProvider()).toThrow(CreatorMediaProviderUnavailableError);
    });

    it("uses fal.ai when FAL_API_KEY is configured", async () => {
      process.env.FAL_API_KEY = "test-key";
      const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
      expect(getRoutedCreatorMediaProvider().name).toBe("fal");
    });

    it("refuses a CREATOR_MEDIA_PROVIDER=mock pin, with or without a FAL key", async () => {
      process.env.CREATOR_MEDIA_PROVIDER = "mock";
      const { getRoutedCreatorMediaProvider, CreatorMediaProviderUnavailableError } =
        await import("@/server/ai/creator/router");
      expect(() => getRoutedCreatorMediaProvider()).toThrow(CreatorMediaProviderUnavailableError);
      process.env.FAL_API_KEY = "test-key";
      expect(() => getRoutedCreatorMediaProvider()).toThrow(CreatorMediaProviderUnavailableError);
    });

    it("fails closed again once a configured key is removed", async () => {
      process.env.FAL_API_KEY = "test-key";
      const { getRoutedCreatorMediaProvider, CreatorMediaProviderUnavailableError } =
        await import("@/server/ai/creator/router");
      expect(getRoutedCreatorMediaProvider().name).toBe("fal");
      delete process.env.FAL_API_KEY;
      expect(() => getRoutedCreatorMediaProvider()).toThrow(CreatorMediaProviderUnavailableError);
    });
  });

  it("fails closed for a CREATOR_MEDIA_PROVIDER=fal pin without a key, in any environment", async () => {
    process.env.CREATOR_MEDIA_PROVIDER = "fal";
    const { getRoutedCreatorMediaProvider, CreatorMediaProviderUnavailableError } =
      await import("@/server/ai/creator/router");
    expect(() => getRoutedCreatorMediaProvider()).toThrow(CreatorMediaProviderUnavailableError);
  });

  it("gives customers a message that names no configuration", async () => {
    const { CreatorMediaProviderUnavailableError } = await import("@/server/ai/creator/router");
    const error = new CreatorMediaProviderUnavailableError();
    expect(error.code).toBe("media_provider_not_configured");
    expect(error.message).not.toMatch(/FAL|CREATOR_MEDIA_PROVIDER|key|env/i);
  });
});
