import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { env } from "@/env";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  redisClient ??= new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redisClient;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const client = getRedis();
    const value = client[prop as keyof Redis];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

type RateLimiters = {
  api: Ratelimit;
  auth: Ratelimit;
  aiChat: Ratelimit;
  anonDemo: Ratelimit;
};

let rateLimitersClient: RateLimiters | null = null;

function getRateLimiters(): RateLimiters {
  const client = getRedis();
  rateLimitersClient ??= {
    api: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(100, "1 m"),
      prefix: "rl:api",
    }),
    auth: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(10, "1 m"),
      prefix: "rl:auth",
    }),
    aiChat: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(30, "1 m"),
      prefix: "rl:ai",
    }),
    anonDemo: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(5, "1 d"),
      prefix: "rl:demo",
    }),
  };
  return rateLimitersClient;
}

export const rateLimiters = {
  get api() {
    return getRateLimiters().api;
  },
  get auth() {
    return getRateLimiters().auth;
  },
  get aiChat() {
    return getRateLimiters().aiChat;
  },
  get anonDemo() {
    return getRateLimiters().anonDemo;
  },
} satisfies RateLimiters;

/** Idempotency-Key support: returns true if this key was already used. */
export async function seenIdempotencyKey(key: string): Promise<boolean> {
  const set = await redis.set(`idem:${key}`, "1", { nx: true, ex: 60 * 60 * 24 });
  return set === null;
}
