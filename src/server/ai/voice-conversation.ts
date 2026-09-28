import "server-only";

import { getOpenAIEnv } from "@/env";
import { helsinkiDay, parsePilotAllowlist } from "@/server/ai/transcription-pilot";

/**
 * Live voice conversation ("hands-free" mode in AI Chat): server-side gating,
 * limits and atomic budget accounting.
 *
 * The browser detects when the user stops speaking and uploads each finished
 * turn; every turn is transcribed server-side and then answered by the normal
 * chat pipeline. Each paid unit (one transcription per turn) passes through
 * this module, so the limits below are enforced by the server, not by the
 * browser:
 *
 * - separate from dictation: its own flag, allowlist, keys and budgets (the
 *   dictation 10-attempts-per-day cap is untouched and not consumed);
 * - one active session per user, a concurrency cap per organization;
 * - a hard session lifetime (turns after expiry are refused);
 * - per-turn duration cap and a per-session turn cap;
 * - a daily per-organization audio budget (Europe/Helsinki day) reserved
 *   atomically with the measured turn duration before the provider call and
 *   never refunded;
 * - fail closed: any limit-store error refuses the request.
 */

export type VoiceConversationConfig = {
  sessionSeconds: number;
  maxTurnSeconds: number;
  maxTurnsPerSession: number;
  dailyOrgAudioSeconds: number;
  maxConcurrentPerOrg: number;
};

/** Conservative defaults for a small staging pilot. */
export const DEFAULT_VOICE_CONVERSATION_CONFIG: VoiceConversationConfig = {
  sessionSeconds: 300,
  maxTurnSeconds: 30,
  maxTurnsPerSession: 20,
  dailyOrgAudioSeconds: 600,
  maxConcurrentPerOrg: 1,
};

const BOUNDS: Record<keyof VoiceConversationConfig, [number, number, string]> = {
  sessionSeconds: [60, 1800, "AI_VOICE_CONVERSATION_SESSION_SECONDS"],
  maxTurnSeconds: [5, 60, "AI_VOICE_CONVERSATION_MAX_TURN_SECONDS"],
  maxTurnsPerSession: [1, 200, "AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION"],
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

/**
 * Live voice is offered only when explicitly enabled, the provider is
 * configured, the limits are valid, and the (organization, user) pair is on
 * the live-voice allowlist. Never throws.
 */
export function isVoiceConversationMember(ctx: { orgId: string; userId: string }): boolean {
  if (process.env.AI_VOICE_CONVERSATION_ENABLED !== "1") return false;
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
 * Start a session. KEYS: session, userSession, orgActive, orgDay.
 * ARGV: sessionId, org, user, nowMs, expiresAtMs, ttlSeconds, maxConcurrent,
 * dailyBudgetMs. The user's own previous session (e.g. another tab) is
 * replaced; other users' sessions count towards the organization cap.
 * Returns 1, or -2 (organization at capacity), -3 (daily budget used).
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
local used = tonumber(redis.call("GET", KEYS[4]) or "0")
if used >= tonumber(ARGV[8]) then return -3 end
redis.call("HSET", KEYS[1], "org", ARGV[2], "user", ARGV[3], "expiresAt", ARGV[5], "turns", "0", "audioMs", "0")
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[6]))
redis.call("SET", KEYS[2], ARGV[1], "EX", tonumber(ARGV[6]))
redis.call("ZADD", KEYS[3], tonumber(ARGV[5]), ARGV[1])
redis.call("EXPIRE", KEYS[3], tonumber(ARGV[6]))
return 1
`;

/**
 * Reserve one turn. KEYS: session, orgDay, turnMarker.
 * ARGV: org, user, nowMs, turnMs, dailyBudgetMs, maxTurns, dayTtlSeconds,
 * markerTtlSeconds. Returns the organization's used milliseconds after the
 * reservation, or -1 (no such session / not the owner), -4 (expired),
 * -5 (turn limit), -6 (duplicate turn), -3 (daily budget).
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
redis.call("SET", KEYS[3], "1", "EX", tonumber(ARGV[8]))
local total = redis.call("INCRBY", KEYS[2], turn)
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[7]))
redis.call("HINCRBY", KEYS[1], "turns", 1)
redis.call("HINCRBY", KEYS[1], "audioMs", turn)
return total
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

type EvalClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};
type Ctx = { orgId: string; userId: string };

const sessionKey = (id: string) => `voice:conv:session:${id}`;
const userKey = (ctx: Ctx) => `voice:conv:user:${ctx.orgId}:${ctx.userId}`;
const orgActiveKey = (ctx: Ctx) => `voice:conv:org:${ctx.orgId}:active`;
const orgDayKey = (ctx: Ctx, now: Date) => `voice:conv:org:${ctx.orgId}:day:${helsinkiDay(now)}`;
const DAY_TTL_SECONDS = 172_800;

function integerResult(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error("Unexpected limit store response");
  return n;
}

export type StartResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; reason: "org_capacity" | "daily_budget" };

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
      [sessionKey(sessionId), userKey(ctx), orgActiveKey(ctx), orgDayKey(ctx, now)],
      [
        sessionId,
        ctx.orgId,
        ctx.userId,
        String(now.getTime()),
        String(expiresAt),
        String(config.sessionSeconds + 60),
        String(config.maxConcurrentPerOrg),
        String(config.dailyOrgAudioSeconds * 1000),
      ],
    ),
  );
  if (result === 1) return { ok: true, sessionId, expiresAt };
  if (result === -2) return { ok: false, reason: "org_capacity" };
  if (result === -3) return { ok: false, reason: "daily_budget" };
  throw new Error("Unexpected limit store response");
}

export type TurnReservation =
  | { ok: true; usedMs: number }
  | {
      ok: false;
      reason:
        "session_not_found" | "session_expired" | "turn_limit" | "duplicate_turn" | "daily_budget";
    };

const TURN_ERRORS: Record<number, Exclude<TurnReservation, { ok: true }>["reason"]> = {
  [-1]: "session_not_found",
  [-4]: "session_expired",
  [-5]: "turn_limit",
  [-6]: "duplicate_turn",
  [-3]: "daily_budget",
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
      [sessionKey(sessionId), orgDayKey(ctx, now), `voice:conv:turn:${sessionId}:${turnId}`],
      [
        ctx.orgId,
        ctx.userId,
        String(now.getTime()),
        String(Math.ceil(turnMs)),
        String(config.dailyOrgAudioSeconds * 1000),
        String(config.maxTurnsPerSession),
        String(DAY_TTL_SECONDS),
        String(config.sessionSeconds + 60),
      ],
    ),
  );
  if (result >= 0) return { ok: true, usedMs: result };
  const reason = TURN_ERRORS[result];
  if (!reason) throw new Error("Unexpected limit store response");
  return { ok: false, reason };
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
