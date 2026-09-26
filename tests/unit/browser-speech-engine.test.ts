// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserSpeechEngine, speechWatchdogMs, VoiceError } from "@/lib/voice/speech-engine";

/**
 * Exercises the real browser engine against simulated platform APIs, one
 * browser profile at a time. Nothing here touches real audio.
 */

type Handler = ((event?: unknown) => void) | null;

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;
  lang = "";
  interimResults = false;
  continuous = false;
  maxAlternatives = 0;
  onresult: Handler = null;
  onerror: Handler = null;
  onend: Handler = null;
  start = vi.fn(() => {
    if (FakeRecognition.throwOnStart) {
      throw Object.assign(new Error("InvalidStateError"), { name: "InvalidStateError" });
    }
  });
  stop = vi.fn();
  abort = vi.fn(() => {
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  });
  constructor() {
    FakeRecognition.instances.push(this);
  }
  emitFinal(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript }], { isFinal: true })],
    });
  }
  emitInterim(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript }], { isFinal: false })],
    });
  }
}

class FakeUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  volume = 1;
  onend: Handler = null;
  onerror: Handler = null;
  constructor(text: string) {
    this.text = text;
  }
}

function fakeSynth() {
  const queue: FakeUtterance[] = [];
  return {
    queue,
    speak: vi.fn((u: FakeUtterance) => queue.push(u)),
    cancel: vi.fn(() => {
      const pending = queue.splice(0);
      pending.forEach((u) => u.onerror?.({ error: "canceled" }));
    }),
    getVoices: vi.fn(() => [
      { lang: "en-US", name: "English" },
      { lang: "fi-FI", name: "Satu" },
    ]),
  };
}

function install(profile: {
  recognition?: "standard" | "webkit" | "none";
  synthesis?: boolean;
  getUserMedia?: (() => Promise<unknown>) | null;
}) {
  const w = window as unknown as Record<string, unknown>;
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
  if (profile.recognition === "standard") w.SpeechRecognition = FakeRecognition;
  if (profile.recognition === "webkit") w.webkitSpeechRecognition = FakeRecognition;

  const synth = fakeSynth();
  if (profile.synthesis === false) {
    delete w.speechSynthesis;
  } else {
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  }
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);

  const gum =
    profile.getUserMedia === null
      ? undefined
      : (profile.getUserMedia ?? (async () => ({ getTracks: () => [{ stop: vi.fn() }] })));
  Object.defineProperty(navigator, "mediaDevices", {
    value: gum ? { getUserMedia: vi.fn(gum) } : undefined,
    configurable: true,
  });
  return synth;
}

function domError(name: string) {
  return Object.assign(new Error(name), { name });
}

