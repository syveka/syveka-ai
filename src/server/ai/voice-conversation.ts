import "server-only";

import { getOpenAIEnv } from "@/env";
import { helsinkiDay, parsePilotAllowlist } from "@/server/ai/transcription-pilot";

/**
 * Live voice conversation ("hands-free" mode in AI Chat): server-side gating,
 * limits and atomic budget accounting. It is a sequential pipeline, not
 * native speech-to-speech:
 *
 *   turn audio → POST /voice-conversation/turn (reserve, transcribe, issue a
 *   single-use chat grant) → POST /ai/chat with that grant (consume it
 *   atomically; voice mode and its bounds are derived from the grant, never
 *   from a client flag) → the reply is spoken by the device.
 *
 * Every paid unit passes through this module:
 * - separate from dictation (own flag, allowlist, keys, budgets);
 * - one active session per user; an organization concurrency cap; a hard
 *   session lifetime; a per-turn duration cap and a per-session turn cap;
 * - daily per-organization budgets for BOTH turns and audio seconds
 *   (Europe/Helsinki day), shared by all sessions and tabs, reserved
 *   atomically before the provider call and never refunded;
 * - each accepted turn yields exactly one single-use grant for one chat
 *   generation, bound to user, organization, session, turn and transcript;
 * - while a user has an active live session, chat without a grant is refused
 *   (a client can't route live turns around the voice restrictions);
 * - fail closed: any limit-store error refuses the request.
 */

export type VoiceConversationConfig = {
  sessionSeconds: number;
  maxTurnSeconds: number;
  maxTurnsPerSession: number;
  dailyOrgTurns: number;
  dailyOrgAudioSeconds: number;
  maxConcurrentPerOrg: number;
};

/** Temporary staging pilot values (not customer pricing or plan allowances). */
export const DEFAULT_VOICE_CONVERSATION_CONFIG: VoiceConversationConfig = {
  sessionSeconds: 300,
  maxTurnSeconds: 30,
  maxTurnsPerSession: 20,
  dailyOrgTurns: 30,
  dailyOrgAudioSeconds: 600,
  maxConcurrentPerOrg: 1,
};

const BOUNDS: Record<keyof VoiceConversationConfig, [number, number, string]> = {
  sessionSeconds: [60, 1800, "AI_VOICE_CONVERSATION_SESSION_SECONDS"],
  maxTurnSeconds: [5, 60, "AI_VOICE_CONVERSATION_MAX_TURN_SECONDS"],
  maxTurnsPerSession: [1, 200, "AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION"],
  dailyOrgTurns: [1, 2000, "AI_VOICE_CONVERSATION_DAILY_ORG_TURNS"],
  dailyOrgAudioSeconds: [60, 36_000, "AI_VOICE_CONVERSATION_DAILY_ORG_AUDIO_SECONDS"],
  maxConcurrentPerOrg: [1, 20, "AI_VOICE_CONVERSATION_MAX_CONCURRENT_PER_ORG"],
};

/**
 * Reads limits from the environment. Unset values use the defaults; a set
 * but invalid or out-of-range value returns null so the feature stays off
 * instead of running with a limit nobody intended.
 */
export function readVoiceConversationConfig(
  env: Record<string, string | undefined> = process.env,
): VoiceConversationConfig | null {
  const config = { ...DEFAULT_VOICE_CONVERSATION_CONFIG };
  for (const key of Object.keys(BOUNDS) as Array<keyof VoiceConversationConfig>) {
    const [min, max, name] = BOUNDS[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      console.error(JSON.stringify({ event: "voice_conversation_config_invalid", name }));
      return null;
    }
    config[key] = value;
  }
  return config;
}

/** The feature flag alone (used to decide whether typed chat must check for live sessions). */
export function isVoiceConversationFeatureOn(): boolean {
  return process.env.AI_VOICE_CONVERSATION_ENABLED === "1";
}

/**
 * Live voice is offered only when explicitly enabled, the provider is
 * configured, the limits are valid, and the (organization, user) pair is on
 * the live-voice allowlist. Never throws.
 */
export function isVoiceConversationMember(ctx: { orgId: string; userId: string }): boolean {
  if (!isVoiceConversationFeatureOn()) return false;
  try {
    getOpenAIEnv();
  } catch {
    return false;
  }
  if (!readVoiceConversationConfig()) return false;
  const allowlist = parsePilotAllowlist(process.env.AI_VOICE_CONVERSATION_PILOT_ALLOWLIST);
  return allowlist.has(`${ctx.orgId.toLowerCase()}:${ctx.userId.toLowerCase()}`);
}

