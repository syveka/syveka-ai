import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFalKey = process.env.FAL_API_KEY;
const originalPin = process.env.CREATOR_MEDIA_PROVIDER;
const originalNodeEnv = process.env.NODE_ENV;

describe("Creator Studio media provider routing", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.FAL_API_KEY;
    delete process.env.CREATOR_MEDIA_PROVIDER;
  });

  afterEach(() => {
    process.env.FAL_API_KEY = originalFalKey;
    process.env.CREATOR_MEDIA_PROVIDER = originalPin;
    vi.stubEnv("NODE_ENV", originalNodeEnv ?? "test");
  });

  it("routes to the mock provider when FAL_API_KEY is unset", async () => {
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

  it("fails closed in production when FAL_API_KEY is unset, instead of silently serving mock media", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(() => getRoutedCreatorMediaProvider()).toThrow(/cannot silently fall back/i);
  });

  it("still honors an explicit CREATOR_MEDIA_PROVIDER=mock pin in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CREATOR_MEDIA_PROVIDER = "mock";
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("mock");
  });

  it("routes to fal.ai in production once FAL_API_KEY is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.FAL_API_KEY = "test-key";
    const { getRoutedCreatorMediaProvider } = await import("@/server/ai/creator/router");
    expect(getRoutedCreatorMediaProvider().name).toBe("fal");
  });
});
