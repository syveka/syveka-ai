import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { env } from "@/env";

export const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

/** Sliding-window limiters (§10.1, §13.2). */
export const rateLimiters = {
  api: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, "1 m"),
    prefix: "rl:api",
  }),
  auth: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1 m"),
    prefix: "rl:auth",
  }),
  aiChat: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "1 m"),
    prefix: "rl:ai",
  }),
  anonDemo: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1 d"),
    prefix: "rl:demo",
  }),
};

/** Idempotency-Key support (§10.1): returns true if this key was already used. */
export async function seenIdempotencyKey(key: string): Promise<boolean> {
  const set = await redis.set(`idem:${key}`, "1", { nx: true, ex: 60 * 60 * 24 });
  return set === null;
}
