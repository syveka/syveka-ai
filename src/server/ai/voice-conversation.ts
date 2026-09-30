import "server-only";

import { getOpenAIEnv } from "@/env";
import { helsinkiDay, parsePilotAllowlist } from "@/server/ai/transcription-pilot";
import type { AllowanceCount, VoiceAllowance } from "@/lib/voice/allowance";

export type { VoiceAllowance };

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
 * - daily per-organization budgets (Europe/Helsinki day) for started
 *   sessions, turns and audio seconds, shared by all sessions and tabs,
 *   consumed atomically and never refunded;
 * - each session is bound to one conversation the user may access (or one
 *   the server reserved for a new chat);
 * - each accepted turn yields exactly one single-use grant for one chat
 *   generation, bound to user, organization, session, turn, conversation
 *   and transcript;
 * - while a user has an active live session, chat without a grant is refused
 *   (a client can't route live turns around the voice restrictions);
 * - fail closed: any limit-store error refuses the request.
 */

export type VoiceConversationConfig = {
  sessionSeconds: number;
  maxTurnSeconds: number;
  maxTurnsPerSession: number;
  dailyOrgSessions: number;
  dailyOrgTurns: number;
  dailyOrgAudioSeconds: number;
  maxConcurrentPerOrg: number;
};

/**
 * Temporary staging pilot values for the first acceptance run — not customer
 * pricing or plan allowances: one successfully started session per
 * organization per Helsinki day, 5 minutes, 10 turns, 30 s per turn, 5 minutes
 * of accepted audio per organization per day, one concurrent session.
 */
export const DEFAULT_VOICE_CONVERSATION_CONFIG: VoiceConversationConfig = {
  sessionSeconds: 300,
  maxTurnSeconds: 30,
  maxTurnsPerSession: 10,
  dailyOrgSessions: 1,
  dailyOrgTurns: 10,
  dailyOrgAudioSeconds: 300,
  maxConcurrentPerOrg: 1,
};

const BOUNDS: Record<keyof VoiceConversationConfig, [number, number, string]> = {
  sessionSeconds: [60, 1800, "AI_VOICE_CONVERSATION_SESSION_SECONDS"],
  maxTurnSeconds: [5, 60, "AI_VOICE_CONVERSATION_MAX_TURN_SECONDS"],
  maxTurnsPerSession: [1, 200, "AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION"],
  dailyOrgSessions: [1, 200, "AI_VOICE_CONVERSATION_DAILY_ORG_SESSIONS"],
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
//
// Keys live under a namespace (default "voice:conv", see EvalClient.keyPrefix).
// Scripts that derive a key from stored data receive the namespace as an ARGV.

/**
 * Start a session. KEYS: session, userSession, orgActive, orgDayAudio,
 * orgDayTurns, orgDaySessions. ARGV: sessionId, org, user, nowMs, expiresAtMs,
 * sessionTtlSeconds, maxConcurrent, dailyBudgetMs, dailyTurns, dailySessions,
 * conversationId, newConversation ("1"/"0"), dayTtlSeconds, namespace.
 *
 * Every check runs before anything changes, so a refused start leaves the
 * user's existing session (e.g. in another tab) untouched. A successful start
 * consumes one of the organization's daily session slots; it is never
 * refunded (ending early, reloading or opening another tab doesn't give it
 * back). The daily budgets are organization-wide and keyed by Helsinki day,
 * so a new session never resets them. The session is bound to one
 * server-validated (or server-reserved, for a new chat) conversation.
 * Returns 1, or -8 (daily sessions used), -3 (daily audio used), -7 (daily
 * turns used), -2 (organization at capacity).
 */
export const START_SESSION_SCRIPT = `
local now = tonumber(ARGV[4])
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now)
if tonumber(redis.call("GET", KEYS[6]) or "0") >= tonumber(ARGV[10]) then return -8 end
if tonumber(redis.call("GET", KEYS[4]) or "0") >= tonumber(ARGV[8]) then return -3 end
if tonumber(redis.call("GET", KEYS[5]) or "0") >= tonumber(ARGV[9]) then return -7 end
local previous = redis.call("GET", KEYS[2])
local active = redis.call("ZCARD", KEYS[3])
if previous and redis.call("ZSCORE", KEYS[3], previous) then active = active - 1 end
if active >= tonumber(ARGV[7]) then return -2 end
if previous then
  redis.call("ZREM", KEYS[3], previous)
  redis.call("DEL", ARGV[14] .. ":session:" .. previous)
end
redis.call("INCR", KEYS[6])
redis.call("EXPIRE", KEYS[6], tonumber(ARGV[13]))
redis.call("HSET", KEYS[1], "org", ARGV[2], "user", ARGV[3], "conversation", ARGV[11],
  "newConversation", ARGV[12], "expiresAt", ARGV[5], "turns", "0", "audioMs", "0")
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
 * is incremented, so a refused turn reserves nothing. The turn marker makes a
 * retried request (e.g. one whose response was lost) a refused duplicate
 * rather than a second reservation.
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
 * is still live and owned. The grant inherits the session's conversation.
 * KEYS: grant, session. ARGV: org, user, sessionId, turnId, text, nowMs,
 * ttlSeconds. Returns 1, or -1 (session gone / not the owner / expired).
 */
export const ISSUE_GRANT_SCRIPT = `
local org = redis.call("HGET", KEYS[2], "org")
local user = redis.call("HGET", KEYS[2], "user")
if not org or org ~= ARGV[1] or user ~= ARGV[2] then return -1 end
if tonumber(redis.call("HGET", KEYS[2], "expiresAt")) <= tonumber(ARGV[6]) then return -1 end
local conversation = redis.call("HGET", KEYS[2], "conversation")
if not conversation then return -1 end
local isNew = redis.call("HGET", KEYS[2], "newConversation") or "0"
redis.call("HSET", KEYS[1], "org", ARGV[1], "user", ARGV[2], "session", ARGV[3], "turn", ARGV[4],
  "text", ARGV[5], "conversation", conversation, "newConversation", isNew)
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[7]))
return 1
`;

/**
 * Consume a grant for exactly one chat generation. KEYS: grant.
 * ARGV: org, user, message, nowMs, conversationId, namespace. A grant that
 * reaches the session check is deleted, so a replay or a concurrent
 * duplicate finds nothing. It is valid only in its own conversation and only
 * while its session is live (ended, replaced and expired sessions can't start
 * new work).
 * Returns 1 (existing conversation) or 2 (the session's new, server-reserved
 * conversation), or -1 (no such grant / not the owner), -4 (another
 * conversation), -2 (message differs from the transcript), -3 (session
 * ended, replaced or expired).
 */
export const CONSUME_GRANT_SCRIPT = `
local org = redis.call("HGET", KEYS[1], "org")
local user = redis.call("HGET", KEYS[1], "user")
if not org or org ~= ARGV[1] or user ~= ARGV[2] then return -1 end
if redis.call("HGET", KEYS[1], "conversation") ~= ARGV[5] then return -4 end
if redis.call("HGET", KEYS[1], "text") ~= ARGV[3] then return -2 end
local isNew = redis.call("HGET", KEYS[1], "newConversation") == "1"
local session = ARGV[6] .. ":session:" .. redis.call("HGET", KEYS[1], "session")
local expires = redis.call("HGET", session, "expiresAt")
redis.call("DEL", KEYS[1])
if not expires or tonumber(expires) <= tonumber(ARGV[4]) or redis.call("HGET", session, "user") ~= ARGV[2] then
  return -3
