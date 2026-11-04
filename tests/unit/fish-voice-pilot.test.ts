import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PILOT_LANGUAGES,
  PILOT_SCENARIOS,
  PILOT_SCRIPT,
  type PilotEvent,
} from "@/lib/voice/fish-pilot-scenarios";
import {
  selectSpeechProvider,
  FishPilotConfigError,
  resetRealTurnsForTests,
} from "@/server/voice/fish-pilot/config";
import {
  pilotBookingCountOf,
  pilotContactsOf,
  resetPilotStateForTests,
  runPilotTurn,
} from "@/server/voice/fish-pilot/conversation";
import { createFishSpeechProvider } from "@/server/voice/fish-pilot/fish-speech-provider";
import { isFishVoicePilotEnabled } from "@/server/voice/fish-pilot/gate";
import {
  createMockSpeechProvider,
  guardSpeechStream,
  SpeechError,
  type SpeechProvider,
} from "@/server/voice/fish-pilot/speech-provider";

const m = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
    }
  }
  return {
    AuthError,
    requirePermission: vi.fn(),
    rateLimitRefusal: vi.fn(),
  };
});

vi.mock("@/server/auth/session", () => ({ AuthError: m.AuthError }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));
vi.mock("@/server/security/rate-limit", () => ({ rateLimitRefusal: m.rateLimitRefusal }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = { orgId: ORG_A, userId: "22222222-2222-4222-8222-222222222222" };
const USER_B = { orgId: ORG_B, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

const FAST_GUARD = { firstChunkTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 1_000 };
const PCM_HEADERS = { "content-type": "audio/pcm" };

function turn(scenario: (typeof PILOT_SCENARIOS)[number]) {
  return { turnId: randomUUID(), language: "fi" as const, scenario };
}

function results(outcome: ReturnType<typeof runPilotTurn>) {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.toolResults.map((t) => ({ tool: t.tool, ...JSON.parse(t.result) }));
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function providerOf(chunks: Array<number[]>): SpeechProvider {
  return {
    name: "fixture",
    sampleRate: 16_000,
    syntheticTiming: true,
    async *stream() {
      for (const chunk of chunks) yield new Uint8Array(chunk);
    },
  };
}

beforeEach(() => {
  resetPilotStateForTests();
  resetRealTurnsForTests();
  m.requirePermission.mockReset().mockResolvedValue({ ...USER_A, role: "OWNER" });
  m.rateLimitRefusal.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("development-only gate", () => {
  const flag = { FISH_VOICE_PILOT_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;

  it("is on only under next dev with the explicit flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isFishVoicePilotEnabled(flag)).toBe(true);
    expect(isFishVoicePilotEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(["production", "test", "staging", ""])("is off when NODE_ENV is '%s'", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    expect(isFishVoicePilotEnabled(flag)).toBe(false);
  });

  it("is off on any Vercel deployment, even with NODE_ENV overridden", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isFishVoicePilotEnabled({ ...flag, VERCEL: "1" })).toBe(false);
    expect(isFishVoicePilotEnabled({ ...flag, VERCEL_ENV: "preview" })).toBe(false);
    expect(isFishVoicePilotEnabled({ ...flag, VERCEL_ENV: "production" })).toBe(false);
  });
});

describe("no paid call without approval", () => {
  const key = { FISH_AUDIO_API_KEY: "secret", FISH_AUDIO_VOICE_ID: "voice" };

  it("uses the mock when only a key is set", () => {
    const provider = selectSpeechProvider("none", key as unknown as NodeJS.ProcessEnv);
    expect(provider.name).toBe("mock");
    expect(provider.syntheticTiming).toBe(true);
  });

  it("refuses, rather than silently mocking, when allowed but not configured", () => {
    expect(() =>
      selectSpeechProvider("none", {
        FISH_VOICE_PILOT_ALLOW_PAID_API: "1",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(FishPilotConfigError);
  });

  it("selects Fish only with the approval flag and full configuration", () => {
    const provider = selectSpeechProvider("none", {
      ...key,
      FISH_VOICE_PILOT_ALLOW_PAID_API: "1",
    } as unknown as NodeJS.ProcessEnv);
    expect(provider.name).toBe("fish:s2.1-pro");
    expect(provider.syntheticTiming).toBe(false);
  });
});

describe("tools behind the pilot", () => {
  it("every scenario has a line in every language", () => {
    for (const scenario of PILOT_SCENARIOS) {
      for (const language of PILOT_LANGUAGES) {
        expect(PILOT_SCRIPT[scenario][language].reply.length).toBeGreaterThan(0);
        expect(PILOT_SCRIPT[scenario][language].caller.length).toBeGreaterThan(0);
      }
    }
  });

  it("runs a booking conversation across turns", () => {
    expect(results(runPilotTurn(USER_A, turn("availability")))[0]).toMatchObject({
      slots: ["12:30"],
    });
    const [contact] = results(runPilotTurn(USER_A, turn("contact")));
    expect(pilotContactsOf(ORG_A).has(contact.id)).toBe(true);
    expect(results(runPilotTurn(USER_A, turn("booking")))[0]).toMatchObject({ booked: true });
    expect(pilotBookingCountOf(ORG_A)).toBe(1);
  });

  it("refuses malicious tool arguments and never acts for a tenant named in them", () => {
    const outcome = results(runPilotTurn(USER_A, turn("malicious_tool_args")));
    expect(outcome).toEqual([
      // orgId/organizationId in the arguments are dropped: the booking lands in the caller's org.
      { tool: "bookMeeting", booked: true, mock: true },
      { tool: "bookMeeting", error: "invalid_input", fields: ["title", "startsAt"] },
      { tool: "bookMeeting", error: "invalid_arguments" },
      { tool: "bookMeeting", error: "invalid_arguments" },
      { tool: "createContact", error: "invalid_input", fields: ["firstName"] },
      { tool: "searchContacts", error: "tool_not_enabled" },
      { tool: "deleteEverything", error: "tool_not_enabled" },
    ]);
    expect(pilotBookingCountOf(ORG_A)).toBe(1);
    expect(pilotBookingCountOf(ORG_B)).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("xxxxx");
  });

  it("caps writes for the identity's call; a new turn id can't get around the cap", () => {
    const booked = [1, 2, 3].map(() => results(runPilotTurn(USER_A, turn("booking")))[0]);
    expect(booked[0]).toMatchObject({ booked: true });
    expect(booked[1]).toMatchObject({ booked: true });
    expect(booked[2]).toMatchObject({ error: "call_write_limit" });
    expect(pilotBookingCountOf(ORG_A)).toBe(2);
  });

  it("does not repeat a replayed turn, even after the call has expired", () => {
    const input = turn("booking");
    const now = Date.now();
    expect(runPilotTurn(USER_A, input, { now }).ok).toBe(true);
    expect(runPilotTurn(USER_A, input, { now })).toEqual({ ok: false, code: "duplicate_turn" });
    const afterCallExpired = now + 31 * 60 * 1000;
    expect(runPilotTurn(USER_A, input, { now: afterCallExpired })).toEqual({
      ok: false,
      code: "duplicate_turn",
    });
    expect(pilotBookingCountOf(ORG_A)).toBe(1);
  });

  it("starts a fresh call with fresh caps after expiry", () => {
    const now = Date.now();
    runPilotTurn(USER_A, turn("booking"), { now });
    runPilotTurn(USER_A, turn("booking"), { now });
    const later = runPilotTurn(USER_A, turn("booking"), { now: now + 31 * 60 * 1000 });
    expect(results(later)[0]).toMatchObject({ booked: true });
  });

  it("bounds the turns of a call", () => {
    for (let i = 0; i < 40; i++) runPilotTurn(USER_A, turn("greeting"));
    expect(runPilotTurn(USER_A, turn("greeting"))).toEqual({ ok: false, code: "turn_limit" });
  });

  it("bounds the number of concurrent calls", () => {
    for (let i = 0; i < 100; i++) {
      runPilotTurn({ orgId: ORG_A, userId: randomUUID() }, turn("greeting"));
    }
    expect(runPilotTurn(USER_B, turn("greeting"))).toEqual({ ok: false, code: "session_limit" });
  });
});

describe("tenant isolation", () => {
  it("never finds another organization's contact", () => {
    const [contact] = results(runPilotTurn(USER_A, turn("contact")));
    const outcome = runPilotTurn(USER_B, turn("foreign_contact"), { foreignContactId: contact.id });
    expect(results(outcome)[0]).toMatchObject({ error: "contact_not_found" });
    const own = runPilotTurn(USER_A, turn("foreign_contact"), { foreignContactId: contact.id });
    expect(results(own)[0]).toMatchObject({ logged: true });
  });

  it("keeps calls, caps and turn ids separate between organizations and members", () => {
    const shared = turn("booking");
    expect(runPilotTurn(USER_A, shared).ok).toBe(true);
    // The same turn id from another identity is that identity's own first turn.
    expect(runPilotTurn(USER_B, shared).ok).toBe(true);
    expect(pilotBookingCountOf(ORG_A)).toBe(1);
    expect(pilotBookingCountOf(ORG_B)).toBe(1);
    const colleague = { ...USER_A, userId: "33333333-3333-4333-8333-333333333333" };
    expect(runPilotTurn(colleague, shared).ok).toBe(true);
  });

  it("does not reuse another organization's contact for its booking", () => {
    runPilotTurn(USER_A, turn("contact"));
    const booking = results(runPilotTurn(USER_B, turn("booking")));
    expect(booking[0]).toMatchObject({ booked: true });
    expect(pilotContactsOf(ORG_B).size).toBe(0);
    expect(pilotContactsOf(ORG_A).size).toBe(1);
  });
});

describe("speech stream guard", () => {
  const request = { text: "Hei", language: "fi" as const };
  const never = new AbortController().signal;

  it("streams audio from the mock", async () => {
    const chunks = await collect(
      guardSpeechStream(
        createMockSpeechProvider({ firstChunkDelayMs: 0, chunkDelayMs: 0 }),
        request,
        never,
      ),
    );
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
  });

  it("keeps samples whole when the network splits one across chunks", async () => {
    const chunks = await collect(
      guardSpeechStream(providerOf([[1, 2, 3], [4], [5, 6]]), request, never),
    );
    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("drops a trailing half sample", async () => {
    const chunks = await collect(guardSpeechStream(providerOf([[1, 2, 3]]), request, never));
    expect(chunks.map((c) => [...c])).toEqual([[1, 2]]);
  });

  it.each([
    ["stall", "provider_timeout"],
    ["provider_error", "provider_failed"],
    ["malformed_audio", "malformed_audio"],
  ] as const)("reports the %s failure as %s", async (failure, code) => {
    const provider = createMockSpeechProvider({ failure, firstChunkDelayMs: 0 });
    await expect(
      collect(guardSpeechStream(provider, request, never, FAST_GUARD)),
    ).rejects.toMatchObject({ code });
  });

  it("delivers the audio before a mid-stream failure, then reports it", async () => {
    const provider = createMockSpeechProvider({
      failure: "mid_stream",
      firstChunkDelayMs: 0,
      chunkDelayMs: 0,
    });
    const got: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const c of guardSpeechStream(provider, request, never)) got.push(c);
      })(),
    ).rejects.toMatchObject({ code: "provider_failed" });
    expect(got.length).toBe(2);
  });

  function dripping(chunk: number[], everyMs: number): SpeechProvider {
    return {
      ...providerOf([]),
      async *stream({ signal }) {
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, everyMs));
          yield new Uint8Array(chunk);
        }
      },
    };
  }

  it("a provider dripping samples can't outlive the overall deadline", async () => {
    await expect(
      collect(
        guardSpeechStream(dripping([1, 2], 10), request, never, {
          firstChunkTimeoutMs: 100,
          idleTimeoutMs: 100,
          totalTimeoutMs: 80,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("empty chunks can't extend the wait for the first audio", async () => {
    await expect(
      collect(
        guardSpeechStream(dripping([], 10), request, never, {
          firstChunkTimeoutMs: 60,
          idleTimeoutMs: 1_000,
          totalTimeoutMs: 1_000,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("does not leak an unexpected provider error's text", async () => {
    const provider: SpeechProvider = {
      ...providerOf([]),
      async *stream() {
        throw new Error("secret-token-in-provider-error");
      },
    };
    const failure = await collect(guardSpeechStream(provider, request, never)).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SpeechError);
    expect((failure as Error).message).toBe("provider_failed");
  });

  it("stops the provider promptly on barge-in, even when it is stalled", async () => {
    const abort = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const provider: SpeechProvider = {
      ...providerOf([]),
      async *stream({ signal }) {
        providerSignal = signal;
        yield new Uint8Array([1, 2]);
        await new Promise(() => undefined);
      },
    };
    const guard = guardSpeechStream(provider, request, abort.signal);
    await guard.next();
    const startedAt = performance.now();
    const pending = guard.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "interrupted" });
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("adds no abort listener per mock chunk", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    await collect(
      guardSpeechStream(
        createMockSpeechProvider({ firstChunkDelayMs: 0, chunkDelayMs: 0 }),
        { text: "x".repeat(60), language: "fi" },
        never,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    process.off("warning", onWarning);
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });
});

describe("Fish adapter (fetch mocked; never reaches the network)", () => {
  const config = { apiKey: "fish-secret-key", voiceId: "voice-1", model: "s2.1-pro" };
  const request = { text: "Hei", language: "fi" as const };
  const run = () =>
    collect(
      guardSpeechStream(createFishSpeechProvider(config), request, new AbortController().signal),
    );

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the documented request and streams the body", async () => {
    const fetchMock = stubFetch(
      new Response(new Uint8Array([1, 2, 3, 4]), { headers: PCM_HEADERS }),
    );
    expect((await run()).map((c) => [...c])).toEqual([[1, 2, 3, 4]]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer fish-secret-key",
      model: "s2.1-pro",
    });
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hei",
      reference_id: "voice-1",
      language: "fi",
      format: "pcm",
      sample_rate: 16_000,
      latency: "balanced",
    });
  });

  it.each([401, 402, 429, 503])("turns HTTP %i into a stable code, without the body", async (s) => {
    stubFetch(new Response(JSON.stringify({ message: "fish-secret-key rejected" }), { status: s }));
    const failure = await run().catch((e: unknown) => e as Error);
    expect(failure).toMatchObject({ code: "provider_failed" });
    expect((failure as Error).message).not.toContain("secret");
  });

  it.each(["application/json", "application/xml", "text/html", ""])(
    "refuses a 200 of type '%s' rather than playing it as audio",
    async (contentType) => {
      const body = new Blob(["<error>gateway</error>"]).stream();
      stubFetch(
        new Response(body, { headers: contentType ? { "content-type": contentType } : {} }),
      );
      await expect(run()).rejects.toMatchObject({ code: "malformed_audio" });
    },
  );
});

describe("turn route", () => {
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/v1/dev/fish-voice-pilot/turn/route");
    return POST(
      new Request("http://localhost/api/v1/dev/fish-voice-pilot/turn", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  async function events(response: Response): Promise<PilotEvent[]> {
    const text = await response.text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PilotEvent);
  }

  function enablePilot() {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("FISH_VOICE_PILOT_ENABLED", "1");
    vi.stubEnv("FISH_VOICE_PILOT_ALLOW_PAID_API", "");
  }

  function enableRealCalls() {
    enablePilot();
    vi.stubEnv("FISH_VOICE_PILOT_ALLOW_PAID_API", "1");
    vi.stubEnv("FISH_AUDIO_API_KEY", "fish-secret-key");
    vi.stubEnv("FISH_AUDIO_VOICE_ID", "voice-1");
  }

  it.each([
    ["NODE_ENV", "production"],
    ["NODE_ENV", "test"],
    ["VERCEL_ENV", "preview"],
    ["VERCEL", "1"],
  ])("is a 404 before any auth with %s=%s", async (name, value) => {
    enablePilot();
    vi.stubEnv(name, value);
    expect((await post(turn("greeting"))).status).toBe(404);
    expect(m.requirePermission).not.toHaveBeenCalled();
  });

  it("refuses cross-origin requests, the unauthenticated and the unauthorized", async () => {
    enablePilot();
    expect((await post(turn("greeting"), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    m.requirePermission.mockRejectedValueOnce(new m.AuthError("no", 401));
    expect((await post(turn("greeting"))).status).toBe(401);
    m.requirePermission.mockRejectedValueOnce(new m.AuthError("no", 403));
    expect((await post(turn("greeting"))).status).toBe(403);
    expect(m.requirePermission).toHaveBeenCalledWith("voice:configure");
  });

  it("uses the live-voice limiter and returns its refusal", async () => {
    enablePilot();
    m.rateLimitRefusal.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await post(turn("greeting"))).status).toBe(429);
    expect(m.rateLimitRefusal).toHaveBeenCalledWith("aiVoiceTurnUser", `${ORG_A}:${USER_A.userId}`);
  });

  it("refuses a client-supplied tenant and malformed input", async () => {
    enablePilot();
    expect((await post({ ...turn("greeting"), orgId: ORG_B })).status).toBe(400);
    expect((await post({ ...turn("greeting"), sessionId: randomUUID() })).status).toBe(400);
    expect((await post({ ...turn("greeting"), language: "sv" })).status).toBe(400);
    expect((await post({ turnId: "not-a-uuid" })).status).toBe(400);
  });

  it("refuses a replayed turn with 409", async () => {
    enablePilot();
    const input = turn("booking");
    await (await post(input)).text();
    expect((await post(input)).status).toBe(409);
    expect(pilotBookingCountOf(ORG_A)).toBe(1);
  });

  it("isolates tenants through the route, by the verified session alone", async () => {
    enablePilot();
    await (await post(turn("contact"))).text();
    m.requirePermission.mockResolvedValue({ ...USER_B, role: "OWNER" });
    await (await post(turn("booking"))).text();
    expect(pilotContactsOf(ORG_A).size).toBe(1);
    expect(pilotBookingCountOf(ORG_A)).toBe(0);
    expect(pilotContactsOf(ORG_B).size).toBe(0);
    expect(pilotBookingCountOf(ORG_B)).toBe(1);
  });

  it.each(PILOT_LANGUAGES)("plays a whole %s turn from the mock", async (language) => {
    enablePilot();
    const response = await post({ ...turn("booking"), language });
    const all = await events(response);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(all[0]).toMatchObject({ type: "reply", text: PILOT_SCRIPT.booking[language].reply });
    expect(all.filter((e) => e.type === "audio").length).toBeGreaterThan(0);
    const done = all.at(-1);
    expect(done).toMatchObject({ type: "done", provider: "mock", syntheticTiming: true });
  });

  it("makes no network call in mock mode, and reports a failure as a code", async () => {
    enablePilot();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const all = await events(await post({ ...turn("greeting"), mockFailure: "provider_error" }));
    expect(all[0]).toMatchObject({ type: "reply" });
    expect(all.at(-1)).toEqual({ type: "error", code: "provider_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the audio before a mid-stream failure, then the error", async () => {
    enablePilot();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const all = await events(await post({ ...turn("greeting"), mockFailure: "mid_stream" }));
    expect(all.map((e) => e.type)).toEqual(["reply", "audio", "audio", "error"]);
  });

  it("answers 503 when real calls are allowed but not configured", async () => {
    enablePilot();
    vi.stubEnv("FISH_VOICE_PILOT_ALLOW_PAID_API", "1");
    vi.stubEnv("FISH_AUDIO_API_KEY", "");
    const response = await post(turn("greeting"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "fish_pilot_not_configured" } });
  });

  describe("with real calls allowed (fetch mocked)", () => {
    it("streams Fish audio, labelled as real timing, without exposing the key", async () => {
      enableRealCalls();
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { headers: PCM_HEADERS }));
      vi.stubGlobal("fetch", fetchMock);
      const response = await post(turn("greeting"));
      const text = await response.clone().text();
      expect(text).not.toContain("fish-secret-key");
      expect((await events(response)).at(-1)).toMatchObject({
        type: "done",
        provider: "fish:s2.1-pro",
        syntheticTiming: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps a provider error, key included, away from the browser and the logs", async () => {
      enableRealCalls();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("bad key fish-secret-key", { status: 401 })),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const text = await (await post(turn("greeting"))).text();
      expect(text).toContain('"code":"provider_failed"');
      expect(text).not.toContain("fish-secret-key");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("fish-secret-key");
    });

    it("refuses a failure test rather than making a real call", async () => {
      enableRealCalls();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const response = await post({ ...turn("greeting"), mockFailure: "stall" });
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not call Fish for a replayed turn", async () => {
      enableRealCalls();
      const fetchMock = vi.fn(
        async () => new Response(new Uint8Array([1, 2]), { headers: PCM_HEADERS }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const input = turn("greeting");
      await (await post(input)).text();
      expect((await post(input)).status).toBe(409);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops at the per-process budget of real calls", async () => {
      enableRealCalls();
      resetPilotStateForTests();
      const fetchMock = vi.fn(
        async () => new Response(new Uint8Array([1, 2]), { headers: PCM_HEADERS }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { reserveRealTurn } = await import("@/server/voice/fish-pilot/config");
      for (let i = 0; i < 100; i++) reserveRealTurn();
      const response = await post(turn("greeting"));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: { code: "real_turn_budget_used" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("aborts the provider request when the client disconnects", async () => {
      enableRealCalls();
      let providerSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          providerSignal = init.signal ?? undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
          });
          return new Response(body, { headers: PCM_HEADERS });
        }),
      );
      const response = await post(turn("greeting"));
      const reader = response.body!.getReader();
      await reader.read(); // reply
      await reader.read(); // audio
      expect(providerSignal?.aborted).toBe(false);
      await reader.cancel();
      expect(providerSignal?.aborted).toBe(true);
    });

    it("closes the stream when the request itself is aborted", async () => {
      enableRealCalls();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
          });
          return new Response(body, { headers: PCM_HEADERS });
        }),
      );
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { POST } = await import("@/app/api/v1/dev/fish-voice-pilot/turn/route");
      const abort = new AbortController();
      const response = await POST(
        new Request("http://localhost/api/v1/dev/fish-voice-pilot/turn", {
          method: "POST",
          body: JSON.stringify(turn("greeting")),
          signal: abort.signal,
        }),
      );
      setTimeout(() => abort.abort(), 20);
      const text = await response.text();
      expect(text).toContain('"code":"interrupted"');
    });
  });
});
