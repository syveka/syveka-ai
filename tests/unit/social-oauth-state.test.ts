import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalStateSecret = process.env.META_OAUTH_STATE_SECRET;
const originalQstashKey = process.env.QSTASH_CURRENT_SIGNING_KEY;

describe("Social OAuth state (Meta callback CSRF binding)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.META_OAUTH_STATE_SECRET = "a-test-secret-that-is-long-enough";
  });

  afterEach(() => {
    process.env.META_OAUTH_STATE_SECRET = originalStateSecret;
    process.env.QSTASH_CURRENT_SIGNING_KEY = originalQstashKey;
  });

  it("round-trips org/user/platform through build and verify", async () => {
    const { buildSocialOAuthState, verifySocialOAuthState } =
      await import("@/server/social/oauth-state");
    const state = buildSocialOAuthState("org-1", "user-1", "INSTAGRAM");
    const result = verifySocialOAuthState(state);
    expect(result).toEqual({ orgId: "org-1", userId: "user-1", platform: "INSTAGRAM" });
  });

  it("rejects a tampered state signature", async () => {
    const { buildSocialOAuthState, verifySocialOAuthState, SocialOAuthStateError } =
      await import("@/server/social/oauth-state");
    const state = buildSocialOAuthState("org-1", "user-1", "FACEBOOK");
    const [encoded] = state.split(".");
    const tampered = `${encoded}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead`;
    expect(() => verifySocialOAuthState(tampered)).toThrow(SocialOAuthStateError);
  });

  it("rejects an expired state (older than 10 minutes)", async () => {
    vi.useFakeTimers();
    const { buildSocialOAuthState, verifySocialOAuthState, SocialOAuthStateError } =
      await import("@/server/social/oauth-state");
    const state = buildSocialOAuthState("org-1", "user-1", "INSTAGRAM");
    vi.advanceTimersByTime(11 * 60_000);
    expect(() => verifySocialOAuthState(state)).toThrow(SocialOAuthStateError);
    vi.useRealTimers();
  });

  it("falls back to QSTASH_CURRENT_SIGNING_KEY when no dedicated secret is set", async () => {
    delete process.env.META_OAUTH_STATE_SECRET;
    process.env.QSTASH_CURRENT_SIGNING_KEY = "qstash-fallback-secret";
    const { buildSocialOAuthState, verifySocialOAuthState } =
      await import("@/server/social/oauth-state");
    const state = buildSocialOAuthState("org-2", "user-2", "FACEBOOK");
    expect(verifySocialOAuthState(state).orgId).toBe("org-2");
  });

  it("fails closed when neither secret is configured", async () => {
    delete process.env.META_OAUTH_STATE_SECRET;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const { buildSocialOAuthState, SocialOAuthStateError } =
      await import("@/server/social/oauth-state");
    expect(() => buildSocialOAuthState("org-1", "user-1", "INSTAGRAM")).toThrow(
      SocialOAuthStateError,
    );
  });
});
