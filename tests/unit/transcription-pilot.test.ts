import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PILOT_DAILY_ATTEMPTS,
  helsinkiDay,
  isTranscriptionPilotMember,
  parsePilotAllowlist,
  reserveDailyTranscriptionAttempt,
} from "@/server/ai/transcription-pilot";

/**
 * Staging voice pilot: allowlist by server-verified IDs and an atomic
 * per-Helsinki-day attempt counter. The counter logic runs in Redis as one
 * Lua script (Redis executes scripts atomically); here a fake store applies
 * the same check-then-increment per call, so these tests prove the key
 * scheme, limit and fail-closed handling, not Redis's atomicity itself.
 */
const ORG = "5b3a1c2d-1111-4111-8111-111111111111";
const USER = "7c4d2e3f-2222-4222-8222-222222222222";
const OTHER = "9e6f4a5b-3333-4333-8333-333333333333";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parsePilotAllowlist", () => {
  it("parses org:user UUID pairs, case-insensitively", () => {
    const set = parsePilotAllowlist(` ${ORG.toUpperCase()}:${USER} , ${OTHER}:${USER}`);
    expect([...set]).toEqual([`${ORG}:${USER}`, `${OTHER}:${USER}`]);
  });

  it.each([
    ["empty", ""],
    ["a bare email", "juttajarvi92@gmail.com"],
    ["one malformed entry among valid ones", `${ORG}:${USER},not-a-uuid:${USER}`],
    ["an extra field", `${ORG}:${USER}:${OTHER}`],
  ])("allows no one for %s (fail closed)", (_label, raw) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parsePilotAllowlist(raw).size).toBe(0);
  });
});

describe("isTranscriptionPilotMember", () => {
  beforeEach(() => {
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("AI_TRANSCRIPTION_PILOT_ALLOWLIST", `${ORG}:${USER}`);
  });

  it("admits only the allowlisted (organization, user) pair", () => {
    expect(isTranscriptionPilotMember({ orgId: ORG, userId: USER })).toBe(true);
    expect(isTranscriptionPilotMember({ orgId: ORG, userId: OTHER })).toBe(false);
    expect(isTranscriptionPilotMember({ orgId: OTHER, userId: USER })).toBe(false);
  });

  it("admits no one when the feature flag is off or the allowlist is missing", () => {
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "0");
    expect(isTranscriptionPilotMember({ orgId: ORG, userId: USER })).toBe(false);
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "1");
    vi.stubEnv("AI_TRANSCRIPTION_PILOT_ALLOWLIST", "");
    expect(isTranscriptionPilotMember({ orgId: ORG, userId: USER })).toBe(false);
  });
});

describe("helsinkiDay (Europe/Helsinki calendar day, DST-aware)", () => {
  it.each([
    ["summer: 23:59:59 EEST", "2026-09-27T20:59:59Z", "2026-09-27"],
    ["summer: midnight EEST", "2026-09-27T21:00:00Z", "2026-09-28"],
    ["winter: 23:59:59 EET", "2026-01-15T21:59:59Z", "2026-01-15"],
    ["winter: midnight EET", "2026-01-15T22:00:00Z", "2026-01-16"],
    ["spring-forward day starts at 22:00Z", "2026-03-28T22:00:00Z", "2026-03-29"],
    ["fall-back day (25 h) ends at 22:00Z", "2026-10-25T21:59:59Z", "2026-10-25"],
    ["after the fall-back day", "2026-10-25T22:00:00Z", "2026-10-26"],
  ])("%s", (_label, iso, day) => {
    expect(helsinkiDay(new Date(iso))).toBe(day);
  });
});

/** Fake store applying the reserve script's semantics per call. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const calls: Array<{ key: string; limit: string; ttl: string }> = [];
  return {
    counts,
    calls,
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      expect(script).toContain('redis.call("INCR", KEYS[1])');
      const [key] = keys as [string];
      calls.push({ key, limit: args[0]!, ttl: args[1]! });
      const current = counts.get(key) ?? 0;
      if (current >= Number(args[0])) return -1;
      counts.set(key, current + 1);
      return current + 1;
    }),
  };
}

describe("reserveDailyTranscriptionAttempt", () => {
  const ctx = { orgId: ORG, userId: USER };

  it(`allows exactly ${PILOT_DAILY_ATTEMPTS} attempts per day, then refuses`, async () => {
    const redis = fakeRedis();
    const at = new Date("2026-09-28T09:00:00Z");
    const results = [];
    for (let i = 0; i < 12; i++)
      results.push(await reserveDailyTranscriptionAttempt(redis, ctx, at));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.slice(10).every((r) => !r.ok)).toBe(true);
    expect(redis.calls[0]).toEqual({
      key: `pilot:transcribe:2026-09-28:${ORG}:${USER}`,
      limit: "10",
      ttl: "172800",
    });
  });

  it("concurrent reservations never exceed the limit", async () => {
    const redis = fakeRedis();
    const at = new Date("2026-09-28T09:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 25 }, () => reserveDailyTranscriptionAttempt(redis, ctx, at)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(redis.counts.get(`pilot:transcribe:2026-09-28:${ORG}:${USER}`)).toBe(10);
  });

  it("resets at Helsinki midnight, not UTC midnight", async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 10; i++) {
      await reserveDailyTranscriptionAttempt(redis, ctx, new Date("2026-09-27T20:59:59Z"));
    }
    expect(
      (await reserveDailyTranscriptionAttempt(redis, ctx, new Date("2026-09-27T20:59:59Z"))).ok,
    ).toBe(false);
    // 00:00 Helsinki (EEST) = 21:00 UTC: a new day, even though UTC is still the 27th.
    expect(
      (await reserveDailyTranscriptionAttempt(redis, ctx, new Date("2026-09-27T21:00:00Z"))).ok,
    ).toBe(true);
  });

  it("keeps separate counters per user and organization", async () => {
    const redis = fakeRedis();
    const at = new Date("2026-09-28T09:00:00Z");
    for (let i = 0; i < 10; i++) await reserveDailyTranscriptionAttempt(redis, ctx, at);
    expect(
      (await reserveDailyTranscriptionAttempt(redis, { orgId: OTHER, userId: USER }, at)).ok,
    ).toBe(true);
  });

  it("throws (caller fails closed) when the store errors or answers oddly", async () => {
    await expect(
      reserveDailyTranscriptionAttempt(
        { eval: vi.fn(async () => Promise.reject(new Error("ECONNRESET"))) },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      reserveDailyTranscriptionAttempt({ eval: vi.fn(async () => "OK") }, ctx),
    ).rejects.toThrow(/Unexpected/);
  });
});
