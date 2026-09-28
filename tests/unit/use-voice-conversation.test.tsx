// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoiceConversation } from "@/hooks/use-voice-conversation";
import {
  FakeMediaRecorder,
  installFakeMedia,
  uninstallFakeMedia,
  type FakeStream,
} from "./fake-media";

/**
 * The live conversation loop with fakes for the microphone (getUserMedia +
 * MediaRecorder), the level analyser, speech synthesis and the network.
 * Proves orchestration (turns, interruption, mute, teardown, stale callbacks),
 * not real audio: see the real-browser harness for actual media APIs.
 */
let level = 0;
let clock = 0;
const QUIET = 0.003;
const VOICE = 0.08;
const LOUD = 0.3;

class FakeAnalyser {
  fftSize = 1024;
  getFloatTimeDomainData(frame: Float32Array) {
    frame.fill(level);
  }
}
const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  closed = false;
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeUtterance {
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
let spoken: FakeUtterance[] = [];
let voices = [{ lang: "fi-FI", localService: true, name: "fi" }];
const synth = {
  speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
  cancel: vi.fn(),
  getVoices: () => voices,
};

type Call = { url: string; method: string; body?: FormData };
let calls: Call[];
let turnText: string | (() => Promise<Response>);
let sessionResponse: () => Response;

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  calls.push({ url, method, body: init?.body as FormData | undefined });
  if (url.endsWith("/session") && method === "POST") return Promise.resolve(sessionResponse());
  if (url.includes("/session?sessionId=")) {
    return Promise.resolve(new Response(JSON.stringify({ data: { ended: true } })));
  }
  if (url.endsWith("/turn")) {
    if (typeof turnText === "function") return turnText();
    // Like the server: a non-empty transcript comes with a single-use grant.
    const data = turnText.trim() ? { text: turnText, grant: GRANT } : { text: "" };
    return Promise.resolve(new Response(JSON.stringify({ data })));
  }
  return Promise.reject(new Error(`unexpected ${url}`));
}

const GRANT = "55555555-5555-4555-8555-555555555555";
const turnCalls = () => calls.filter((c) => c.url.endsWith("/turn"));
const okSession = () =>
  new Response(
    JSON.stringify({
      data: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        expiresAt: clock + 300_000,
        maxTurnSeconds: 30,
        sessionSeconds: 300,
      },
    }),
  );

async function advance(ms: number, lvl?: number) {
  if (lvl !== undefined) level = lvl;
  for (let t = 0; t < ms; t += 50) {
    clock += 50;
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
  }
}

let media: ReturnType<typeof installFakeMedia>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  level = QUIET;
  clock = 1_000_000;
  calls = [];
  spoken = [];
  voices = [{ lang: "fi-FI", localService: true, name: "fi" }];
  contexts.length = 0;
  turnText = "Mitä kalenterissa on huomenna?";
  sessionResponse = okSession;
  synth.speak.mockClear();
  synth.cancel.mockClear();
  media = installFakeMedia();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  uninstallFakeMedia();
});

function setup(reply: string | null = "Huomenna on kaksi tapaamista.", speakReplies = true) {
  const onUserTurn = vi.fn(async () => reply);
  const onAbortReply = vi.fn();
  const hook = renderHook(
    ({ locale }) =>
      useVoiceConversation({
        locale,
        onUserTurn,
        onAbortReply,
        speakReplies,
        deps: { fetch: fakeFetch as typeof fetch, now: () => clock },
      }),
    { initialProps: { locale: "fi" } },
  );
  return { hook, onUserTurn, onAbortReply };
}

async function startSession(hook: ReturnType<typeof setup>["hook"]) {
  await act(async () => {
    await hook.result.current.start();
  });
  await advance(500); // calibration
}

/** One spoken turn: speech, then enough silence to end it. */
async function speakTurn(ms = 1200) {
  await advance(ms, VOICE);
  await advance(1200, QUIET);
}