// ── Atomic scripts (each runs as one Redis operation) ──────────────────────

/**
 * Start a session. KEYS: session, userSession, orgActive, orgDayAudio,
 * orgDayTurns. ARGV: sessionId, org, user, nowMs, expiresAtMs, ttlSeconds,
 * maxConcurrent, dailyBudgetMs, dailyTurns. The user's own previous session
 * (e.g. another tab) is replaced; other users' sessions count towards the
 * organization cap. The daily budgets are organization-wide and survive
 * sessions, so a new session never resets them.
 * Returns 1, or -2 (organization at capacity), -3 (daily audio used),
 * -7 (daily turns used).
 */
export const START_SESSION_SCRIPT = `
local now = tonumber(ARGV[4])
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now)
local previous = redis.call("GET", KEYS[2])
if previous then
  redis.call("ZREM", KEYS[3], previous)
  redis.call("DEL", "voice:conv:session:" .. previous)
end
if redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[7]) then return -2 end
if tonumber(redis.call("GET", KEYS[4]) or "0") >= tonumber(ARGV[8]) then return -3 end
if tonumber(redis.call("GET", KEYS[5]) or "0") >= tonumber(ARGV[9]) then return -7 end
redis.call("HSET", KEYS[1], "org", ARGV[2], "user", ARGV[3], "expiresAt", ARGV[5], "turns", "0", "audioMs", "0")
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[6]))
redis.call("SET", KEYS[2], ARGV[1], "EX", tonumber(ARGV[6]))
redis.call("ZADD", KEYS[3], tonumber(ARGV[5]), ARGV[1])
redis.call("EXPIRE", KEYS[3], tonumber(ARGV[6]))
return 1
`;

/**
 * Reserve one turn. KEYS: session, orgDayAudio, turnMarker, orgDayTurns.
 * ARGV: org, user, nowMs, turnMs, dailyBudgetMs, maxTurns, dayTtlSeconds,
 * markerTtlSeconds, dailyTurns. Both daily budgets are checked before either
 * is incremented, so a refused turn reserves nothing.
 * Returns the organization's used audio ms after the reservation, or
 * -1 (no such session / not the owner), -4 (expired), -5 (session turn
 * limit), -6 (duplicate turn), -3 (daily audio), -7 (daily turns).
 */
export const RESERVE_TURN_SCRIPT = `
local org = redis.call("HGET", KEYS[1], "org")
local user = redis.call("HGET", KEYS[1], "user")
if not org or org ~= ARGV[1] or user ~= ARGV[2] then return -1 end
if tonumber(redis.call("HGET", KEYS[1], "expiresAt")) <= tonumber(ARGV[3]) then return -4 end
if tonumber(redis.call("HGET", KEYS[1], "turns")) >= tonumber(ARGV[6]) then return -5 end
if redis.call("EXISTS", KEYS[3]) == 1 then return -6 end
local used = tonumber(redis.call("GET", KEYS[2]) or "0")
local turn = tonumber(ARGV[4])
if used + turn > tonumber(ARGV[5]) then return -3 end
if tonumber(redis.call("GET", KEYS[4]) or "0") + 1 > tonumber(ARGV[9]) then return -7 end
redis.call("SET", KEYS[3], "1", "EX", tonumber(ARGV[8]))
local total = redis.call("INCRBY", KEYS[2], turn)
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[7]))
redis.call("INCR", KEYS[4])
redis.call("EXPIRE", KEYS[4], tonumber(ARGV[7]))
redis.call("HINCRBY", KEYS[1], "turns", 1)
redis.call("HINCRBY", KEYS[1], "audioMs", turn)
return total
`;

/**
 * Issue the single-use chat grant for a transcribed turn, only if the session
 * is still live and owned. KEYS: grant, session. ARGV: org, user, sessionId,
 * turnId, text, nowMs, ttlSeconds. Returns 1, or -1 (session gone / not the
 * owner / expired).
 */