describe("browser speech engine", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    FakeRecognition.throwOnStart = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("feature detection (fallback = disabled voice control)", () => {
    it("Chrome desktop / Android Chrome: standard or prefixed recognition + synthesis + mic", () => {
      install({ recognition: "standard" });
      expect(createBrowserSpeechEngine().isSupported()).toBe(true);
    });

    it("iOS Safari: webkit-prefixed recognition is detected", () => {
      install({ recognition: "webkit" });
      expect(createBrowserSpeechEngine().isSupported()).toBe(true);
    });

    it("Firefox: no SpeechRecognition → unsupported", () => {
      install({ recognition: "none" });
      expect(createBrowserSpeechEngine().isSupported()).toBe(false);
    });

    it("no speechSynthesis → unsupported", () => {
      install({ recognition: "standard", synthesis: false });
      expect(createBrowserSpeechEngine().isSupported()).toBe(false);
    });

    it("insecure context / no mediaDevices → unsupported", () => {
      install({ recognition: "standard", getUserMedia: null });
      expect(createBrowserSpeechEngine().isSupported()).toBe(false);
    });
  });

  describe("microphone permission", () => {
    it("releases the capture immediately once permission is granted (no audio kept)", async () => {
      const track = { stop: vi.fn() };
      install({
        recognition: "standard",
        getUserMedia: async () => ({ getTracks: () => [track] }),
      });
      await createBrowserSpeechEngine().requestMicrophone();
      expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["NotAllowedError", "permission_denied"],
      ["SecurityError", "permission_denied"],
      ["NotFoundError", "no_microphone"],
      ["OverconstrainedError", "no_microphone"],
      ["NotReadableError", "microphone_unavailable"],
      ["AbortError", "microphone_unavailable"],
      ["TypeError", "recognition_failed"],
    ])("maps %s to %s", async (name, code) => {
      install({
        recognition: "standard",
        getUserMedia: async () => {
          throw domError(name);
        },
      });
      await expect(createBrowserSpeechEngine().requestMicrophone()).rejects.toEqual(
        new VoiceError(code as never),
      );
    });
  });

  describe("recognition", () => {
    it("configures single-utterance recognition in the requested language and resolves the final transcript", async () => {
      install({ recognition: "standard" });
      const onInterim = vi.fn();
      const handle = createBrowserSpeechEngine().listen({ lang: "ar-SA", onInterim });
      const rec = FakeRecognition.instances[0]!;
      expect(rec).toMatchObject({ lang: "ar-SA", continuous: false, interimResults: true });
      expect(rec.start).toHaveBeenCalled();

      rec.emitInterim("مرحبا");
      expect(onInterim).toHaveBeenLastCalledWith("مرحبا");
      rec.emitFinal("مرحبا بك");
      rec.onend?.();
      await expect(handle.result).resolves.toBe("مرحبا بك");
    });

    it("silence (no-speech) resolves empty instead of failing", async () => {
      install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().listen({ lang: "fi-FI" });
      const rec = FakeRecognition.instances[0]!;
      rec.onerror?.({ error: "no-speech" });
      rec.onend?.();
      await expect(handle.result).resolves.toBe("");
    });

    it.each([
      ["not-allowed", "permission_denied"],
      ["service-not-allowed", "permission_denied"],
      ["audio-capture", "microphone_unavailable"],
      ["language-not-supported", "language_unsupported"],
      ["network", "network"],
      ["bad-grammar", "recognition_failed"],
    ])("recognition error %s → %s", async (error, code) => {
      install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().listen({ lang: "fi-FI" });
      const rec = FakeRecognition.instances[0]!;
      rec.onerror?.({ error });
      rec.onend?.();
      await expect(handle.result).rejects.toEqual(new VoiceError(code as never));
    });

    it("stop() (mute/end) discards any partial transcript so nothing half-heard is sent", async () => {
      install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().listen({ lang: "en-US" });
      const rec = FakeRecognition.instances[0]!;
      rec.emitFinal("please delete all my");
      handle.stop();
      expect(rec.abort).toHaveBeenCalled();
      await expect(handle.result).resolves.toBe("");
    });

    it("a start() failure (e.g. InvalidStateError) rejects as recognition_failed, not a crash", async () => {
      install({ recognition: "standard" });
      FakeRecognition.throwOnStart = true;
      const handle = createBrowserSpeechEngine().listen({ lang: "en-US" });
      await expect(handle.result).rejects.toEqual(new VoiceError("recognition_failed"));
      expect(() => handle.stop()).not.toThrow();
    });
  });

  describe("synthesis", () => {
    it("speaks in the requested language with a matching voice, in sentence-sized chunks", async () => {
      const synth = install({ recognition: "standard" });
      const long = Array(12).fill("Tämä on melko tavallinen suomenkielinen lause.").join(" ");
      const handle = createBrowserSpeechEngine().speak(long, "fi-FI");
      expect(synth.queue.length).toBeGreaterThan(1);
      for (const u of synth.queue) {
        expect(u.lang).toBe("fi-FI");
        expect(u.voice).toMatchObject({ lang: "fi-FI" });
      }
      synth.queue[synth.queue.length - 1]!.onend?.();
      await expect(handle.done).resolves.toBeUndefined();
    });

    it("interrupting (cancel) settles immediately", async () => {
      const synth = install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().speak("Hello there.", "en-US");
      handle.cancel();
      expect(synth.cancel).toHaveBeenCalled();
      await expect(handle.done).resolves.toBeUndefined();
    });

    it("a playback error (e.g. iOS autoplay block) settles instead of hanging", async () => {
      const synth = install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().speak("Hello there.", "en-US");
      synth.queue[0]!.onerror?.({ error: "not-allowed" });
      await expect(handle.done).resolves.toBeUndefined();
    });

    it("watchdog: settles even if the browser never fires onend (Chrome/Android bug)", async () => {
      vi.useFakeTimers();
      install({ recognition: "standard" });
      const text = "Hello there.";
      const handle = createBrowserSpeechEngine().speak(text, "en-US");
      let settled = false;
      void handle.done.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(speechWatchdogMs(text) - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
    });

    it("a new reply cancels the previous one, and the late cancel event can't settle the new reply", async () => {
      const synth = install({ recognition: "standard" });
      const engine = createBrowserSpeechEngine();
      const first = engine.speak("First reply.", "en-US");
      const firstQueued = [...synth.queue];
      const second = engine.speak("Second reply.", "en-US");
      await expect(first.done).resolves.toBeUndefined();
      // The first reply's utterances were cancelled...
      expect(synth.cancel).toHaveBeenCalled();
      firstQueued.forEach((u) => u.onerror?.({ error: "interrupted" }));
      // ...but the second reply is still pending until its own end event.
      let secondSettled = false;
      void second.done.then(() => (secondSettled = true));
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      synth.queue[synth.queue.length - 1]!.onend?.();
      await expect(second.done).resolves.toBeUndefined();
    });

    it("empty text speaks nothing", async () => {
      const synth = install({ recognition: "standard" });
      const handle = createBrowserSpeechEngine().speak("   ", "en-US");
      expect(synth.speak).not.toHaveBeenCalled();
      await expect(handle.done).resolves.toBeUndefined();
    });
  });
});
