import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live voice conversation: server gating, limits and both endpoints.
 * Mocked: session, Redis (limiter + script results), billing, the OpenAI
 * call. Real: permissions, config parsing, audio measurement, route order.
 * The Lua scripts themselves were executed separately against real Lua
 * (fakeredis) — see the PR.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "44444444-4444-4444-8444-444444444444";

const m = vi.hoisted(() => ({
  ctx: null as null | { orgId: string; userId: string; role: string },
  rate: { success: true } as Record<string, unknown>,
  evalResult: 1 as unknown,
  grantResult: 1 as unknown,
  evalError: null as Error | null,
  evalCalls: [] as Array<{ script: string; keys: string[]; args: string[] }>,
  order: [] as string[],
  transcribe: vi.fn(),
  recordUsage: vi.fn(async () => {}),
  quotaExceeded: false,
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => {
    if (!m.ctx) throw new Error("unauthenticated");
    return m.ctx;
  }),
}));
vi.mock("@/server/integrations/redis", () => ({
  limitAiVoiceTurn: vi.fn(async () => m.rate),
  redis: {
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      m.evalCalls.push({ script, keys, args });
      m.order.push("reserve");
      if (m.evalError) throw m.evalError;
      if (script.includes('"session", ARGV[3]')) {
        m.order.push("grant");
        return m.grantResult;
      }
      return m.evalResult;
    }),
  },
}));
vi.mock("@/server/integrations/openai", () => ({
  transcribeAudio: m.transcribe,
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
}));
vi.mock("@/server/services/billing/entitlements", () => {
  class EntitlementError extends Error {
    readonly code = "entitlement_exceeded";
  }
  return {
    EntitlementError,
    getMonthUsage: vi.fn(async () => 0),
    assertWithinLimit: vi.fn(async () => {
      if (m.quotaExceeded) throw new EntitlementError("limit");
    }),
    recordUsage: m.recordUsage,
  };
});

import {
  readVoiceConversationConfig,
  isVoiceConversationMember,
} from "@/server/ai/voice-conversation";
import {
  POST as startSession,
  DELETE as endSession,
} from "@/app/api/v1/ai/voice-conversation/session/route";
import { POST as postTurn } from "@/app/api/v1/ai/voice-conversation/turn/route";

const REAL_WEBM = new Uint8Array(
  fs.readFileSync(path.join(__dirname, "fixtures/audio/chrome-opus-2s.webm")),
);

function turnRequest(
  fields: Record<string, string> = { sessionId: SESSION, turnId: crypto.randomUUID() },
  audio: Uint8Array<ArrayBuffer> | null = REAL_WEBM.slice(),
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (audio) form.append("audio", new Blob([audio], { type: "audio/webm" }), "turn");
  return new Request("http://localhost/api/v1/ai/voice-conversation/turn", {
    method: "POST",
    body: form,
    headers,
  });
}
const sameOrigin = { "sec-fetch-site": "same-origin" };
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "1");
  vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", `${ORG}:${USER}`);
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  // Dictation stays configured separately and must never be consulted here.
  vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "0");
  m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
  m.rate = { success: true };
  m.evalResult = 1;
  m.grantResult = 1;
  m.evalError = null;
  m.evalCalls = [];
  m.order = [];
  m.quotaExceeded = false;
  m.transcribe.mockReset().mockImplementation(async () => {
    m.order.push("provider");
    return "Mitä kalenterissa on huomenna?";
  });
  m.recordUsage.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configuration and gating", () => {
  it("uses conservative defaults and refuses out-of-range values (feature off)", () => {
    expect(readVoiceConversationConfig({})).toEqual({
      sessionSeconds: 300,
      maxTurnSeconds: 30,
      maxTurnsPerSession: 20,
      dailyOrgTurns: 30,
      dailyOrgAudioSeconds: 600,
      maxConcurrentPerOrg: 1,
    });
    expect(
      readVoiceConversationConfig({ AI_VOICE_CONVERSATION_SESSION_SECONDS: "120" })?.sessionSeconds,
    ).toBe(120);
    expect(
      readVoiceConversationConfig({ AI_VOICE_CONVERSATION_SESSION_SECONDS: "999999" }),
    ).toBeNull();
    expect(
      readVoiceConversationConfig({ AI_VOICE_CONVERSATION_MAX_TURN_SECONDS: "abc" }),
    ).toBeNull();
  });

  it("is separate from dictation: its own flag and allowlist", () => {
    expect(isVoiceConversationMember({ orgId: ORG, userId: USER })).toBe(true);
    vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "0");
    vi.stubEnv("AI_TRANSCRIPTION_ENABLED", "1");
    vi.stubEnv("AI_TRANSCRIPTION_PILOT_ALLOWLIST", `${ORG}:${USER}`);
    expect(isVoiceConversationMember({ orgId: ORG, userId: USER })).toBe(false);
  });

  it("admits only the allowlisted pair; invalid limits disable it", () => {
    expect(isVoiceConversationMember({ orgId: ORG, userId: SESSION })).toBe(false);
    vi.stubEnv("AI_VOICE_CONVERSATION_DAILY_ORG_AUDIO_SECONDS", "1");
    expect(isVoiceConversationMember({ orgId: ORG, userId: USER })).toBe(false);
  });
});

