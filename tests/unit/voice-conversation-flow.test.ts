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
 * the Anthropic stream, the database, billing, conversation services.
 *
 * Redis: the scripts run against an in-memory emulator that mirrors their
 * semantics (below). The Lua scripts themselves were executed in real Lua
 * (fakeredis) with the same scenarios — see the PR. This is not a real Redis.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  now: new Date("2026-09-28T09:00:00Z").getTime(),
  store: new Map<string, unknown>(),
  failStore: false,
  streamClaude: vi.fn(),
  transcript: "Mitä kalenterissa on huomenna?",
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
        const [sessionK, userK, activeK, audioK, turnsK] = keys as [
          string,
          string,
          string,
          string,
          string,
        ];
        const [id, org, user, now, expires, , conc, budget, turns] = args;
        const active = (s.get(activeK) as Map<string, number>) ?? new Map<string, number>();
        for (const [sid, exp] of active) if (exp <= Number(now)) active.delete(sid);
        const prev = s.get(userK) as string | undefined;
        if (prev) {
          active.delete(prev);
          s.delete(`voice:conv:session:${prev}`);
        }
        if (active.size >= Number(conc)) return -2;
        if (num(audioK) >= Number(budget)) return -3;
        if (num(turnsK) >= Number(turns)) return -7;
        s.set(sessionK, { org: org!, user: user!, expiresAt: expires!, turns: "0" });
        s.set(userK, id);
        active.set(id!, Number(expires));
        s.set(activeK, active);
        return 1;
      }
      case voice.RESERVE_TURN_SCRIPT: {
        const [sessionK, audioK, markerK, turnsK] = keys as [string, string, string, string];
        const [org, user, now, turnMs, budget, maxTurns, , , dailyTurns] = args;
        const h = hash(sessionK);
        if (!h || h.org !== org || h.user !== user) return -1;
        if (Number(h.expiresAt) <= Number(now)) return -4;
        if (Number(h.turns) >= Number(maxTurns)) return -5;
        if (s.has(markerK)) return -6;
        if (num(audioK) + Number(turnMs) > Number(budget)) return -3;
        if (num(turnsK) + 1 > Number(dailyTurns)) return -7;
        s.set(markerK, "1");
        s.set(audioK, num(audioK) + Number(turnMs));
        s.set(turnsK, num(turnsK) + 1);
        h.turns = String(Number(h.turns) + 1);
        return num(audioK);
      }
      case voice.ISSUE_GRANT_SCRIPT: {
        const [grantK, sessionK] = keys as [string, string];
        const [org, user, session, turn, text, now] = args;
        const h = hash(sessionK);
        if (!h || h.org !== org || h.user !== user || Number(h.expiresAt) <= Number(now)) return -1;
        s.set(grantK, { org: org!, user: user!, session: session!, turn: turn!, text: text! });
        return 1;
      }
      case voice.CONSUME_GRANT_SCRIPT: {
        const [grantK] = keys as [string];
        const [org, user, message, now] = args;
        const g = hash(grantK);
        if (!g || g.org !== org || g.user !== user) return -1;
        if (g.text !== message) return -2;
        const h = hash(`voice:conv:session:${g.session}`);
        s.delete(grantK);
        if (!h || Number(h.expiresAt) <= Number(now) || h.user !== user) return -3;
        return 1;
      }
      case voice.ACTIVE_SESSION_SCRIPT: {
        const id = s.get(keys[0]!) as string | undefined;
        const h = id ? hash(`voice:conv:session:${id}`) : undefined;
        return h && Number(h.expiresAt) > Number(args[0]) ? 1 : 0;
      }
      case voice.END_SESSION_SCRIPT: {
        const [sessionK, userK, activeK] = keys as [string, string, string];
        const [id, org, user] = args;
        const h = hash(sessionK);
        if (h && (h.org !== org || h.user !== user)) return -1;
        (s.get(activeK) as Map<string, number> | undefined)?.delete(id!);
        if (s.get(userK) === id) s.delete(userK);
        if (!h) return 0;
        s.delete(sessionK);
        return 1;
      }
    }
    throw new Error("unknown script");
  };
  return {
    redis: { eval: vi.fn(eval_) },
    limitAiVoiceTurn: vi.fn(async () => ({ success: true, reset: 0, limit: 40, remaining: 39 })),
    limitAiChat: vi.fn(async () => ({ success: true, reset: 0, limit: 30, remaining: 29 })),
  };
});

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({ orgId: ORG, userId: USER, role: "OWNER", locale: "fi" })),
}));
vi.mock("@/server/integrations/openai", () => ({
  transcribeAudio: vi.fn(async () => m.transcript),
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
  isFlaggedByModeration: vi.fn(async () => false),
}));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: m.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    conversation: {
      findFirst: vi.fn(async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        model: "claude-opus-4-8",
      })),
      create: vi.fn(),
    },
  })),
  unscopedPrisma: {
    message: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    organization: { findUniqueOrThrow: vi.fn(async () => ({ name: "Syveka QA", settings: {} })) },
    conversation: { update: vi.fn(async () => ({})) },
  },
}));
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

