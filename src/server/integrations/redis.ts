import "server-only";

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedisEnv } from "@/env";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = getRedisEnv();
    redisClient = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  }
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
  businessDnaExtract: Ratelimit;
  inboxEmailWebhook: Ratelimit;
  creatorGenerate: Ratelimit;
  publicAssistant: Ratelimit;
  aiTranscriptionUser: Ratelimit;
  aiTranscriptionOrg: Ratelimit;
  aiVoiceTurnUser: Ratelimit;
  businessDnaWrite: Ratelimit;
  workflowTestRun: Ratelimit;
};

let rateLimitersClient: RateLimiters | null = null;

function getRateLimiters(): RateLimiters {
  const client = getRedis();
  const { AI_CHAT_USER_RATE_LIMIT, AI_CHAT_ORG_RATE_LIMIT, AI_CHAT_RATE_WINDOW_SECONDS } =
    getRedisEnv();
  const window = `${AI_CHAT_RATE_WINDOW_SECONDS} s` as const;
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
      limiter: Ratelimit.slidingWindow(AI_CHAT_USER_RATE_LIMIT, window),
      prefix: "rl:ai:user",
    }),
    aiChatOrg: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(AI_CHAT_ORG_RATE_LIMIT, window),
      prefix: "rl:ai:org",
    }),
    anonDemo: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(5, "1 d"),
      prefix: "rl:demo",
    }),
    businessDnaExtract: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(5, "1 h"),
      prefix: "rl:business-dna-extract",
    }),
    inboxEmailWebhook: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(60, "1 m"),
      prefix: "rl:inbox-email-webhook",
    }),
    // Cost-amplifying (consumes credits + calls an AI provider) — a tighter
    // limit than the generic "api" limiter (§4: rate-limit every
    // state-changing, cost-amplifying endpoint).
    creatorGenerate: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      prefix: "rl:creator-generate",
    }),
    // Public, unauthenticated, cost-amplifying (calls an AI provider) — keyed
    // by IP in the route. Deliberately tighter than the authenticated
    // aiChatUser limit: no login gate stands in front of this endpoint.
    publicAssistant: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "rl:public-assistant",
    }),
    // Chat voice input: each call is a paid speech-to-text request, limited
    // separately from chat messages so dictation can't drain the chat budget.
    aiTranscriptionUser: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(20, "10 m"),
      prefix: "rl:ai:transcribe:user",
    }),
    aiTranscriptionOrg: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(200, "10 m"),
      prefix: "rl:ai:transcribe:org",
    }),
    // Live voice conversation turns: separate from dictation, generous enough
    // for a natural conversation; the session/budget limits are the real cap.
    aiVoiceTurnUser: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(40, "5 m"),
      prefix: "rl:ai:voice-turn:user",
    }),
    // Business DNA profile saves (form, API): each one re-syncs every active
    // voice assistant of the organization with the voice provider, so they are
    // capped per organization, generously for people editing by hand.
    businessDnaWrite: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(30, "10 m"),
      prefix: "rl:business-dna-write:org",
    }),
    // Manual workflow test runs: each can call an AI provider and send email
    // from the platform domain, so they are capped per organization.
    workflowTestRun: new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "rl:workflow-test-run:org",
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
  get businessDnaExtract() {
    return getRateLimiters().businessDnaExtract;
  },
  get inboxEmailWebhook() {
    return getRateLimiters().inboxEmailWebhook;
  },
  get creatorGenerate() {
    return getRateLimiters().creatorGenerate;
  },
  get publicAssistant() {
    return getRateLimiters().publicAssistant;
  },
  get aiTranscriptionUser() {
    return getRateLimiters().aiTranscriptionUser;
  },
  get aiTranscriptionOrg() {
    return getRateLimiters().aiTranscriptionOrg;
  },
  get aiVoiceTurnUser() {
    return getRateLimiters().aiVoiceTurnUser;
  },
  get businessDnaWrite() {
    return getRateLimiters().businessDnaWrite;
  },
  get workflowTestRun() {
    return getRateLimiters().workflowTestRun;
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

/**
 * Per-user and per-organization limits for chat voice transcription.
 *
 * Fails closed: Upstash's Ratelimit *allows* a request when Redis doesn't
 * answer within its timeout (`reason: "timeout"`). This endpoint pays a
 * provider per request, so an unverifiable limit is treated as unavailable.
 */
export async function limitAiTranscription(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult & { unavailable?: true }> {
  const [user, organization] = await Promise.all([
    rateLimiters.aiTranscriptionUser.limit(`${organizationId}:${userId}`),
    rateLimiters.aiTranscriptionOrg.limit(organizationId),
  ]);
  if (user.reason === "timeout" || organization.reason === "timeout") {
    return { success: false, unavailable: true, reset: 0, limit: 0, remaining: 0 };
  }
  if (!user.success) return { ...user, scope: "user" };
  if (!organization.success) return { ...organization, scope: "organization" };
  return {
    success: true,
    reset: Math.max(user.reset, organization.reset),
    limit: Math.min(user.limit, organization.limit),
    remaining: Math.min(user.remaining, organization.remaining),
  };
}

/** Short-window limit for live voice turns. Fails closed on limiter timeouts. */
export async function limitAiVoiceTurn(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult & { unavailable?: true }> {
  const result = await rateLimiters.aiVoiceTurnUser.limit(`${organizationId}:${userId}`);
  if (result.reason === "timeout") {
    return { success: false, unavailable: true, reset: 0, limit: 0, remaining: 0 };
  }
  return { ...result, scope: result.success ? undefined : "user" };
}

/** Idempotency-Key support: returns true if this key was already used. */
export async function seenIdempotencyKey(key: string): Promise<boolean> {
  const set = await redis.set(`idem:${key}`, "1", { nx: true, ex: 60 * 60 * 24 });
  return set === null;
}

/**
 * Gives back a claim taken with seenIdempotencyKey() when the work it guarded
 * failed, so a later retry can do it instead of being skipped as done.
 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  await redis.del(`idem:${key}`);
}
