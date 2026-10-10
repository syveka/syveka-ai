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

export type RateLimiters = {
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

/**
 * The outcome of one rate-limit check. "unavailable" means the limit could not
 * be verified (Redis timed out, errored, or isn't configured).
 */
export type LimitDecision =
  | { ok: true; limit: number; remaining: number; reset: number }
  | {
      ok: false;
      reason: "limited";
      limit: number;
      remaining: number;
      reset: number;
      scope?: "user" | "organization";
    }
  | { ok: false; reason: "unavailable" };

function logRateLimitUnavailable(limiter: keyof RateLimiters, cause: "timeout" | "error"): void {
  // The key is never logged: keys contain IP addresses and user/organization IDs.
  console.error(JSON.stringify({ event: "rate_limit_unavailable", limiter, cause }));
}

/**
 * Checks one named limiter. Never throws, and never reports an unverified
 * limit as allowed: Upstash's Ratelimit *allows* a request when Redis doesn't
 * answer within its timeout (`reason: "timeout"`) and throws when Redis
 * errors, and reading a limiter throws when Redis isn't configured. All three
 * are "unavailable", for the caller to refuse (fail closed). A "cacheBlock"
 * or "denyList" refusal is "limited".
 */
export async function checkRateLimit(
  name: keyof RateLimiters,
  key: string,
): Promise<LimitDecision> {
  let result;
  try {
    // The limiter is read inside the try: its getter throws without Redis config.
    result = await rateLimiters[name].limit(key);
  } catch {
    logRateLimitUnavailable(name, "error");
    return { ok: false, reason: "unavailable" };
  }
  if (result.reason === "timeout") {
    logRateLimitUnavailable(name, "timeout");
    return { ok: false, reason: "unavailable" };
  }
  const { limit, remaining, reset } = result;
  return result.success
    ? { ok: true, limit, remaining, reset }
    : { ok: false, reason: "limited", limit, remaining, reset };
}

export type AiChatRateLimitResult = {
  success: boolean;
  /** The limit could not be verified: refuse as unavailable (503), not as rate-limited. */
  unavailable?: true;
  scope?: "user" | "organization";
  reset: number;
  limit: number;
  remaining: number;
};

function toAiLimitResult(
  decision: LimitDecision,
  scope: "user" | "organization",
): AiChatRateLimitResult {
  if (decision.ok) {
    const { limit, remaining, reset } = decision;
    return { success: true, limit, remaining, reset };
  }
  if (decision.reason === "unavailable") {
    return { success: false, unavailable: true, reset: 0, limit: 0, remaining: 0 };
  }
  const { limit, remaining, reset } = decision;
  return { success: false, scope, limit, remaining, reset };
}

/** Both limits must pass; an unverifiable one refuses the request before a denied one. */
async function limitUserAndOrganization(
  userLimiter: keyof RateLimiters,
  organizationLimiter: keyof RateLimiters,
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult> {
  const [user, organization] = await Promise.all([
    checkRateLimit(userLimiter, `${organizationId}:${userId}`),
    checkRateLimit(organizationLimiter, organizationId),
  ]);
  if (!user.ok && user.reason === "unavailable") return toAiLimitResult(user, "user");
  if (!organization.ok && organization.reason === "unavailable") {
    return toAiLimitResult(organization, "organization");
  }
  if (!user.ok) return toAiLimitResult(user, "user");
  if (!organization.ok) return toAiLimitResult(organization, "organization");
  return {
    success: true,
    reset: Math.max(user.reset, organization.reset),
    limit: Math.min(user.limit, organization.limit),
    remaining: Math.min(user.remaining, organization.remaining),
  };
}

/**
 * Independent per-user and per-organization limits for chat and the other
 * paid AI features. Fails closed: `unavailable` when either can't be verified.
 */
export async function limitAiChat(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult> {
  return limitUserAndOrganization("aiChatUser", "aiChatOrg", organizationId, userId);
}

/**
 * Per-user and per-organization limits for chat voice transcription (a paid
 * provider call per request). Fails closed: `unavailable` when either can't be
 * verified.
 */
export async function limitAiTranscription(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult> {
  return limitUserAndOrganization(
    "aiTranscriptionUser",
    "aiTranscriptionOrg",
    organizationId,
    userId,
  );
}

/** Short-window limit for live voice turns. Fails closed: `unavailable` when unverifiable. */
export async function limitAiVoiceTurn(
  organizationId: string,
  userId: string,
): Promise<AiChatRateLimitResult> {
  const decision = await checkRateLimit("aiVoiceTurnUser", `${organizationId}:${userId}`);
  return toAiLimitResult(decision, "user");
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
