import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * checkRateLimit and the AI limit helpers built on it, with the Upstash
 * limiters mocked. Upstash resolves `success: true, reason: "timeout"` when
 * Redis is slow and throws when Redis errors; reading a limiter throws when
 * Redis isn't configured. None of these may count as allowed.
 */
const m = vi.hoisted(() => ({
  limit: vi.fn(),
  envThrows: false,
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow() {
      return {};
    }
    constructor(private readonly config: { prefix: string }) {}
    limit(id: string) {
      return m.limit(this.config.prefix, id);
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@/env", () => ({
  getRedisEnv: () => {
    if (m.envThrows) throw new Error("Invalid Redis environment variables: UPSTASH_REDIS_REST_URL");
    return {
      UPSTASH_REDIS_REST_URL: "http://redis.test",
      UPSTASH_REDIS_REST_TOKEN: "token",
      AI_CHAT_USER_RATE_LIMIT: 30,
      AI_CHAT_ORG_RATE_LIMIT: 300,
      AI_CHAT_RATE_WINDOW_SECONDS: 60,
    };
  },
}));

import {
  checkRateLimit,
  limitAiChat,
  limitAiTranscription,
  limitAiVoiceTurn,
} from "@/server/integrations/redis";

const ok = { success: true, limit: 20, remaining: 19, reset: 1_000 };
const timeout = { success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" };
const SECRET_KEY = "203.0.113.7:org-secret:user-secret";

let logged: string[];

beforeEach(() => {
  m.envThrows = false;
  m.limit.mockReset().mockResolvedValue(ok);
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRateLimit", () => {
  it("allows a request within the limit", async () => {
    expect(await checkRateLimit("workflowTestRun", "org-1")).toEqual({
      ok: true,
      limit: 20,
      remaining: 19,
      reset: 1_000,
    });
    expect(m.limit).toHaveBeenCalledWith("rl:workflow-test-run:org", "org-1");
    expect(logged).toEqual([]);
  });

  it("reports a reached limit as limited", async () => {
    m.limit.mockResolvedValue({ ...ok, success: false, remaining: 0 });
    expect(await checkRateLimit("workflowTestRun", "org-1")).toEqual({
      ok: false,
      reason: "limited",
      limit: 20,
      remaining: 0,
      reset: 1_000,
    });
  });

  it.each(["cacheBlock", "denyList"])("keeps a %s refusal as limited", async (reason) => {
    m.limit.mockResolvedValue({ ...ok, success: false, remaining: 0, reason });
    expect(await checkRateLimit("businessDnaExtract", "org-1")).toMatchObject({
      ok: false,
      reason: "limited",
    });
  });

  it("treats a limiter timeout (which Upstash resolves as success) as unavailable", async () => {
    m.limit.mockResolvedValue(timeout);
    expect(await checkRateLimit("businessDnaExtract", "org-1")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { event: "rate_limit_unavailable", limiter: "businessDnaExtract", cause: "timeout" },
    ]);
  });

  it("treats a Redis error as unavailable instead of throwing", async () => {
    m.limit.mockRejectedValue(new Error("fetch failed"));
    expect(await checkRateLimit("businessDnaExtract", "org-1")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { event: "rate_limit_unavailable", limiter: "businessDnaExtract", cause: "error" },
    ]);
  });

  it("treats missing Redis configuration (the limiter getter throws) as unavailable", async () => {
    m.envThrows = true;
    expect(await checkRateLimit("workflowTestRun", "org-1")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(m.limit).not.toHaveBeenCalled();
  });

  it("never logs the limit key (it holds IP addresses and IDs)", async () => {
    m.limit.mockResolvedValueOnce(timeout).mockRejectedValueOnce(new Error(SECRET_KEY));
    await checkRateLimit("publicAssistant", SECRET_KEY);
    await checkRateLimit("publicAssistant", SECRET_KEY);
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).not.toContain("203.0.113.7");
      expect(line).not.toContain("secret");
    }
  });
});

describe("AI limit helpers fail closed", () => {
  const helpers = {
    limitAiChat,
    limitAiTranscription,
    limitAiVoiceTurn,
  };

  it.each(Object.keys(helpers) as Array<keyof typeof helpers>)(
    "%s reports a timeout as unavailable",
    async (name) => {
      m.limit.mockResolvedValue(timeout);
      expect(await helpers[name]("org-1", "user-1")).toMatchObject({
        success: false,
        unavailable: true,
      });
    },
  );

  it.each(Object.keys(helpers) as Array<keyof typeof helpers>)(
    "%s reports a Redis error as unavailable instead of throwing",
    async (name) => {
      m.limit.mockRejectedValue(new Error("fetch failed"));
      expect(await helpers[name]("org-1", "user-1")).toMatchObject({
        success: false,
        unavailable: true,
      });
    },
  );

  it.each(Object.keys(helpers) as Array<keyof typeof helpers>)(
    "%s reports missing Redis configuration as unavailable",
    async (name) => {
      m.envThrows = true;
      expect(await helpers[name]("org-1", "user-1")).toMatchObject({
        success: false,
        unavailable: true,
      });
    },
  );

  it("limitAiChat reports only the organization limit timing out as unavailable", async () => {
    m.limit.mockImplementation(async (prefix: string) => (prefix === "rl:ai:org" ? timeout : ok));
    expect(await limitAiChat("org-1", "user-1")).toMatchObject({
      success: false,
      unavailable: true,
    });
  });

  it("limitAiChat still reports which scope is exhausted", async () => {
    m.limit.mockImplementation(async (prefix: string) =>
      prefix === "rl:ai:user" ? { ...ok, success: false, remaining: 0 } : ok,
    );
    const result = await limitAiChat("org-1", "user-1");
    expect(result).toMatchObject({ success: false, scope: "user" });
    expect(result.unavailable).toBeUndefined();
  });

  it("limitAiChat allows within both limits, keyed by user and organization", async () => {
    expect(await limitAiChat("org-1", "user-1")).toEqual({
      success: true,
      limit: 20,
      remaining: 19,
      reset: 1_000,
    });
    expect(m.limit).toHaveBeenCalledWith("rl:ai:user", "org-1:user-1");
    expect(m.limit).toHaveBeenCalledWith("rl:ai:org", "org-1");
  });
});