end
if isNew then return 2 end
return 1
`;

/**
 * Whether the user currently has a live session. KEYS: userSession.
 * ARGV: nowMs, namespace. Returns 1 or 0.
 */
export const ACTIVE_SESSION_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id then return 0 end
local expires = redis.call("HGET", ARGV[2] .. ":session:" .. id, "expiresAt")
if expires and tonumber(expires) > tonumber(ARGV[1]) then return 1 end
return 0
`;

/**
 * End a session. KEYS: session, userSession, orgActive. ARGV: sessionId, org,
 * user. Only the owner can end it. It needs no configuration, so a session
 * can always be closed, even after the feature or its limits changed.
 * Returns 1, 0 when already gone, or -1 (not the owner).
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
  /** Key namespace; tests against a real Redis use their own. */
  keyPrefix?: string;
};
type Ctx = { orgId: string; userId: string };

const DEFAULT_NAMESPACE = "voice:conv";
const ns = (redis: EvalClient) => redis.keyPrefix ?? DEFAULT_NAMESPACE;
const sessionKey = (n: string, id: string) => `${n}:session:${id}`;
const userKey = (n: string, ctx: Ctx) => `${n}:user:${ctx.orgId}:${ctx.userId}`;
const orgActiveKey = (n: string, ctx: Ctx) => `${n}:org:${ctx.orgId}:active`;
const orgDayKey = (n: string, ctx: Ctx, now: Date) =>
  `${n}:org:${ctx.orgId}:day:${helsinkiDay(now)}`;
const orgTurnsKey = (n: string, ctx: Ctx, now: Date) =>
  `${n}:org:${ctx.orgId}:turns:${helsinkiDay(now)}`;
