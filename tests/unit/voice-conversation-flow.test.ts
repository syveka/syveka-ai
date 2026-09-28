import fs from "node:fs";
import path from "node:path";
import type * as VoiceModule from "@/server/ai/voice-conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end route integration of the live voice boundary:
 * session → turn (transcribe, grant) → chat (consume grant, generate).
 *
 * Real: the session, turn and chat routes; voice-conversation.ts (limits,
 * keys, grant logic); tool registry and executor; permissions; system prompt;
 * audio measurement. Mocked: tenant session, OpenAI transcription/moderation,
 * the Anthropic stream, billing, conversation services. The database is an
 * in-memory, organization-scoped conversation table.
 *
 * Redis: the scripts run against an in-memory emulator that mirrors their
 * semantics (below). The Lua scripts themselves are executed against a real
 * Redis server in tests/integration/voice-conversation-redis.test.ts. This
 * file is not a real Redis.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV = "33333333-3333-4333-8333-333333333333";
const CONV_2 = "55555555-5555-4555-8555-555555555555";
const FOREIGN_CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = {
  id: string;
  organizationId: string;
  userId: string;
  deletedAt: Date | null;
  model: string | null;
  summary: string | null;
};

const m = vi.hoisted(() => ({
  now: new Date("2026-09-28T09:00:00Z").getTime(),
  store: new Map<string, unknown>(),
  failStore: false,
  streamClaude: vi.fn(),
  transcript: "Mitä kalenterissa on huomenna?",
  ctx: { orgId: "", userId: "", role: "OWNER", locale: "fi" },
  conversations: new Map<string, Row>(),
  /**
   * Holds requests until all have arrived: at chat input moderation (just
   * before the grant is consumed) and at the voice rate limit (just before a
   * session slot is taken).
   */
  gate: null as null | { n: number; arrived: number; open: () => void; opened: Promise<void> },
  async passGate() {
    const gate = this.gate;
    if (!gate) return;
    gate.arrived++;
    if (gate.arrived === gate.n) {
      this.gate = null;
      gate.open();
    }
    await gate.opened;
  },
}));