describe("useVoiceConversation", () => {
  it("runs several turns: each finished utterance is submitted exactly once and answered aloud", async () => {
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    expect(hook.result.current.phase).toBe("listening");
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);

    await speakTurn();
    expect(turnCalls()).toHaveLength(1);
    expect(onUserTurn).toHaveBeenCalledTimes(1);
    expect(onUserTurn).toHaveBeenCalledWith("Mitä kalenterissa on huomenna?", GRANT);
    expect(hook.result.current.phase).toBe("speaking");
    expect(spoken.at(-1)?.lang).toBe("fi-FI");
    expect(spoken.at(-1)?.text).toBe("Huomenna on kaksi tapaamista.");

    await act(async () => spoken.at(-1)!.onend?.());
    expect(hook.result.current.phase).toBe("listening");

    turnText = "Entä perjantaina?";
    await speakTurn();
    expect(turnCalls()).toHaveLength(2);
    expect(onUserTurn).toHaveBeenLastCalledWith("Entä perjantaina?", GRANT);
    // Each turn has its own id.
    const ids = turnCalls().map((c) => c.body!.get("turnId"));
    expect(new Set(ids).size).toBe(2);
  });

  it("does not submit silence or short noise", async () => {
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await advance(5000, QUIET);
    await advance(200, VOICE); // a click
    await advance(1500, QUIET);
    expect(turnCalls()).toHaveLength(0);
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("interrupting stops the reply for good and records the new turn once", async () => {
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await speakTurn();
    expect(hook.result.current.phase).toBe("speaking");
    const oldUtterance = spoken.at(-1)!;

    await advance(500, LOUD); // user talks over the reply
    expect(synth.cancel).toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("user_speaking");

    // The cancelled reply's late end event must not resume anything.
    await act(async () => oldUtterance.onend?.());
    expect(hook.result.current.phase).toBe("user_speaking");

    turnText = "Ei, tarkoitin torstaita.";
    await advance(600, VOICE);
    await advance(1200, QUIET);
    expect(turnCalls()).toHaveLength(2);
    expect(onUserTurn).toHaveBeenLastCalledWith("Ei, tarkoitin torstaita.", GRANT);
  });

  it("muting disables the track, drops a turn in progress and submits nothing", async () => {
    const { hook } = setup();
    await startSession(hook);
    await advance(600, VOICE); // speaking...
    act(() => hook.result.current.toggleMute());
    const stream = media.streams[0] as FakeStream;
    expect(stream.tracks[0]!.enabled).toBe(false);
    expect(hook.result.current.muted).toBe(true);
    // Nothing keeps recording while muted.
    expect(FakeMediaRecorder.instances.filter((r) => r.state === "recording")).toHaveLength(0);
    await advance(3000, VOICE);
    await advance(1500, QUIET);
    expect(turnCalls()).toHaveLength(0);

    act(() => hook.result.current.toggleMute());
    expect(stream.tracks[0]!.enabled).toBe(true);
    await speakTurn();
    expect(turnCalls()).toHaveLength(1);
  });

  it("ending releases the microphone, audio context and server session; nothing continues", async () => {
    const { hook } = setup();
    await startSession(hook);
    act(() => hook.result.current.end());
    const stream = media.streams[0] as FakeStream;
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(contexts[0]!.closed).toBe(true);
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("sessionId=11111111-1111-4111-8111-111111111111");
    expect(hook.result.current.phase).toBe("ended");

    const before = calls.length;
    await speakTurn(); // loud audio after the end
    expect(calls.length).toBe(before);
    expect(FakeMediaRecorder.instances.filter((r) => r.state === "recording")).toHaveLength(0);
    // No automatic restart.
    await advance(10_000, VOICE);
    expect(media.gum).toHaveBeenCalledTimes(1);
  });

  it("a transcript that arrives after the user ended is ignored", async () => {
    let resolveTurn!: (r: Response) => void;
    turnText = () => new Promise<Response>((r) => (resolveTurn = r));
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await speakTurn();
    expect(hook.result.current.phase).toBe("processing");
    act(() => hook.result.current.end());
    await act(async () =>
      resolveTurn(new Response(JSON.stringify({ data: { text: "late", grant: GRANT } }))),
    );
    expect(onUserTurn).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("ended");
  });

  it("ending while Syveka is thinking aborts the chat reply", async () => {
    const { hook, onAbortReply } = setup();
    let finish!: (v: string) => void;
    hook.rerender({ locale: "fi" });
    const { onUserTurn } = { onUserTurn: vi.fn(() => new Promise<string>((r) => (finish = r))) };
    const h2 = renderHook(() =>
      useVoiceConversation({
        locale: "fi",
        onUserTurn,
        onAbortReply,
        deps: { fetch: fakeFetch as typeof fetch, now: () => clock },
      }),
    );
    hook.unmount();
    await act(async () => {
      await h2.result.current.start();
    });
    await advance(500);
    await speakTurn();
    expect(h2.result.current.phase).toBe("thinking");
    act(() => h2.result.current.end());
    expect(onAbortReply).toHaveBeenCalled();
    await act(async () => finish("late reply"));
    expect(spoken.map((u) => u.text)).not.toContain("late reply");
  });

  it("ending before the connection completes never opens a session or keeps the mic", async () => {
    let grant!: (s: FakeStream) => void;
    media.gum.mockImplementation(() => new Promise((r) => (grant = r as never)));
    const { hook } = setup();
    let starting!: Promise<void>;
    act(() => {
      starting = hook.result.current.start();
    });
    expect(hook.result.current.phase).toBe("connecting");
    act(() => hook.result.current.end());
    const late = new (await import("./fake-media")).FakeStream();
    await act(async () => {
      grant(late);
      await starting;
    });
    expect(late.tracks.every((t) => t.stopped)).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(0);
  });

  it("ignores a second Start while one is starting", async () => {
    const { hook } = setup();
    await act(async () => {
      void hook.result.current.start();
      void hook.result.current.start();
    });
    expect(media.gum).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["voice_daily_limit_reached", "limit_reached"],
    ["voice_capacity_reached", "capacity_reached"],
    ["voice_conversation_unavailable", "unavailable"],
  ])("a refused session (%s) ends cleanly with %s", async (code, expected) => {
    sessionResponse = () => new Response(JSON.stringify({ error: { code } }), { status: 429 });
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.error).toBe(expected);
    expect(hook.result.current.phase).toBe("ended");
    expect((media.streams[0] as FakeStream).tracks.every((t) => t.stopped)).toBe(true);
  });

  it("a network failure on a turn ends the session without retrying the turn", async () => {
    turnText = () => Promise.reject(new TypeError("Failed to fetch"));
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await speakTurn();
    expect(turnCalls()).toHaveLength(1);
    expect(hook.result.current.error).toBe("network_error");
    expect(hook.result.current.phase).toBe("ended");
    await speakTurn();
    expect(turnCalls()).toHaveLength(1);
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("an empty transcript asks the user to repeat and keeps listening", async () => {
    turnText = "  ";
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await speakTurn();
    expect(onUserTurn).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBe("not_heard");
    expect(hook.result.current.phase).toBe("listening");
  });

  it("without a voice for the language, the reply stays text-only (no wrong-language voice)", async () => {
    voices = [{ lang: "en-US", localService: true, name: "en" }];
    const { hook } = setup();
    await startSession(hook);
    await speakTurn();
    expect(spoken).toHaveLength(0);
    expect(hook.result.current.notice).toBe("no_voice");
    expect(hook.result.current.phase).toBe("listening");
  });

  it("text-only mode (no device voice) shows replies without speaking and keeps listening", async () => {
    const { hook, onUserTurn } = setup("Huomenna on kaksi tapaamista.", false);
    await startSession(hook);
    await speakTurn();
    expect(onUserTurn).toHaveBeenCalledTimes(1);
    expect(spoken).toHaveLength(0);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("listening");
  });

  it("a transcript without a server grant is never submitted (fails closed)", async () => {
    turnText = () =>
      Promise.resolve(new Response(JSON.stringify({ data: { text: "Varaa tapaaminen" } })));
    const { hook, onUserTurn } = setup();
    await startSession(hook);
    await speakTurn();
    expect(onUserTurn).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("ended");
    expect(hook.result.current.error).toBe("unavailable");
    expect(media.streams.at(-1)!.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("ends when the page is hidden, when the language changes, and on unmount", async () => {
    const a = setup();
    await startSession(a.hook);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(a.hook.result.current.phase).toBe("ended");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    a.hook.unmount();

    const b = setup();
    await startSession(b.hook);
    b.hook.rerender({ locale: "ar" });
    expect(b.hook.result.current.phase).toBe("ended");
    b.hook.unmount();

    const c = setup();
    await startSession(c.hook);
    const stream = media.streams.at(-1) as FakeStream;
    c.hook.unmount();
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("reports elapsed and remaining session time", async () => {
    const { hook } = setup();
    await startSession(hook);
    await advance(10_000, QUIET);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(hook.result.current.remainingMs).toBeLessThanOrEqual(290_000);
  });
});