const orgSessionsKey = (n: string, ctx: Ctx, now: Date) =>
  `${n}:org:${ctx.orgId}:sessions:${helsinkiDay(now)}`;
const grantKey = (n: string, id: string) => `${n}:grant:${id}`;
/** Day counters outlive their Helsinki day (≤ 25 h) with margin, then expire. */
export const DAY_TTL_SECONDS = 172_800;
/** A grant must be used promptly: the client submits it right after transcription. */
export const GRANT_TTL_SECONDS = 120;

function integerResult(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error("Unexpected limit store response");
  return n;
}

/** The conversation a session is bound to (validated or reserved by the server). */
export type SessionConversation = { id: string; isNew: boolean };

export type StartResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; reason: "org_capacity" | "daily_budget" | "daily_turns" | "daily_sessions" };

const START_ERRORS: Record<number, Exclude<StartResult, { ok: true }>["reason"]> = {
  [-2]: "org_capacity",
  [-3]: "daily_budget",
  [-7]: "daily_turns",
  [-8]: "daily_sessions",
};

export async function startVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  config: VoiceConversationConfig,
  sessionId: string,
  conversation: SessionConversation,
  now: Date = new Date(),
): Promise<StartResult> {
  const n = ns(redis);
  const expiresAt = now.getTime() + config.sessionSeconds * 1000;
  const result = integerResult(
    await redis.eval(
      START_SESSION_SCRIPT,
      [
        sessionKey(n, sessionId),
        userKey(n, ctx),
        orgActiveKey(n, ctx),
        orgDayKey(n, ctx, now),
        orgTurnsKey(n, ctx, now),
        orgSessionsKey(n, ctx, now),
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
        String(config.dailyOrgSessions),
        conversation.id,
        conversation.isNew ? "1" : "0",
        String(DAY_TTL_SECONDS),
        n,
      ],
    ),
  );
  if (result === 1) return { ok: true, sessionId, expiresAt };
  const reason = START_ERRORS[result];
  if (!reason) throw new Error("Unexpected limit store response");
  return { ok: false, reason };
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
  const n = ns(redis);
  const result = integerResult(
    await redis.eval(
      RESERVE_TURN_SCRIPT,
      [
        sessionKey(n, sessionId),
        orgDayKey(n, ctx, now),
        `${n}:turn:${sessionId}:${turnId}`,
        orgTurnsKey(n, ctx, now),
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
  const n = ns(redis);
  const grantId = crypto.randomUUID();
  const result = integerResult(
    await redis.eval(
      ISSUE_GRANT_SCRIPT,
      [grantKey(n, grantId), sessionKey(n, sessionId)],
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
  | { ok: true; newConversation: boolean }
  | {
      ok: false;
      reason: "invalid_grant" | "conversation_mismatch" | "message_mismatch" | "session_ended";
    };

const GRANT_ERRORS: Record<number, Exclude<GrantConsumption, { ok: true }>["reason"]> = {
  [-1]: "invalid_grant",
  [-4]: "conversation_mismatch",
  [-2]: "message_mismatch",
  [-3]: "session_ended",
};

export async function consumeVoiceGrant(
  redis: EvalClient,
  ctx: Ctx,
  grantId: string,
  message: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<GrantConsumption> {
  const n = ns(redis);
  const result = integerResult(
    await redis.eval(
      CONSUME_GRANT_SCRIPT,
      [grantKey(n, grantId)],
      [ctx.orgId, ctx.userId, message, String(now.getTime()), conversationId, n],
    ),
  );
  if (result === 1 || result === 2) return { ok: true, newConversation: result === 2 };
  const reason = GRANT_ERRORS[result];
  if (!reason) throw new Error("Unexpected limit store response");
  return { ok: false, reason };
}

export async function hasActiveVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  now: Date = new Date(),
): Promise<boolean> {
  const n = ns(redis);
  return (
    integerResult(
      await redis.eval(ACTIVE_SESSION_SCRIPT, [userKey(n, ctx)], [String(now.getTime()), n]),
    ) === 1
  );
}

export async function endVoiceSession(
  redis: EvalClient,
  ctx: Ctx,
  sessionId: string,
): Promise<"ended" | "not_found" | "not_owner"> {
  const n = ns(redis);
  const result = integerResult(
    await redis.eval(
      END_SESSION_SCRIPT,
      [sessionKey(n, sessionId), userKey(n, ctx), orgActiveKey(n, ctx)],
      [sessionId, ctx.orgId, ctx.userId],
    ),
  );
  return result === 1 ? "ended" : result === 0 ? "not_found" : "not_owner";
}

// ── Allowance (read-only) ────────────────────────────────────────────────────

/**
 * Reads the organization's daily counters and, if given, one session's turn
 * count. Read-only: it never reserves, increments or extends anything.
 * KEYS: orgDaySessions, orgDayTurns, orgDayAudio[, session]. ARGV: org, user.
 * The session is reported only to its owner (otherwise -1, -1).
 * Returns { sessionsUsed, turnsUsed, audioMsUsed, sessionTurns, sessionExpiresAt }.
 */
export const ALLOWANCE_SCRIPT = `
local sessions = tonumber(redis.call("GET", KEYS[1]) or "0")
local turns = tonumber(redis.call("GET", KEYS[2]) or "0")
local audio = tonumber(redis.call("GET", KEYS[3]) or "0")
local sessionTurns = -1
local expiresAt = -1
if KEYS[4] and redis.call("HGET", KEYS[4], "org") == ARGV[1]
  and redis.call("HGET", KEYS[4], "user") == ARGV[2] then
  sessionTurns = tonumber(redis.call("HGET", KEYS[4], "turns") or "0")
  expiresAt = tonumber(redis.call("HGET", KEYS[4], "expiresAt") or "0")
end
return { sessions, turns, audio, sessionTurns, expiresAt }
`;

/**
 * The next Europe/Helsinki midnight after `now` (when the daily limits
 * renew). DST changes happen at 03:00/04:00 local time, never at midnight,
 * so midnight is always UTC+2 (winter) or UTC+3 (summer); the zone rules
 * decide which.
 */
export function nextHelsinkiMidnight(now: Date): number {
  const today = helsinkiDay(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  for (const offsetHours of [3, 2]) {
    const candidate = Date.UTC(y, m - 1, d + 1, 0, 0) - offsetHours * 3_600_000;
    if (
      candidate > now.getTime() &&
      helsinkiDay(new Date(candidate)) !== today &&
      helsinkiDay(new Date(candidate - 1)) === today
    ) {
      return candidate;
    }
  }
  throw new Error("Cannot determine the next Helsinki midnight");
}

const count = (used: number, limit: number): AllowanceCount => ({
  used,
  limit,
  remaining: Math.max(0, limit - used),
});

/** Below this much audio left, no turn can be accepted (see MIN_RECORDING_MS). */
const MIN_TURN_AUDIO_MS = 700;

export async function readVoiceAllowance(
  redis: EvalClient,
  ctx: Ctx,
  config: VoiceConversationConfig,
  sessionId: string | null = null,
  now: Date = new Date(),
): Promise<VoiceAllowance> {
  const n = ns(redis);
  const keys = [orgSessionsKey(n, ctx, now), orgTurnsKey(n, ctx, now), orgDayKey(n, ctx, now)];
  if (sessionId) keys.push(sessionKey(n, sessionId));
  const raw = await redis.eval(ALLOWANCE_SCRIPT, keys, [ctx.orgId, ctx.userId]);
  if (!Array.isArray(raw) || raw.length !== 5) throw new Error("Unexpected limit store response");
  const [sessionsUsed, turnsUsed, audioUsed, sessionTurns, expiresAt] = raw.map(integerResult) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const startsToday = count(sessionsUsed, config.dailyOrgSessions);
  const turnsToday = count(turnsUsed, config.dailyOrgTurns);
  const audioMsToday = count(audioUsed, config.dailyOrgAudioSeconds * 1000);
  const session =
    sessionTurns >= 0 ? { turns: count(sessionTurns, config.maxTurnsPerSession), expiresAt } : null;
  const turnsAvailable =
    audioMsToday.remaining < MIN_TURN_AUDIO_MS
      ? 0
      : Math.min(turnsToday.remaining, session ? session.turns.remaining : Infinity);
  return {
    day: helsinkiDay(now),
    renewsAt: nextHelsinkiMidnight(now),
    startsToday,
    turnsToday,
    audioMsToday,
    sessionSeconds: config.sessionSeconds,
    maxTurnSeconds: config.maxTurnSeconds,
    maxTurnsPerSession: config.maxTurnsPerSession,
    session,
    turnsAvailable,
  };
}

/**
 * The allowance for a response, or null when it can't be read (the client
 * then shows it as unknown rather than guessing). Never throws.
 */
export async function tryReadVoiceAllowance(
  ...args: Parameters<typeof readVoiceAllowance>
): Promise<VoiceAllowance | null> {
  try {
    return await readVoiceAllowance(...args);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "voice_conversation_store_unavailable",
        op: "allowance",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return null;
  }
}