// ── In-memory store mirroring the Lua scripts ──
vi.mock("@/server/integrations/redis", async () => {
  const voice = await vi.importActual<typeof VoiceModule>("@/server/ai/voice-conversation");
  const s = m.store;
  const hash = (k: string) => s.get(k) as Record<string, string> | undefined;
  const num = (k: string) => Number(s.get(k) ?? 0);
  const eval_ = async (script: string, keys: string[], args: string[]): Promise<number> => {
    if (m.failStore) throw new Error("ECONNREFUSED");
    switch (script) {
      case voice.START_SESSION_SCRIPT: {
        const [sessionK, userK, activeK, audioK, turnsK, sessionsK] = keys as string[];
        const [id, org, user, now, expires, , conc, budget, turns, sessions, conv, isNew, , ns] =
          args as string[];
        const active = (s.get(activeK!) as Map<string, number>) ?? new Map<string, number>();
        for (const [sid, exp] of active) if (exp <= Number(now)) active.delete(sid);
        if (num(sessionsK!) >= Number(sessions)) return -8;
        if (num(audioK!) >= Number(budget)) return -3;
        if (num(turnsK!) >= Number(turns)) return -7;
        const prev = s.get(userK!) as string | undefined;
        const others = active.size - (prev && active.has(prev) ? 1 : 0);
        if (others >= Number(conc)) return -2;
        if (prev) {
          active.delete(prev);
          s.delete(`${ns}:session:${prev}`);
        }
        s.set(sessionsK!, num(sessionsK!) + 1);
        s.set(sessionK!, {
          org: org!,
          user: user!,
          conversation: conv!,
          newConversation: isNew!,
          expiresAt: expires!,
          turns: "0",
        });
        s.set(userK!, id);
        active.set(id!, Number(expires));
        s.set(activeK!, active);
        return 1;
      }
      case voice.RESERVE_TURN_SCRIPT: {
        const [sessionK, audioK, markerK, turnsK] = keys as string[];
        const [org, user, now, turnMs, budget, maxTurns, , , dailyTurns] = args;
        const h = hash(sessionK!);
        if (!h || h.org !== org || h.user !== user) return -1;
        if (Number(h.expiresAt) <= Number(now)) return -4;
        if (Number(h.turns) >= Number(maxTurns)) return -5;
        if (s.has(markerK!)) return -6;
        if (num(audioK!) + Number(turnMs) > Number(budget)) return -3;
        if (num(turnsK!) + 1 > Number(dailyTurns)) return -7;
        s.set(markerK!, "1");
        s.set(audioK!, num(audioK!) + Number(turnMs));
        s.set(turnsK!, num(turnsK!) + 1);
        h.turns = String(Number(h.turns) + 1);
        return num(audioK!);
      }
      case voice.ISSUE_GRANT_SCRIPT: {
        const [grantK, sessionK] = keys as string[];
        const [org, user, session, turn, text, now] = args;
        const h = hash(sessionK!);
        if (!h || h.org !== org || h.user !== user || Number(h.expiresAt) <= Number(now)) return -1;
        s.set(grantK!, {
          org: org!,
          user: user!,
          session: session!,
          turn: turn!,
          text: text!,
          conversation: h.conversation!,
          newConversation: h.newConversation!,
        });
        return 1;
      }
      case voice.CONSUME_GRANT_SCRIPT: {
        const [grantK] = keys as string[];
        const [org, user, message, now, conv, ns] = args;
        const g = hash(grantK!);
        if (!g || g.org !== org || g.user !== user) return -1;
        if (g.conversation !== conv) return -4;
        if (g.text !== message) return -2;
        const h = hash(`${ns}:session:${g.session}`);
        s.delete(grantK!);
        if (!h || Number(h.expiresAt) <= Number(now) || h.user !== user) return -3;
        return g.newConversation === "1" ? 2 : 1;
      }
      case voice.ACTIVE_SESSION_SCRIPT: {
        const id = s.get(keys[0]!) as string | undefined;
        const h = id ? hash(`${args[1]}:session:${id}`) : undefined;
        return h && Number(h.expiresAt) > Number(args[0]) ? 1 : 0;
      }
      case voice.END_SESSION_SCRIPT: {
        const [sessionK, userK, activeK] = keys as string[];
        const [id, org, user] = args;
        const h = hash(sessionK!);
        if (h && (h.org !== org || h.user !== user)) return -1;
        (s.get(activeK!) as Map<string, number> | undefined)?.delete(id!);
        if (s.get(userK!) === id) s.delete(userK!);
        if (!h) return 0;
        s.delete(sessionK!);
        return 1;
      }
    }
    throw new Error("unknown script");
  };
  return {
    redis: { eval: vi.fn(eval_) },
    limitAiVoiceTurn: vi.fn(async () => {
      await m.passGate();
      return { success: true, reset: 0, limit: 40, remaining: 39 };
    }),
    limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
  };
});

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({ ...m.ctx })),
}));
vi.mock("@/server/integrations/openai", () => ({
  transcribeAudio: vi.fn(async () => m.transcript),
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
  isFlaggedByModeration: vi.fn(async () => {
    await m.passGate();
    return false;
  }),
}));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: m.streamClaude }));
vi.mock("@/server/db/tenant", () => {
  // Organization-scoped like tenantDb: every query is limited to orgId.
  const tenantDb = vi.fn((orgId: string) => ({
    conversation: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; deletedAt: null } }) => {
          const row = m.conversations.get(where.id);
          return row &&
            row.organizationId === orgId &&
            row.userId === where.userId &&
            row.deletedAt === null
            ? { ...row }
            : null;
        },
      ),
      create: vi.fn(
        async ({ data }: { data: { id?: string; organizationId: string; userId: string } }) => {
          const id = data.id ?? crypto.randomUUID();
          if (m.conversations.has(id)) throw new Error("Unique constraint failed");
          const row: Row = {
            id,
            organizationId: data.organizationId,
            userId: data.userId,
            deletedAt: null,
            model: null,
            summary: null,
          };
          m.conversations.set(id, row);
          return { ...row };
        },
      ),
    },
  }));
  return {
    tenantDb,
    unscopedPrisma: {
      message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
      organization: {
        findUniqueOrThrow: vi.fn(async () => ({ name: "Syveka QA", settings: {} })),
      },
      conversation: { update: vi.fn(async () => ({})) },
    },
  };
});
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: vi.fn(async () => null),
}));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: vi.fn(async () => []),
  extractValidCitations: vi.fn(() => []),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => undefined),
  getMonthUsage: vi.fn(async () => 0),
  recordUsage: vi.fn(async () => undefined),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(async () => []),
  ensureConversationSummary: vi.fn(async () => null),
  generateTitle: vi.fn(async () => undefined),
  getConversationDocumentIds: vi.fn(async () => []),
}));

