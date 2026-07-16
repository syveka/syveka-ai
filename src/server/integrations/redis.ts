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
  aiChatUser: Ratelimit;
  aiChatOrg: Ratelimit;
  anonDemo: Ratelimit;
};

let rateLimitersClient: RateLimiters | null = null;

function getRateLimiters(): RateLimiters {
  const client = getRedis();
  const window = `${env.AI_CHAT_RATE_WINDOW_SECONDS} s` as const;
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
    aiChatUser: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(env.AI_CHAT_USER_RATE_LIMIT, window),
      prefix: "rl:ai:user",
    }),
    aiChatOrg: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(env.AI_CHAT_ORG_RATE_LIMIT, window),
      prefix: "rl:ai:org",
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
  get aiChatUser() {
    return getRateLimiters().aiChatUser;
  },
  get aiChatOrg() {
    return getRateLimiters().aiChatOrg;
  },
  get anonDemo() {
    return getRateLimiters().anonDemo;
  },
} satisfies RateLimiters;

export type AiChatRateLimitResult = {
  success: boolean;
  scope?: "user" | "organization";
  reset: number;
  limit: number;
  remaining: number;
};

/** Enforce independent per-user and per-organization Redis limits. */
export async function limitAiChat(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult> {
  const [user, organization] = await Promise.all([
    rateLimiters.aiChatUser.limit(`${organizationId}:${userId}`),
    rateLimiters.aiChatOrg.limit(organizationId),
  ]);
  if (!user.success) return { ...user, scope: "user" };
  if (!organization.success) return { ...organization, scope: "organization" };
  return {
    success: true,
    reset: Math.max(user.reset, organization.reset),
    limit: Math.min(user.limit, organization.limit),
    remaining: Math.min(user.remaining, organization.remaining),
  };
}

/** Idempotency-Key support: returns true if this key was already used. */
export async function seenIdempotencyKey(key: string): Promise<boolean> {
  const set = await redis.set(`idem:${key}`, "1", { nx: true, ex: 60 * 60 * 24 });
  return set === null;
}
