import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/plan-catalog";

/**
 * Whether a connected call may continue. Redis is an in-memory emulator of the slot scripts
 * (the scripts themselves are proven in voice-call-slots-redis), and the database is mocked.
 */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  slots: new Map<string, Set<string>>(),
  store: new Map<string, string>(),
  failEval: false,
  failRelease: false,
  getEntitlements: vi.fn(),
  getVoiceUsageState: vi.fn(),
}));

vi.mock("@/server/integrations/redis", () => ({
  redis: {
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      const key = keys[0]!;
      const held = m.slots.get(key) ?? new Set<string>();
      m.slots.set(key, held);
      if (script.includes('ZREM", KEYS[1], ARGV[1]')) {
        if (m.failRelease) throw new Error("redis down");
        held.delete(args[0]!);
        return 1;
      }
      if (m.failEval) throw new Error("redis down");
      const [, callId, limit] = args as [string, string, string];
      if (held.has(callId)) return [held.size, 1];
      if (held.size >= Number(limit)) return [-1, 0];
      held.add(callId);
      return [held.size, 0];
    }),
    set: vi.fn(async (key: string, value: string) => {
      m.store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => m.store.get(key) ?? null),
  },
}));
vi.mock("@/server/services/billing/entitlements", () => ({ getEntitlements: m.getEntitlements }));
vi.mock("@/server/services/billing/voice-usage", () => ({
  getVoiceUsageState: m.getVoiceUsageState,
  MAX_CALL_MINUTES: 15,
}));

const { admitCall, callRefusal, callSlotLimit, endCallSlot, markCallRefused } =
  await import("@/server/voice/call-admission");

const held = (org: string) => m.slots.get(`voice:slots:${org}`)?.size ?? 0;
const usage = (billable = 0, uncertain = 0) => ({
  billableMinutes: billable,
  uncertainCalls: 0,
  uncertainMinutes: uncertain,
  inFlightCalls: 0,
  inFlightMinutes: 0,
});

beforeEach(() => {
  m.slots.clear();
  m.store.clear();
  m.failEval = false;
  m.failRelease = false;
  m.getEntitlements.mockReset().mockResolvedValue({
    voiceMinutesMonth: 100,
    voiceConcurrentCalls: 3,
    readOnly: false,
  });
  m.getVoiceUsageState.mockReset().mockResolvedValue(usage());
});

describe("plan limits", () => {
  it("has no unlimited voice on any plan", () => {
    for (const limits of Object.values(PLAN_LIMITS)) {
      expect(limits.voiceMinutesMonth).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(limits.voiceConcurrentCalls).toBeLessThan(Number.MAX_SAFE_INTEGER);
    }
  });

  it("Enterprise has no voice until a contract grants minutes", () => {
    expect(callSlotLimit(PLAN_LIMITS.ENTERPRISE)).toBe(0);
    expect(callSlotLimit({ ...PLAN_LIMITS.ENTERPRISE, voiceMinutesMonth: 5000 })).toBe(1);
  });

  it("a plan with no minutes has no slots, and a grant gets at least one", () => {
    expect(callSlotLimit(PLAN_LIMITS.FREE)).toBe(0);
    expect(callSlotLimit({ ...PLAN_LIMITS.FREE, voiceMinutesMonth: 30 })).toBe(1);
    expect(callSlotLimit({ voiceMinutesMonth: 100 })).toBe(1);
  });

  it("uses the plan's slots", () => {
    expect(callSlotLimit(PLAN_LIMITS.STARTER)).toBe(1);
    expect(callSlotLimit(PLAN_LIMITS.PRO)).toBe(3);
  });
});

