// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TranscriptionError, useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { FakeMediaRecorder, domError, installFakeMedia, uninstallFakeMedia } from "./fake-media";

/**
 * MOCKED: microphone (fake getUserMedia/MediaRecorder), object URLs and the
 * transcription call. Lifecycle logic only; no real audio, device or provider.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let now = 1_000_000;
let createUrl: ReturnType<typeof vi.fn>;
let revokeUrl: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let n = 0;
  createUrl = vi.fn(() => `blob:recording-${++n}`);
  revokeUrl = vi.fn();
  URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeUrl as unknown as typeof URL.revokeObjectURL;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallFakeMedia();
  setVisibility("visible");
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

function setup(transcribe = vi.fn(async (_audio: Blob, _signal: AbortSignal) => "hello world")) {
  const media = installFakeMedia();
  const onTranscript = vi.fn();
  const hook = renderHook(() => useVoiceRecorder({ onTranscript, transcribe }));
  return { ...media, onTranscript, transcribe, hook };
}

type Hook = ReturnType<typeof setup>["hook"];

async function record(hook: Hook, ms = 3000) {
  await act(async () => {
    await hook.result.current.start();
  });
  now += ms;
}

async function recordAndStop(hook: Hook, ms = 3000) {
  await record(hook, ms);
  await act(async () => hook.result.current.stop());
}

describe("useVoiceRecorder lifecycle", () => {
  it("asks for the microphone only on start; Stop holds the recording for review without uploading", async () => {
    const { gum, hook, onTranscript, transcribe, streams } = setup();
    expect(gum).not.toHaveBeenCalled();
    await record(hook);
    expect(gum).toHaveBeenCalledWith({ audio: true });
    expect(hook.result.current.status).toBe("recording");
    await act(async () => hook.result.current.stop());

    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.pending).toEqual({ url: "blob:recording-1", durationMs: 3000 });
    expect(transcribe).not.toHaveBeenCalled();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);

    await act(async () => hook.result.current.transcribe());
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect((transcribe.mock.calls[0]![0] as Blob).size).toBe(FakeMediaRecorder.bytesPerRecording);
    expect(onTranscript).toHaveBeenCalledWith("hello world");
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.pending).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording-1");
  });

  it("ignores a second start while busy (no duplicate recordings)", async () => {
    const { gum, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
      void hook.result.current.start();
    });
    expect(gum).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("a double tap on Transcribe uploads once", async () => {
    const pending = deferred<string>();
    const { hook, transcribe, onTranscript } = setup(vi.fn(async () => pending.promise));
    await recordAndStop(hook);
    await act(async () => {
      void hook.result.current.transcribe();
      void hook.result.current.transcribe();
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve("once"));
    await act(async () => hook.result.current.transcribe()); // nothing left to send
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("Discard during review never uploads and frees the playback URL", async () => {
    const { hook, transcribe, onTranscript } = setup();
    await recordAndStop(hook);
    act(() => hook.result.current.discard());
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.pending).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording-1");
    await act(async () => hook.result.current.transcribe());
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("cancel during recording discards audio and releases the microphone", async () => {
    const { hook, transcribe, onTranscript, streams } = setup();
    await record(hook);
    act(() => hook.result.current.cancel());
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances[0]!.state).toBe("inactive");
    expect(hook.result.current.status).toBe("idle");
  });

  it("cancel during transcription aborts the upload and drops a late result", async () => {
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const { hook, onTranscript } = setup(
      vi.fn(async (_a: Blob, s: AbortSignal) => {
        signal = s;
        return pending.promise;
      }),
    );
    await recordAndStop(hook);
    act(() => void hook.result.current.transcribe());
    expect(hook.result.current.status).toBe("transcribing");
    act(() => hook.result.current.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve("late text"));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBeNull();
  });

  it("unmount during transcription drops a late result and frees the device", async () => {
    const pending = deferred<string>();
    const { hook, onTranscript } = setup(vi.fn(async () => pending.promise));
    await recordAndStop(hook);
    act(() => void hook.result.current.transcribe());
    hook.unmount();
    await act(async () => pending.resolve("late text"));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording-1");
  });

  it("unmount during recording stops the tracks and the recorder", async () => {
    const { hook, streams, transcribe } = setup();
    await record(hook);
    hook.unmount();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances[0]!.state).toBe("inactive");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("unmount during review revokes the playback URL and uploads nothing", async () => {
    const { hook, transcribe } = setup();
    await recordAndStop(hook);
    hook.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording-1");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("stops automatically at the maximum duration and waits for review", async () => {
    const media = installFakeMedia();
    const transcribe = vi.fn(async () => "long message");
    const hook = renderHook(() =>
      useVoiceRecorder({ onTranscript: vi.fn(), transcribe, autoStopMs: 5000 }),
    );
    await act(async () => {
      await hook.result.current.start();
    });
    now += 5_000;
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(hook.result.current.status).toBe("review");
    expect(transcribe).not.toHaveBeenCalled();
    expect(media.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("hiding the tab while recording stops the microphone and keeps the clip for review", async () => {
    const { hook, streams, transcribe } = setup();
    await record(hook);
    setVisibility("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(hook.result.current.status).toBe("review");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("hiding the tab while the permission prompt is open abandons the request", async () => {
    const gate = deferred<unknown>();
    const media = installFakeMedia(async () => {
      await gate.promise;
      return new (await import("./fake-media")).FakeStream();
    });
    const hook = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn(), transcribe: vi.fn() }));
    act(() => void hook.result.current.start());
    expect(hook.result.current.status).toBe("requesting");
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(hook.result.current.status).toBe("idle");
    await act(async () => gate.resolve(undefined));
    expect(media.gum).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("pagehide discards everything", async () => {
    const { hook, streams, transcribe } = setup();
    await record(hook);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(hook.result.current.status).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("useVoiceRecorder format negotiation", () => {
  it("prefers WebM/Opus where supported", async () => {
    const { hook } = setup();
    await record(hook);
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("falls back to MP4 (Safari) when WebM is not supported", async () => {
    const { hook } = setup();
    FakeMediaRecorder.supported = new Set(["audio/mp4"]);
    await record(hook);
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe("audio/mp4");
  });
});

describe("useVoiceRecorder errors", () => {
  it.each([
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["NotFoundError", "no_microphone"],
    ["NotReadableError", "microphone_busy"],
  ])("maps getUserMedia %s to %s", async (name, code) => {
    installFakeMedia(async () => {
      throw domError(name);
    });
    const hook = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn(), transcribe: vi.fn() }));
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.error).toBe(code);
    expect(hook.result.current.status).toBe("idle");
  });

  it("reports unsupported when the browser has no MediaRecorder", async () => {
    uninstallFakeMedia();
    const hook = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn(), transcribe: vi.fn() }));
    expect(hook.result.current.supported).toBe(false);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.error).toBe("unsupported");
  });

  it("reports unsupported_format when no recording format is supported", async () => {
    const { hook, gum } = setup();
    FakeMediaRecorder.supported = new Set();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.error).toBe("unsupported_format");
    expect(gum).not.toHaveBeenCalled();
  });

  it.each([
    ["the recorder fails", () => FakeMediaRecorder.instances[0]!.onerror?.()],
    [
      "the microphone track ends (unplugged)",
      (s: { tracks: { onended: (() => void) | null }[] }) => s.tracks[0]!.onended?.(),
    ],
  ])("an interrupted recording (%s) keeps and sends nothing", async (_label, fire) => {
    const { hook, streams, transcribe } = setup();
    await record(hook);
    act(() => fire(streams[0]!));
    expect(hook.result.current.error).toBe("interrupted");
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.pending).toBeNull();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("treats a very short tap as too_short and never uploads it", async () => {
    const { hook, transcribe } = setup();
    await recordAndStop(hook, 200);
    expect(transcribe).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("too_short");
    expect(hook.result.current.status).toBe("idle");
  });

  it("treats a near-empty (silent) clip as too_short and never uploads it", async () => {
    const { hook, transcribe } = setup();
    FakeMediaRecorder.bytesPerRecording = 100;
    await recordAndStop(hook);
    expect(transcribe).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("too_short");
  });

  it("refuses an oversized recording client-side", async () => {
    const { hook, transcribe } = setup();
    FakeMediaRecorder.bytesPerRecording = 3 * 1024 * 1024;
    await recordAndStop(hook);
    expect(transcribe).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("too_large");
  });

  it("a retryable failure keeps the recording; retry delivers the transcript exactly once", async () => {
    const transcribe = vi
      .fn<(a: Blob, s: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new TranscriptionError("transcription_failed"))
      .mockResolvedValueOnce("second try");
    const { hook, onTranscript } = setup(transcribe);
    await recordAndStop(hook);
    await act(async () => hook.result.current.transcribe());
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.error).toBe("transcription_failed");
    expect(hook.result.current.pending).not.toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();

    await act(async () => hook.result.current.transcribe());
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]![0]).toBe(transcribe.mock.calls[0]![0]); // same audio
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("second try");
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.status).toBe("idle");
  });

  it.each(["network_error", "timeout", "rate_limited", "unavailable"] as const)(
    "%s is retryable (recording kept)",
    async (code) => {
      const { hook } = setup(
        vi.fn(async () => {
          throw new TranscriptionError(code);
        }),
      );
      await recordAndStop(hook);
      await act(async () => hook.result.current.transcribe());
      expect(hook.result.current.status).toBe("review");
      expect(hook.result.current.error).toBe(code);
    },
  );

  it.each([
    "daily_limit",
    "quota_exceeded",
    "too_large",
    "unsupported_format",
    "not_allowed",
  ] as const)("%s discards the recording (retrying can't help)", async (code) => {
    const { hook } = setup(
      vi.fn(async () => {
        throw new TranscriptionError(code);
      }),
    );
    await recordAndStop(hook);
    await act(async () => hook.result.current.transcribe());
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBe(code);
    expect(hook.result.current.pending).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording-1");
  });

  it("an empty transcript is reported and never handed over", async () => {
    const { hook, onTranscript } = setup(vi.fn(async () => "   "));
    await recordAndStop(hook);
    await act(async () => hook.result.current.transcribe());
    expect(hook.result.current.error).toBe("empty_transcript");
    expect(hook.result.current.status).toBe("idle");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("works without object URLs (no playback, Transcribe still available)", async () => {
    URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
    const { hook, onTranscript } = setup();
    await recordAndStop(hook);
    expect(hook.result.current.pending).toEqual({ url: null, durationMs: 3000 });
    await act(async () => hook.result.current.transcribe());
    expect(onTranscript).toHaveBeenCalledWith("hello world");
  });
});

describe("transcribeViaApi error mapping", () => {
  it.each([
    [401, "unauthenticated", "session_expired"],
    [403, "permission_denied", "not_allowed"],
    [403, "voice_not_enabled", "unavailable"],
    [503, "transcription_unavailable", "unavailable"],
    [429, "rate_limited", "rate_limited"],
    [429, "daily_limit_reached", "daily_limit"],
    [402, "entitlement_exceeded", "quota_exceeded"],
    [413, "audio_too_large", "too_large"],
    [422, "audio_too_long", "too_large"],
    [422, "audio_too_short", "too_short"],
    [422, "empty_transcript", "empty_transcript"],
    [415, "unsupported_audio_format", "unsupported_format"],
    [504, "transcription_timeout", "timeout"],
    [502, "transcription_failed", "transcription_failed"],
  ])("HTTP %s %s -> %s", async (status, code, expected) => {
    vi.useRealTimers();
    const { transcribeViaApi } = await import("@/hooks/use-voice-recorder");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code } }), { status })),
    );
    await expect(
      transcribeViaApi(new Blob(["x"]), new AbortController().signal),
    ).rejects.toMatchObject({ code: expected });
    vi.unstubAllGlobals();
  });

  it("maps a dropped connection to network_error", async () => {
    vi.useRealTimers();
    const { transcribeViaApi } = await import("@/hooks/use-voice-recorder");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      transcribeViaApi(new Blob(["x"]), new AbortController().signal),
    ).rejects.toMatchObject({ code: "network_error" });
    vi.unstubAllGlobals();
  });
});