const AUDIO = new Uint8Array(
  fs.readFileSync(path.join(__dirname, "fixtures/audio/chrome-opus-2s.webm")),
);
const H = { "sec-fetch-site": "same-origin" };

async function start() {
  const res = await startRoute(new Request("http://x/s", { method: "POST", headers: H }));
  return { status: res.status, body: await res.json() };
}
async function turn(sessionId: string) {
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("turnId", crypto.randomUUID());
  form.append("audio", new Blob([AUDIO.slice()], { type: "audio/webm" }), "t");
  const res = await turnRoute(
    new Request("http://x/t", { method: "POST", body: form, headers: H }),
  );
  return { status: res.status, body: await res.json() };
}
async function chat(body: Record<string, unknown>) {
  const res = await chatRoute(
    new Request("http://x/c", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "33333333-3333-4333-8333-333333333333", ...body }),
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(m.now);
  m.store.clear();
  m.failStore = false;
  m.transcript = "Mitä kalenterissa on huomenna?";
  m.streamClaude.mockReset().mockImplementation(async ({ callbacks }) => {
    callbacks.onText("Huomenna on kaksi tapaamista.");
    return { tokensIn: 10, tokensOut: 5, stopReason: "end_turn" };
  });
  vi.stubEnv("AI_VOICE_CONVERSATION_ENABLED", "1");
  vi.stubEnv("AI_VOICE_CONVERSATION_PILOT_ALLOWLIST", `${ORG}:${USER}`);
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
    const s = await start();
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
    const s = await start();
    const t = await turn(s.body.data.sessionId);
    await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    const replay = await chat({ message: t.body.data.text, voiceGrant: t.body.data.grant });
    expect(replay.status).toBe(409);
    expect(replay.text).toContain("voice_turn_invalid");
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
  });

  it("concurrent duplicate submissions produce exactly one generation", async () => {
    const s = await start();
    const t = await turn(s.body.data.sessionId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        chat({ message: t.body.data.text, voiceGrant: t.body.data.grant }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(m.streamClaude).toHaveBeenCalledTimes(1);
  });

  it("the grant is bound to the transcript: a different message is refused", async () => {
    const s = await start();
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
    const s = await start();
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
    const s1 = await start();
    const t1 = await turn(s1.body.data.sessionId);
    await end(s1.body.data.sessionId);
    expect(
      (await chat({ message: t1.body.data.text, voiceGrant: t1.body.data.grant })).status,
    ).toBe(409);

    const s2 = await start();
    const t2 = await turn(s2.body.data.sessionId);
    await start(); // same user, another tab: replaces s2
    expect(
      (await chat({ message: t2.body.data.text, voiceGrant: t2.body.data.grant })).status,
    ).toBe(409);
    expect((await turn(s2.body.data.sessionId)).status).toBe(409);

    const s3 = (await start()).body.data.sessionId;
    const t3 = await turn(s3);
    vi.setSystemTime(m.now + 301_000);
    expect(
      (await chat({ message: t3.body.data.text, voiceGrant: t3.body.data.grant })).status,
    ).toBe(409);
    expect((await turn(s3)).status).toBe(409);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });

  it("the daily turn limit (30) spans repeated sessions and resets at Helsinki midnight", async () => {
    vi.setSystemTime(new Date("2026-09-28T08:00:00Z")); // 11:00 Helsinki
    let accepted = 0;
    let refusedStart = 0;
    for (let session = 0; session < 5; session++) {
      const s = await start();
      if (s.status !== 200) {
        refusedStart++;
        continue;
      }
      for (let i = 0; i < 10; i++)
        if ((await turn(s.body.data.sessionId)).status === 200) accepted++;
      await end(s.body.data.sessionId);
    }
    expect(accepted).toBe(30);
    expect(refusedStart).toBeGreaterThan(0);
    // 23:59:59 Helsinki (EEST) is still the same day…
    vi.setSystemTime(new Date("2026-09-28T20:59:59Z"));
    expect((await start()).status).toBe(429);
    // …00:00:00 Helsinki (21:00 UTC) starts a new day.
    vi.setSystemTime(new Date("2026-09-28T21:00:00Z"));
    expect((await start()).status).toBe(200);
  });

  it("fails closed when the store is unavailable (no transcription, no generation)", async () => {
    const s = await start();
    m.failStore = true;
    expect((await turn(s.body.data.sessionId)).status).toBe(503);
    expect((await chat({ message: "x", voiceGrant: crypto.randomUUID() })).status).toBe(503);
    expect((await chat({ message: "typed" })).status).toBe(503);
    expect(m.streamClaude).not.toHaveBeenCalled();
  });
});