describe("admitting a call", () => {
  it("admits within limits, and holds a slot", async () => {
    expect(await admitCall(ORG_A, "call-1")).toEqual({ admitted: true });
    expect(held(ORG_A)).toBe(1);
  });

  it("refuses a read-only organization before taking a slot", async () => {
    m.getEntitlements.mockResolvedValue({ voiceMinutesMonth: 100, readOnly: true });
    expect(await admitCall(ORG_A, "call-1")).toEqual({ admitted: false, reason: "read_only" });
    expect(held(ORG_A)).toBe(0);
  });

  it("refuses an organization with no minutes", async () => {
    m.getEntitlements.mockResolvedValue({ voiceMinutesMonth: 0, readOnly: false });
    expect(await admitCall(ORG_A, "call-1")).toEqual({ admitted: false, reason: "no_minutes" });
  });

  it("refuses past the concurrency limit, and leaves other organizations alone", async () => {
    for (const id of ["a", "b", "c"]) await admitCall(ORG_A, id);
    expect(await admitCall(ORG_A, "d")).toEqual({ admitted: false, reason: "concurrency_limit" });
    expect(await admitCall(ORG_B, "x")).toEqual({ admitted: true });
  });

  it("stops parallel calls overshooting together: each counts those before it", async () => {
    // 80 of 100 used: the first fits. The second counts the first's possible 15 minutes,
    // which is 95, and fits. The third counts 110, and is refused.
    m.getVoiceUsageState.mockResolvedValue(usage(80));
    const results = await Promise.all(["a", "b", "c"].map((id) => admitCall(ORG_A, id)));
    expect(results.filter((r) => r.admitted)).toHaveLength(2);
    expect(results).toContainEqual({ admitted: false, reason: "minutes_exhausted" });
    expect(held(ORG_A)).toBe(2);
  });

  it("gives the slot back when minutes are exhausted", async () => {
    m.getVoiceUsageState.mockResolvedValue(usage(100));
    expect(await admitCall(ORG_A, "a")).toEqual({ admitted: false, reason: "minutes_exhausted" });
    expect(held(ORG_A)).toBe(0);
  });

  it("counts uncertain usage against the cap", async () => {
    m.getVoiceUsageState.mockResolvedValue(usage(90, 15));
    expect(await admitCall(ORG_A, "a")).toEqual({ admitted: false, reason: "minutes_exhausted" });
  });

  it("refuses when usage is past the limit, without going negative", async () => {
    m.getVoiceUsageState.mockResolvedValue(usage(1000));
    expect(await admitCall(ORG_A, "a")).toMatchObject({ admitted: false });
  });

  it("a retried start for an admitted call stays admitted, with one slot", async () => {
    m.getEntitlements.mockResolvedValue({
      voiceMinutesMonth: 100,
      voiceConcurrentCalls: 1,
      readOnly: false,
    });
    await admitCall(ORG_A, "a");
    expect(await admitCall(ORG_A, "a")).toEqual({ admitted: true });
    expect(held(ORG_A)).toBe(1);
  });
});

describe("a retried start", () => {
  it("can't end a live call for what started after it", async () => {
    await admitCall(ORG_A, "a");
    await admitCall(ORG_A, "b");
    await admitCall(ORG_A, "c");
    // Usage has since passed the cap, and the database is even failing.
    m.getEntitlements.mockRejectedValue(new Error("database down"));
    m.getVoiceUsageState.mockRejectedValue(new Error("database down"));
    expect(await admitCall(ORG_A, "a")).toEqual({ admitted: true });
    expect(held(ORG_A)).toBe(3);
  });
});

describe("calls with a row but no slot", () => {
  it("count too, so a call that ended with its report still on the way can't be missed", async () => {
    m.getVoiceUsageState.mockResolvedValue({ ...usage(90), inFlightCalls: 1 });
    expect(await admitCall(ORG_A, "a")).toEqual({ admitted: false, reason: "minutes_exhausted" });
  });
});

describe("failing closed", () => {
  it("refuses when entitlements can't be read", async () => {
    m.getEntitlements.mockRejectedValue(new Error("database down"));
    expect(await admitCall(ORG_A, "a")).toEqual({
      admitted: false,
      reason: "limits_unavailable",
    });
  });

  it("refuses when Redis can't take a slot", async () => {
    m.failEval = true;
    expect(await admitCall(ORG_A, "a")).toEqual({
      admitted: false,
      reason: "limits_unavailable",
    });
  });

  it("refuses and gives the slot back when usage can't be read", async () => {
    m.getVoiceUsageState.mockRejectedValue(new Error("database down"));
    expect(await admitCall(ORG_A, "a")).toEqual({
      admitted: false,
      reason: "limits_unavailable",
    });
    expect(held(ORG_A)).toBe(0);
  });

  it("still refuses when the slot can't be given back either", async () => {
    m.getVoiceUsageState.mockRejectedValue(new Error("database down"));
    m.failRelease = true;
    expect(await admitCall(ORG_A, "a")).toMatchObject({ admitted: false });
  });

  it("ending a slot never throws", async () => {
    m.failRelease = true;
    await expect(endCallSlot(ORG_A, "a")).resolves.toBeUndefined();
  });
});

describe("refused calls", () => {
  it("are remembered per organization", async () => {
    await markCallRefused(ORG_A, "a", "ended");
    await markCallRefused(ORG_A, "b", "running");
    expect(await callRefusal(ORG_A, "a")).toBe("ended");
    expect(await callRefusal(ORG_A, "b")).toBe("running");
    expect(await callRefusal(ORG_B, "a")).toBeNull();
  });
});