import {
  POST as startRoute,
  DELETE as endRoute,
} from "@/app/api/v1/ai/voice-conversation/session/route";
import { POST as turnRoute } from "@/app/api/v1/ai/voice-conversation/turn/route";
import { POST as chatRoute } from "@/app/api/v1/ai/chat/route";
import { unscopedPrisma } from "@/server/db/tenant";
import { retrieveChunks } from "@/server/ai/rag";
import { generateTitle } from "@/server/services/conversations";
import { getTenantContext } from "@/server/auth/session";

const AUDIO = new Uint8Array(
  fs.readFileSync(path.join(__dirname, "fixtures/audio/chrome-opus-2s.webm")),
);
const H = { "sec-fetch-site": "same-origin" };

const as = (orgId: string, userId: string) => {
  m.ctx = { orgId, userId, role: "OWNER", locale: "fi" };
};
async function start(conversationId?: string) {
  const res = await startRoute(
    new Request("http://x/s", {
      method: "POST",
      headers: H,
      ...(conversationId ? { body: JSON.stringify({ conversationId }) } : {}),
    }),
  );
  return { status: res.status, body: await res.json() };
}
async function turn(sessionId: string, turnId: string = crypto.randomUUID()) {
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("turnId", turnId);
  form.append("audio", new Blob([AUDIO.slice()], { type: "audio/webm" }), "t");
  const res = await turnRoute(
    new Request("http://x/t", { method: "POST", body: form, headers: H }),
  );
  return { status: res.status, body: await res.json() };
}
let inFlight = 0;
let maxInFlight = 0;

/**
 * Runs `n` requests that overlap in time. Vitest 3 can resolve *simultaneous*
 * dynamic imports of a mocked module to the real module (observed: the real
 * getTenantContext running outside a request → 401), so each request starts
 * once the previous one has finished importing (its auth call ran) — they
 * still overlap through rate limiting, moderation, the atomic store call,
 * the database and the model stream. With `gate`, all requests are held just
 * before the grant is consumed and released together, so the atomic
 * consumption really is contended. maxInFlight records the overlap.
 */
async function overlapping<T>(fns: Array<() => Promise<T>>, gate = false): Promise<T[]> {
  if (gate) {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    m.gate = { n: fns.length, arrived: 0, open, opened };
  }
  const auth = vi.mocked(getTenantContext);
  const pending: Array<Promise<T>> = [];
  for (const fn of fns) {
    const before = auth.mock.calls.length;
    pending.push(fn());
    for (let i = 0; i < 1000 && auth.mock.calls.length === before; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return Promise.all(pending);
}
async function chat(body: Record<string, unknown>) {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    return await chatOnce(body);
  } finally {
    inFlight--;
  }
}
async function chatOnce(body: Record<string, unknown>) {
  const res = await chatRoute(
    new Request("http://x/c", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: CONV, ...body }),
    }),
  );
  const text = await res.text();
  return { status: res.status, text };
}
async function end(sessionId: string) {
  return endRoute(
    new Request(`http://x/s?sessionId=${sessionId}`, { method: "DELETE", headers: H }),
  );
}
/** One spoken turn and its chat request in the session's conversation. */
async function speak(sessionId: string, conversationId: string) {
  const t = await turn(sessionId);
  return chat({ message: t.body.data.text, voiceGrant: t.body.data.grant, conversationId });
}
const addConversation = (id: string, organizationId: string, userId: string) =>
  m.conversations.set(id, {
    id,
    organizationId,
    userId,
    deletedAt: null,
    model: "claude-opus-4-8",
    summary: null,
  });