describe("POST/DELETE /api/v1/ai/voice-conversation/session", () => {
  const start = () =>
    startSession(new Request("http://localhost/x", { method: "POST", headers: sameOrigin }));

  it.each([
    ["cross-origin", () => undefined, { "sec-fetch-site": "cross-site" }, 403],
    ["unauthenticated", () => (m.ctx = null), sameOrigin, 401],
    [
      "VIEWER (no chat:use)",
      () => (m.ctx = { orgId: ORG, userId: USER, role: "VIEWER" }),
      sameOrigin,
      403,
    ],
    [
      "not in the live-voice pilot",
      () => vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", ""),
      sameOrigin,
      403,
    ],
    ["feature disabled", () => vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "0"), sameOrigin, 403],
  ])("start refused: %s (no store access)", async (_l, arrange, headers, status) => {
    arrange();
    const res = await startSession(new Request("http://localhost/x", { method: "POST", headers }));
    expect(res.status).toBe(status);
    expect(m.evalCalls).toHaveLength(0);
  });

  it("starts a session bound to the server-verified org and user", async () => {
    const { status, body } = await json(await start());
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ maxTurnSeconds: 30, sessionSeconds: 300 });
    const call = m.evalCalls[0]!;
    expect(call.keys).toContain(`voice:conv:user:${ORG}:${USER}`);
    expect(call.args.slice(1, 3)).toEqual([ORG, USER]);
    expect(call.args[6]).toBe("1"); // max concurrent per org
    expect(call.args[7]).toBe("600000"); // daily org audio budget (ms)
    expect(call.args[8]).toBe("30"); // daily org turns
    expect(call.keys).toContain(`voice:conv:org:${ORG}:turns:${call.keys[4]!.split(":").pop()}`);
  });

  it.each([
    [-2, "voice_capacity_reached"],
    [-3, "voice_daily_limit_reached"],
    [-7, "voice_daily_limit_reached"],
  ])("maps store result %s to 429 %s", async (result, code) => {
    m.evalResult = result;
    expect(await json(await start())).toEqual({ status: 429, body: { error: { code } } });
  });

  it("fails closed (503) when the limit store is unavailable", async () => {
    m.evalError = new Error("ECONNREFUSED");
    expect((await start()).status).toBe(503);
  });

  it("ending needs no pilot membership but checks ownership", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "0");
    const del = (id: string) =>
      endSession(
        new Request(`http://localhost/x?sessionId=${id}`, {
          method: "DELETE",
          headers: sameOrigin,
        }),
      );
    expect((await del(SESSION)).status).toBe(200);
    m.evalResult = -1;
    expect((await del(SESSION)).status).toBe(404);
    expect((await del("not-a-uuid")).status).toBe(400);
  });
});

