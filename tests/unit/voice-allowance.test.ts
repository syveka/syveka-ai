import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_SCRIPT,
  DEFAULT_VOICE_CONVERSATION_CONFIG,
  nextHelsinkiMidnight,
  readVoiceAllowance,
  type EvalClient,
} from "@/server/ai/voice-conversation";
import {
  clock,
  exhaustedReason,
  helsinkiTime,
  newerAllowance,
  type VoiceAllowance,
} from "@/lib/voice/allowance";

/**
 * The live-voice allowance: what an organization can still use today
 * (Helsinki day), read without changing anything. The Lua script itself runs
 * against a real Redis in voice-conversation-redis.test.ts; here a fake store
 * returns fixed counters so the TypeScript side is exact.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const me = { orgId: ORG, userId: USER };
const PILOT = DEFAULT_VOICE_CONVERSATION_CONFIG;

function store(values: [number, number, number, number, number]) {
  const calls: Array<{ script: string; keys: string[]; args: string[] }> = [];
  const redis: EvalClient = {
    eval: async (script, keys, args) => {
      calls.push({ script, keys, args });
      return values;
    },
  };
  return { redis, calls };
}

describe("next Helsinki midnight (when daily limits renew)", () => {
  it.each([
    ["winter (UTC+2)", "2026-01-15T10:00:00Z", "2026-01-15T22:00:00.000Z"],
    ["summer (UTC+3)", "2026-07-01T10:00:00Z", "2026-07-01T21:00:00.000Z"],
    ["one second before midnight", "2026-09-30T20:59:59Z", "2026-09-30T21:00:00.000Z"],
    ["just after midnight", "2026-09-30T21:00:00Z", "2026-10-01T21:00:00.000Z"],
    // Spring forward (03:00 → 04:00 on 29 March): the day is 23 hours long.
    ["spring DST day", "2026-03-28T23:30:00Z", "2026-03-29T21:00:00.000Z"],
    // Fall back (04:00 → 03:00 on 25 October): the day is 25 hours long.
    ["autumn DST day", "2026-10-24T22:30:00Z", "2026-10-25T22:00:00.000Z"],
  ])("%s", (_, now, expected) => {
    const renews = nextHelsinkiMidnight(new Date(now));
    expect(new Date(renews).toISOString()).toBe(expected);
    expect(helsinkiTime(renews, "fi")).toBe("00.00");
    expect(helsinkiTime(renews, "en")).toBe("00:00");
  });
});

describe("readVoiceAllowance", () => {
  const now = new Date("2026-09-30T09:00:00Z");

  it("the reported incident: 1 start, 6 turns and 31 740 ms of audio used today → 4 turns left", async () => {
    // The audio counter is in milliseconds: 31 740 = 31.74 s of the 300 s day.
    const { redis } = store([1, 6, 31_740, -1, -1]);
    const a = await readVoiceAllowance(redis, me, PILOT, null, now);
    expect(a.startsToday).toEqual({ used: 1, limit: 1, remaining: 0 });
    expect(a.turnsToday).toEqual({ used: 6, limit: 10, remaining: 4 });
    expect(a.audioMsToday).toEqual({ used: 31_740, limit: 300_000, remaining: 268_260 });
    expect(clock(a.audioMsToday.remaining)).toBe("4:28");
    expect(a.turnsAvailable).toBe(4);
    expect(a.sessionSeconds).toBe(300);
    expect(a.day).toBe("2026-09-30");
  });

  it("a new session doesn't restore the day's turns: available = today's turns left, not the session's 10", async () => {
    const { redis } = store([2, 6, 31_740, 0, now.getTime() + 300_000]);
    const a = await readVoiceAllowance(redis, me, PILOT, "session-1", now);
    expect(a.session?.turns).toEqual({ used: 0, limit: 10, remaining: 10 });
    expect(a.turnsAvailable).toBe(4);
    expect(exhaustedReason(a)).toBeNull();
  });

  it("names the limit that stops further turns", async () => {
    const turns = await readVoiceAllowance(store([1, 10, 50_000, 4, 0]).redis, me, PILOT, "s", now);
    expect([turns.turnsAvailable, exhaustedReason(turns)]).toEqual([0, "daily_turns"]);
    const audio = await readVoiceAllowance(store([1, 3, 299_500, 3, 0]).redis, me, PILOT, "s", now);
    expect([audio.turnsAvailable, exhaustedReason(audio)]).toEqual([0, "daily_audio"]);
    const capped = await readVoiceAllowance(
      store([1, 4, 20_000, 10, 0]).redis,
      me,
      { ...PILOT, dailyOrgTurns: 50 },
      "s",
      now,
    );
    expect([capped.turnsAvailable, exhaustedReason(capped)]).toEqual([0, "session_turns"]);
  });

  it("reads only the signed-in organization's keys, with the read-only script", async () => {
    const { redis, calls } = store([0, 0, 0, -1, -1]);
    await readVoiceAllowance(redis, me, PILOT, "s-1", now);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.script).toBe(ALLOWANCE_SCRIPT);
    expect(calls[0]!.keys).toEqual([
      `voice:conv:org:${ORG}:sessions:2026-09-30`,
      `voice:conv:org:${ORG}:turns:2026-09-30`,
      `voice:conv:org:${ORG}:day:2026-09-30`,
      "voice:conv:session:s-1",
    ]);
    // The session is reported only to its owner (checked in the script).
    expect(calls[0]!.args).toEqual([ORG, USER]);
    for (const write of ["INCR", "SET", "HSET", "DEL", "EXPIRE", "ZADD", "ZREM", "HINCRBY"]) {
      expect(ALLOWANCE_SCRIPT).not.toContain(`"${write}"`);
    }
  });

  it("uses the Helsinki day of the request (after midnight: the new day's keys)", async () => {
    const { redis, calls } = store([0, 0, 0, -1, -1]);
    const a = await readVoiceAllowance(redis, me, PILOT, null, new Date("2026-09-30T21:00:01Z"));
    expect(a.day).toBe("2026-10-01");
    expect(calls[0]!.keys[1]).toBe(`voice:conv:org:${ORG}:turns:2026-10-01`);
  });

  it("fails loudly on an unexpected store response (callers show 'unknown')", async () => {
    const redis: EvalClient = { eval: async () => 7 };
    await expect(readVoiceAllowance(redis, me, PILOT, null, now)).rejects.toThrow();
  });
});

describe("newerAllowance (stale responses, midnight)", () => {
  const base = (day: string, turnsUsed: number, audioUsed = 0): VoiceAllowance => ({
    day,
    renewsAt: 0,
    startsToday: { used: 1, limit: 1, remaining: 0 },
    turnsToday: { used: turnsUsed, limit: 10, remaining: 10 - turnsUsed },
    audioMsToday: { used: audioUsed, limit: 300_000, remaining: 300_000 - audioUsed },
    sessionSeconds: 300,
    maxTurnSeconds: 30,
    maxTurnsPerSession: 10,
    session: null,
    turnsAvailable: 10 - turnsUsed,
  });

  it("a slower, older reading never overwrites a newer one", () => {
    const newer = base("2026-09-30", 8, 40_000);
    expect(newerAllowance(newer, base("2026-09-30", 7, 35_000))).toBe(newer);
    const next = base("2026-09-30", 9, 45_000);
    expect(newerAllowance(newer, next)).toBe(next);
  });

  it("after Helsinki midnight the new day's reading wins even though it shows less use", () => {
    const tomorrow = base("2026-10-01", 1);
    expect(newerAllowance(base("2026-09-30", 10), tomorrow)).toBe(tomorrow);
    expect(newerAllowance(tomorrow, base("2026-09-30", 10))).toBe(tomorrow);
  });

  it("an unknown reading keeps what is known", () => {
    const known = base("2026-09-30", 3);
    expect(newerAllowance(known, null)).toBe(known);
    expect(newerAllowance(null, undefined)).toBeNull();
  });
});