const counter = (part: string) =>
  [...m.store.entries()].find(([k]) => k.includes(part))?.[1] as number | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(m.now);
  m.store.clear();
  m.conversations.clear();
  addConversation(CONV, ORG, USER);
  addConversation(CONV_2, ORG, USER);
  addConversation(FOREIGN_CONV, OTHER_ORG, OTHER_USER);
  as(ORG, USER);
  m.failStore = false;
  m.gate = null;
  m.transcript = "Mitä kalenterissa on huomenna?";
  m.streamClaude.mockReset().mockImplementation(async ({ callbacks }) => {
    callbacks.onText("Huomenna on kaksi tapaamista.");
    return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
  });
  vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "1");
  vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", `${ORG}:${USER},${OTHER_ORG}:${OTHER_USER}`);
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("live voice: one accepted turn → at most one paid generation", () => {
  it("turn grant → exactly one chat generation, in voice mode with its bounds", async () => {
    const s = await start(CONV);
    expect(s.body.data.conversationId).toBe(CONV);
    const t = await turn(s.body.data.sessionId);
    expect(t.status).toBe(200);
    const c = await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    expect(c.status).toBe(200);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
    const call = m.streamClaude.mock.calls[0]![0];
    // Bounds: standard chat model (not the conversation's pinned Opus), short
    // output, 2 rounds, no retries, read-only tools, spoken style.
    expect(call.model).toBe("claude-sonnet-4-5");
    expect(call.maxTokens).toBe(400);
    expect(call.maxToolRounds).toBe(2);
    expect(call.maxAttempts).toBe(1);
    expect(call.tools.map((x: { name: string }) => x.name).sort()).toEqual([
      "getCalendarAvailability",
      "searchContacts",
      "searchKnowledgeBase",
    ]);
    expect(call.system).toContain("## Live voice conversation");
    expect(vi.mocked(unscopedPrisma.message.findMany).mock.calls[0]![0]).toMatchObject({
      take: 12,
    });
    expect(vi.mocked(retrieveChunks).mock.calls[0]![0]).toMatchObject({ count: 3 });
  });

  it("a replayed grant cannot create another generation", async () => {
    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    const replay = await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    expect(replay.status).toBe(409);
    expect(replay.text).toContain("voice_turn_invalid");
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
  });

  it("concurrent duplicate submissions produce exactly one generation", async () => {
    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    maxInFlight = 0;
    const results = await overlapping(
      Array.from(
        { length: 8 },
        () => () => chat({ message: t.body.data.text, voiceGrant: t.body.data.grant }),
      ),
      true,
    );
    expect(maxInFlight).toBe(8); // all eight contend for the grant at once
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
  });

  it("the grant is bound to the transcript: a different message is refused", async () => {
    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    const c = await chat({
      message: "Varaa tapaaminen ja lähetä kutsu",
      voiceGrant: t.body.data.grant,
    });
    expect(c.status).toBe(409);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("a client-supplied mode flag is not accepted (no client-controlled voice mode)", async () => {
    const c = await chat({ message: "hei", responseMode: "voice" });
    expect(c.status).toBe(400);
  });

  it("during a live session, chat without a grant is refused (can't route around voice limits)", async () => {
    const s = await start(CONV);
    const typed = await chat({ message: "Varaa tapaaminen" });
    expect(typed.status).toBe(409);
    expect(typed.text).toContain("live_voice_session_active");
    expect(m.streamClaude).not.toHaveBeenCalled();
    await end(s.body.data.sessionId);
    const after = await chat({ message: "Varaa tapaaminen" });
    expect(after.status).toBe(200);
    // Typed chat keeps its normal tools and model after the session.
    const call = m.streamClaude.mock.calls[0]![0];
    expect(call.tools.map((x: { name: string }) => x.name)).toContain("bookMeeting");
    expect(call.maxTokens).not.toBe(400);
  });

  it("ended, expired and replaced sessions can't start new live work", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_DAILY_ORG_SESSIONS", "10");
    const s1 = await start(CONV);
    const t1 = await turn(s1.body.data.sessionId);
    await end(s1.body.data.sessionId);
    const afterEnd = await chat({ message: t1.body.data.text, voiceGrant: t1.body.data.grant });
    expect(afterEnd.status).toBe(409);

    const s2 = await start(CONV);
    const t2 = await turn(s2.body.data.sessionId);
    await start(CONV); // same user, another tab: replaces s2 (slots allowing)
    const afterReplace = await chat({
      message: t2.body.data.text,
      voiceGrant: t2.body.data.grant,
    });
    expect(afterReplace.status).toBe(409);
    expect((await turn(s2.body.data.sessionId)).status).toBe(409);

    const s3 = (await start(CONV)).body.data.sessionId;
    const t3 = await turn(s3);
    vi.setSystemTime(m.now + 301_000);
    const afterExpiry = await chat({ message: t3.body.data.text, voiceGrant: t3.body.data.grant });
    expect(afterExpiry.status).toBe(409);
    expect((await turn(s3)).status).toBe(409);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("fails closed when the store is unavailable (no transcription, no generation)", async () => {
    const s = await start(CONV);
    m.failStore = true;
    expect((await turn(s.body.data.sessionId)).status).toBe(503);
    expect((await chat({ message: "x", voiceGrant: crypto.randomUUID() })).status).toBe(503);
    expect((await chat({ message: "typed" })).status).toBe(503);
    expect((await start(CONV)).status).toBe(503);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });
});

describe("live voice: sessions and grants are bound to one conversation", () => {
  it("a grant can't be used in another conversation of the same user and organization", async () => {
    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    const substituted = await chat({
      message: t.body.data.text,
      voiceGrant: t.body.data.grant,
      conversationId: CONV_2,
    });
    expect(substituted.status).toBe(409);
    expect(substituted.text).toContain("voice_turn_invalid");
    expect(m.streamClaude).not.toHaveBeenCalled();
    // The refused substitution didn't burn the grant for its own conversation.
    const own = await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    expect(own.status).toBe(200);
  });

  it("cross-tenant: another organization's conversation can't be bound, and a grant can't be used by another tenant", async () => {
    const foreign = await start(FOREIGN_CONV);
    expect(foreign.status).toBe(404);
    expect(m.store.size).toBe(0); // no slot consumed, nothing stored

    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    as(OTHER_ORG, OTHER_USER);
    const stolen = await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    expect(stolen.status).toBe(409);
    const stolenInOwnConversation = await chat({
      message: t.body.data.text,
      voiceGrant: t.body.data.grant,
      conversationId: FOREIGN_CONV,
    });
    expect(stolenInOwnConversation.status).toBe(409);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("another user in the same organization can't bind my conversation", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", `${ORG}:${USER},${ORG}:${OTHER_USER}`);
    as(ORG, OTHER_USER);
    expect((await start(CONV)).status).toBe(404);
  });

  it("concurrent replays across conversations still yield exactly one generation", async () => {
    const s = await start(CONV);
    const t = await turn(s.body.data.sessionId);
    const attempts = [CONV, CONV_2, CONV, FOREIGN_CONV, CONV, CONV];
    maxInFlight = 0;
    const results = await overlapping(
      attempts.map(
        (conversationId) => () =>
          chat({ message: t.body.data.text, voiceGrant: t.body.data.grant, conversationId }),
      ),
      true,
    );
    expect(maxInFlight).toBe(attempts.length);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
  });

  it("new chat: the server reserves the id; the first turn creates that conversation, later turns reuse it", async () => {
    const before = m.conversations.size;
    const s = await start(); // no conversation yet
    const reserved = s.body.data.conversationId as string;
    expect(reserved).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.conversations.has(reserved)).toBe(false); // nothing created until a turn

    // A grant of the new chat is usable only in the reserved conversation.
    const t1 = await turn(s.body.data.sessionId);
    const elsewhere = await chat({
      message: t1.body.data.text,
      voiceGrant: t1.body.data.grant,
      conversationId: CONV,
    });
    expect(elsewhere.status).toBe(409);

    const first = await chat({
      message: t1.body.data.text,
      voiceGrant: t1.body.data.grant,
      conversationId: reserved,
    });
    expect(first.status).toBe(200);
    expect(first.text).toContain(`"conversationId":"${reserved}"`);
    expect(m.conversations.get(reserved)).toMatchObject({ organizationId: ORG, userId: USER });
    expect(generateTitle).toHaveBeenCalledWith(reserved, m.transcript);

    const second = await speak(s.body.data.sessionId, reserved);
    expect(second.status).toBe(200);
    expect(m.conversations.size).toBe(before + 1);
    expect(generateTitle).toHaveBeenCalledTimes(1);
  });

  it("new chat ended without speaking creates no conversation", async () => {
    const before = m.conversations.size;
    const s = await start();
    await end(s.body.data.sessionId);
    expect(m.conversations.size).toBe(before);
  });
});

describe("live voice pilot limits (1 session, 10 turns, 300 s audio per org per Helsinki day)", () => {
  it("one session per day: another tab is refused without ending the first; ending early refunds nothing", async () => {
    const s1 = await start(CONV);
    expect(s1.status).toBe(200);
    const tab2 = await start(CONV);
    expect(tab2.status).toBe(429);
    expect(tab2.body.error.code).toBe("voice_daily_limit_reached");
    expect((await speak(s1.body.data.sessionId, CONV)).status).toBe(200);
    await end(s1.body.data.sessionId);
    expect((await start(CONV)).status).toBe(429);
    expect((await start()).status).toBe(429);
  });

  it("concurrent starts: exactly one succeeds", async () => {
    const results = await overlapping(
      Array.from({ length: 6 }, () => () => start(CONV)),
      true,
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 429, 429, 429, 429, 429]);
    expect(counter(":sessions:")).toBe(1);
  });

  it("10 accepted turns; the 11th is refused before transcription", async () => {
    const { transcribeAudio } = await import("@/server/integrations/openai");
    const s = await start(CONV);
    for (let i = 0; i < 10; i++) expect((await turn(s.body.data.sessionId)).status).toBe(200);
    const eleventh = await turn(s.body.data.sessionId);
    expect(eleventh.status).toBe(429);
    expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(10);
  });

  it("the daily audio budget (300 s) is shared by all sessions and never reset by a new session", async () => {
    vi.stubEnv("AI_VOICE_CONVERSATION_DAILY_ORG_SESSIONS", "5");
    vi.stubEnv("AI_VOICE_CONVERSATION_DAILY_ORG_TURNS", "2000");
    vi.stubEnv("AI_VOICE_CONVERSATION_MAX_TURNS_PER_SESSION", "200");
    const acceptedPerSession: number[] = [];
    for (let session = 0; session < 3; session++) {
      const s = await start(CONV);
      let accepted = 0;
      if (s.status === 200) {
        for (let i = 0; i < 200; i++) {
          if ((await turn(s.body.data.sessionId)).status !== 200) break;
          accepted++;
        }
        await end(s.body.data.sessionId);
      }
      acceptedPerSession.push(accepted);
    }
    const usedMs = counter(":day:")!;
    expect(usedMs).toBeLessThanOrEqual(300_000); // never over the budget
    expect(usedMs + 2_100).toBeGreaterThan(300_000); // full, up to one ~2 s turn
    // The first session used the whole day's audio; new sessions got nothing.
    expect(acceptedPerSession[0]).toBeGreaterThan(100);
    expect(acceptedPerSession.slice(1)).toEqual([0, 0]);
  });

  it("limits reset at Helsinki midnight (21:00 UTC in summer time), not before", async () => {
    vi.setSystemTime(new Date("2026-09-28T08:00:00Z")); // 11:00 Helsinki
    const s = await start(CONV);
    await end(s.body.data.sessionId);
    vi.setSystemTime(new Date("2026-09-28T20:59:59Z")); // 23:59:59 Helsinki
    expect((await start(CONV)).status).toBe(429);
    vi.setSystemTime(new Date("2026-09-28T21:00:00Z")); // 00:00:00 Helsinki
    expect((await start(CONV)).status).toBe(200);
  });

  it("a retried turn whose response was lost is refused as a duplicate, not reserved twice", async () => {
    const s = await start(CONV);
    const turnId = crypto.randomUUID();
    expect((await turn(s.body.data.sessionId, turnId)).status).toBe(200);
    const retry = await turn(s.body.data.sessionId, turnId);
    expect(retry.status).toBe(409);
    expect(counter(":turns:")).toBe(1);
  });

  it("a session can still be ended after the feature or its limits were changed", async () => {
    const s = await start(CONV);
    vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "0");
    vi.stubEnv("AI_VOICE_CONVERSATION_SESSION_SECONDS", "not-a-number");
    const res = await end(s.body.data.sessionId);
    expect(res.status).toBe(200);
    expect([...m.store.keys()].some((k) => k.includes(":session:"))).toBe(false);
  });
});
