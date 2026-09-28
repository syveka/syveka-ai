import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * limitAiTranscription with the Upstash limiters mocked. Upstash resolves
 * `success: true, reason: "timeout"` when Redis is slow; for this paid
 * endpoint that must not count as allowed.
 */
const limits = vi.hoisted(() => ({
  user: vi.fn(),
  org: vi.fn(),
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow() {
      return {};
    }
    constructor(private readonly config: { prefix: string }) {}
    limit(id: string) {
      return this.config.prefix === "rl:ai:transcribe:user" ? limits.user(id) : limits.org(id);
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({ Redis: class {} }));

import { limitAiTranscription } from "@/server/integrations/redis";

const ok = { success: true, limit: 20, remaining: 19, reset: 1 };

beforeEach(() => {
  limits.user.mockReset().mockResolvedValue(ok);
  limits.org.mockReset().mockResolvedValue(ok);
});

describe("limitAiTranscription", () => {
  it("keys the user limit by org and user, the org limit by org", async () => {
    expect((await limitAiTranscription("org-1", "user-1")).success).toBe(true);
    expect(limits.user).toHaveBeenCalledWith("org-1:user-1");
    expect(limits.org).toHaveBeenCalledWith("org-1");
  });

  it.each(["user", "org"] as const)("fails closed when the %s limiter timed out", async (which) => {
    limits[which].mockResolvedValue({ ...ok, limit: 0, remaining: 0, reason: "timeout" });
    const result = await limitAiTranscription("org-1", "user-1");
    expect(result).toMatchObject({ success: false, unavailable: true });
  });

  it("reports which scope is exhausted", async () => {
    limits.org.mockResolvedValue({ ...ok, success: false, remaining: 0 });
    expect(await limitAiTranscription("org-1", "user-1")).toMatchObject({
      success: false,
      scope: "organization",
    });
  });
});