export const ISSUE_GRANT_SCRIPT = `
local org = redis.call("HGET", KEYS[2], "org")
local user = redis.call("HGET", KEYS[2], "user")
if not org or org ~= ARGV[1] or user ~= ARGV[2] then return -1 end
if tonumber(redis.call("HGET", KEYS[2], "expiresAt")) <= tonumber(ARGV[6]) then return -1 end
redis.call("HSET", KEYS[1], "org", ARGV[1], "user", ARGV[2], "session", ARGV[3], "turn", ARGV[4], "text", ARGV[5])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))
return 1
`;

/**
 * Consume a grant for exactly one chat generation. KEYS: grant.
 * ARGV: org, user, message, nowMs. The grant is deleted on success, so a
 * replay or a concurrent duplicate finds nothing. The session must still be
 * live (ended, replaced and expired sessions can't start new work).
 * Returns 1, or -1 (no such grant / not the owner), -2 (message differs from
 * the transcript), -3 (session ended, replaced or expired).
 */
export const CONSUME_GRANT_SCRIPT = `
local org = redis.call("HGET", KEYS[1], "org")
local user = redis.call("HGET", KEYS[1], "user")
if not org or org ~= ARGV[1] or user ~= ARGV[2] then return -1 end
if redis.call("HGET", KEYS[1], "text") ~= ARGV[3] then return -2 end
local session = "voice:conv:session:" .. redis.call("HGET", KEYS[1], "session")
local expires = redis.call("HGET", session, "expiresAt")
if not expires or tonumber(expires) <= tonumber(ARGV[4]) or redis.call("HGET", session, "user") ~= ARGV[2] then
  redis.call("DEL", KEYS[1])
  return -3
end
redis.call("DEL", KEYS[1])
return 1
`;

/**
 * Whether the user currently has a live session. KEYS: userSession.
 * ARGV: nowMs. Returns 1 or 0.
 */