describe("POST /api/v1/ai/voice-conversation/turn", () => {
  it.each([
    ["not in the pilot", () => vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", "")],
    ["rate limited", () => (m.rate = { success: false })],
    ["limiter timeout (fail closed)", () => (m.rate = { success: false, unavailable: true })],
    ["quota exhausted", () => (m.quotaExceeded = true)],
  ])("refused before any reservation: %s", async (_l, arrange) => {
    arrange();
    const res = await postTurn(turnRequest());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(m.evalCalls).toHaveLength(0);
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ["missing ids", turnRequest({})],
    ["missing audio", turnRequest(undefined, null)],
    ["unmeasurable audio", turnRequest(undefined, new Uint8Array(4096))],
  ])("rejects malformed input (%s) before reserving", async (_l, req) => {
    const res = await postTurn(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(m.evalCalls).toHaveLength(0);
  });

  it("refuses a turn longer than the per-turn cap before reserving", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_MAX_TURN_SECONDS", "5");
    // Valid WebM/Opus: 100 × 60 ms packets = 6 s.
    const el = (id: number[], body: number[], unknown = false) => [
      ...id,
      ...(unknown
        ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
        : body.length < 0x7f
          ? [0x80 | body.length]
          : [0x40 | (body.length >> 8), body.length & 0xff]),
      ...body,
    ];
    const track = el(
      [0xae],
      [
        ...el([0xd7], [1]),
        ...el(
          [0x86],
          Array.from("A_OPUS", (c) => c.charCodeAt(0)),
        ),
      ],
    );
    const blocks = Array.from({ length: 100 }, () =>
      el([0xa3], [0x81, 0, 0, 0x80, 0x18, ...new Array(12).fill(0)]),
    );
    const sixSeconds = new Uint8Array([
      ...el([0x1a, 0x45, 0xdf, 0xa3], []),
      ...el([0x18, 0x53, 0x80, 0x67], [], true),
      ...el([0x16, 0x54, 0xae, 0x6b], track),
      ...el([0x1f, 0x43, 0xb6, 0x75], [], true),
      ...blocks.flat(),
    ]);
    const res = await postTurn(turnRequest(undefined, sixSeconds));
    expect(await json(res)).toEqual({ status: 422, body: { error: { code: "audio_too_long" } } });
    expect(m.evalCalls).toHaveLength(0);
  });

  it("reserves the measured duration, then makes exactly one provider call", async () => {
    m.evalResult = 12_000;
    const { status, body } = await json(await postTurn(turnRequest()));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      text: "Mitä kalenterissa on huomenna?",
      dailyRemainingSeconds: 588,
    });
    expect(body.data.grant).toMatch(/^[0-9a-f-]{36}$/);
    // Reserve → one provider call → one grant for one chat generation.
    expect(m.order).toEqual(["reserve", "provider", "reserve", "grant"]);
    const reserve = m.evalCalls[0]!;
    expect(reserve.keys[0]).toBe(`voice:conv:session:${SESSION}`);
    expect(reserve.keys[1]).toMatch(new RegExp(`^voice:conv:org:${ORG}:day:\\d{4}-\\d{2}-\\d{2}$`));
    expect(Number(reserve.args[3])).toBeGreaterThan(1700); // measured ~2 s, in ms
    expect(Number(reserve.args[3])).toBeLessThan(2300);
    expect(m.recordUsage).toHaveBeenCalledWith(
      ORG,
      "API_CALLS",
      1,
      expect.objectContaining({ kind: "ai_voice_conversation_turn", userId: USER }),
    );
    // Never touches the dictation daily-attempt key.
    expect(m.evalCalls.every((c) => c.keys.every((k) => !k.startsWith("pilot:transcribe")))).toBe(
      true,
    );
  });

  it.each([
    [-1, 409, "session_not_found"],
    [-4, 409, "session_expired"],
    [-5, 429, "turn_limit"],
    [-6, 409, "duplicate_turn"],
    [-3, 429, "voice_daily_limit_reached"],
    [-7, 429, "voice_daily_limit_reached"],
  ])("store result %s → %s %s, no provider call", async (result, status, code) => {
    m.evalResult = result;
    expect(await json(await postTurn(turnRequest()))).toEqual({
      status,
      body: { error: { code } },
    });
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("an empty transcript issues no grant (no chat generation can follow)", async () => {
    m.transcribe.mockImplementation(async () => {
      m.order.push("provider");
      return "   ";
    });
    const { status, body } = await json(await postTurn(turnRequest()));
    expect(status).toBe(200);
    expect(body.data.text).toBe("");
    expect(body.data.grant).toBeUndefined();
    expect(m.order).not.toContain("grant");
  });

  it("a session that ended during transcription gets no grant (409)", async () => {
    m.grantResult = -1;
    const res = await postTurn(turnRequest());
    expect(await json(res)).toEqual({ status: 409, body: { error: { code: "session_expired" } } });
  });

  it("fails closed when the reservation store errors", async () => {
    m.evalError = new Error("ECONNRESET");
    expect((await postTurn(turnRequest())).status).toBe(503);
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("a failed provider attempt keeps its reservation and is not retried", async () => {
    m.evalResult = 2000;
    m.transcribe.mockImplementation(async () => {
      m.order.push("provider");
      throw Object.assign(new Error("secret upstream detail"), { status: 500 });
    });
    const res = await postTurn(turnRequest());
    expect(res.status).toBe(502);
    expect(m.order).toEqual(["reserve", "provider"]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret upstream detail",
    );
  });
});