export const ACTIVE_SESSION_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id then return 0 end
local expires = redis.call("HGET", "voice:conv:session:" .. id, "expiresAt")
if expires and tonumber(expires) > tonumber(ARGV[1]) then return 1 end
return 0
`;

/**
 * End a session. KEYS: session, userSession, orgActive. ARGV: sessionId, org,
 * user. Only the owner can end it. Returns 1, or 0 when already gone.
 */
export const END_SESSION_SCRIPT = `
local org = redis.call("HGET", KEYS[1], "org")
local user = redis.call("HGET", KEYS[1], "user")
if org and (org ~= ARGV[2] or user ~= ARGV[3]) then return -1 end
redis.call("ZREM", KEYS[3], ARGV[1])
if redis.call("GET", KEYS[2]) == ARGV[1] then redis.call("DEL", KEYS[2]) end
if not org then return 0 end
redis.call("DEL", KEYS[1])
return 1
`;

export type EvalClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};
type Ctx = { orgId: string; userId: string };

const sessionKey = (id: string) => `voice:conv:session:${id}`;
const userKey = (ctx: Ctx) => `voice:conv:user:${ctx.orgId}:${ctx.userId}`;
const orgActiveKey = (ctx: Ctx) => `voice:conv:org:${ctx.orgId}:active`;
const orgDayKey = (ctx: Ctx, now: Date) => `voice:conv:org:${ctx.orgId}:day:${helsinkiDay(now)}`;
const orgTurnsKey = (ctx: Ctx, now: Date) =>
  `voice:conv:org:${ctx.orgId}:turns:${helsinkiDay(now)}`;
const grantKey = (id: string) => `voice:conv:grant:${id}`;
const DAY_TTL_SECONDS = 172_800;
/** A grant must be used promptly: the client submits it right after transcription. */
export const GRANT_TTL_SECONDS = 120;

function integerResult(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error("Unexpected limit store response");
  return n;
}

export type StartResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; reason: "org_capacity" | "daily_budget" | "daily_turns" };

export async function startVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  config: VoiceConversationConfig,
  sessionId: string,
  now: Date = new Date(),
): Promise<StartResult> {
  const expiresAt = now.getTime() + config.sessionSeconds * 1000;
  const result = integerResult(
    await redis.eval(
      START_SESSION_SCRIPT,
      [
        sessionKey(sessionId),
        userKey(ctx),
        orgActiveKey(ctx),
        orgDayKey(ctx, now),
        orgTurnsKey(ctx, now),
      ],
      [
        sessionId,
        ctx.orgId,
        ctx.userId,
        String(now.getTime()),
        String(expiresAt),
        String(config.sessionSeconds + 60),
        String(config.maxConcurrentPerOrg),
        String(config.dailyOrgAudioSeconds * 1000),
        String(config.dailyOrgTurns),
      ],
    ),
  );
  if (result === 1) return { ok: true, sessionId, expiresAt };
  if (result === -2) return { ok: false, reason: "org_capacity" };
  if (result === -3) return { ok: false, reason: "daily_budget" };
  if (result === -7) return { ok: false, reason: "daily_turns" };
  throw new Error("Unexpected limit store response");
}

export type TurnReservation =
  | { ok: true; usedMs: number }
  | {
      ok: false;
      reason:
        | "session_not_found"
        | "session_expired"
        | "turn_limit"
        | "duplicate_turn"
        | "daily_budget"
        | "daily_turns";
    };

const TURN_ERRORS: Record<number, Exclude<TurnReservation, { ok: true }>["reason"]> = {
  [-1]: "session_not_found",
  [-4]: "session_expired",
  [-5]: "turn_limit",
  [-6]: "duplicate_turn",
  [-3]: "daily_budget",
  [-7]: "daily_turns",
};

export async function reserveVoiceTurn(
  redis: EvalClient,
  ctx: Ctx,
  config: VoiceConversationConfig,
  sessionId: string,
  turnId: string,
  turnMs: number,
  now: Date = new Date(),
): Promise<TurnReservation> {
  const result = integerResult(
    await redis.eval(
      RESERVE_TURN_SCRIPT,
      [
        sessionKey(sessionId),
        orgDayKey(ctx, now),
        `voice:conv:turn:${sessionId}:${turnId}`,
        orgTurnsKey(ctx, now),
      ],
      [
        ctx.orgId,
        ctx.userId,
        String(now.getTime()),
        String(Math.ceil(turnMs)),
        String(config.dailyOrgAudioSeconds * 1000),
        String(config.maxTurnsPerSession),
        String(DAY_TTL_SECONDS),
        String(config.sessionSeconds + 60),
        String(config.dailyOrgTurns),
      ],
    ),
  );
  if (result >= 0) return { ok: true, usedMs: result };
  const reason = TURN_ERRORS[result];
  if (!reason) throw new Error("Unexpected limit store response");
  return { ok: false, reason };
}

/** Issues the single-use grant for one chat generation. Null if the session is gone. */
export async function issueVoiceGrant(
  redis: EvalClient,
  ctx: Ctx,
  sessionId: string,
  turnId: string,
  text: string,
  now: Date = new Date(),
): Promise<string | null> {
  const grantId = crypto.randomUUID();
  const result = integerResult(
    await redis.eval(
      ISSUE_GRANT_SCRIPT,
      [grantKey(grantId), sessionKey(sessionId)],
      [
        ctx.orgId,
        ctx.userId,
        sessionId,
        turnId,
        text,
        String(now.getTime()),
        String(GRANT_TTL_SECONDS),
      ],
    ),
  );
  return result === 1 ? grantId : null;
}

export type GrantConsumption =
  { ok: true } | { ok: false; reason: "invalid_grant" | "message_mismatch" | "session_ended" };

export async function consumeVoiceGrant(
  redis: EvalClient,
  ctx: Ctx,
  grantId: string,
  message: string,
  now: Date = new Date(),
): Promise<GrantConsumption> {
  const result = integerResult(
    await redis.eval(
      CONSUME_GRANT_SCRIPT,
      [grantKey(grantId)],
      [ctx.orgId, ctx.userId, message, String(now.getTime())],
    ),
  );
  if (result === 1) return { ok: true };
  if (result === -1) return { ok: false, reason: "invalid_grant" };
  if (result === -2) return { ok: false, reason: "message_mismatch" };
  if (result === -3) return { ok: false, reason: "session_ended" };
  throw new Error("Unexpected limit store response");
}

export async function hasActiveVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  now: Date = new Date(),
): Promise<boolean> {
  return (
    integerResult(
      await redis.eval(ACTIVE_SESSION_SCRIPT, [userKey(ctx)], [String(now.getTime())]),
    ) === 1
  );
}

export async function endVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  sessionId: string,
): Promise<"ended" | "not_found" | "not_owner"> {
  const result = integerResult(
    await redis.eval(
      END_SESSION_SCRIPT,
      [sessionKey(sessionId), userKey(ctx), orgActiveKey(ctx)],
      [sessionId, ctx.orgId, ctx.userId],
    ),
  );
  return result === 1 ? "ended" : result === 0 ? "not_found" : "not_owner";
}
