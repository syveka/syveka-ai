// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TranscriptionError, useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { FakeMediaRecorder, domError, installFakeMedia, uninstallFakeMedia } from "./fake-media";

/** Mocked microphone and transcription: lifecycle logic only, no real audio. */
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallFakeMedia();
});

function setup(transcribe = vi.fn(async () => "hello world")) {
  const media = installFakeMedia();
  const onTranscript = vi.fn();
  const hook = renderHook(() => useVoiceRecorder({ onTranscript, transcribe }));
  return { ...media, onTranscript, transcribe, hook };
}

async function record(hook: ReturnType<typeof setup>["hook"], ms = 3000) {
  await act(async () => {
    await hook.result.current.start();
  });
  now += ms;
}

describe("useVoiceRecorder lifecycle", () => {
  it("asks for the microphone only on start, records, and hands back the transcript", async () => {
    const { gum, hook, onTranscript, transcribe, streams } = setup();
    expect(gum).not.toHaveBeenCalled();
    await record(hook);
    expect(gum).toHaveBeenCalledWith({ audio: true });
    expect(hook.result.current.status).toBe("recording");
    await act(async () => hook.result.current.stop());
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("hello world");
    expect(hook.result.current.status).toBe("idle");
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
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

  it("cancel during recording discards audio and releases the microphone", async () => {
    const { hook, transcribe, onTranscript, streams } = setup();
    await record(hook);
    act(() => hook.result.current.cancel());
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
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
    await record(hook);
    await act(async () => hook.result.current.stop());
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
    await record(hook);
    await act(async () => hook.result.current.stop());
    hook.unmount();
    await act(async () => pending.resolve("late text"));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("unmount during recording stops the tracks", async () => {
    const { hook, streams } = setup();
    await record(hook);
    hook.unmount();
    expect(streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("stops automatically at the maximum duration and transcribes", async () => {
    const media = installFakeMedia();
    const transcribe = vi.fn(async () => "long message");
    const onTranscript = vi.fn();
    const hook = renderHook(() => useVoiceRecorder({ onTranscript, transcribe, maxSeconds: 5 }));
    await act(async () => {
      await hook.result.current.start();
    });
    now += 5_000;
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("long message");
    expect(media.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
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

  it("treats a very short tap as too_short and never uploads it", async () => {
    const { hook, transcribe } = setup();
    await record(hook, 200);
    await act(async () => hook.result.current.stop());
    expect(transcribe).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("too_short");
  });

  it("refuses an oversized recording client-side", async () => {
    const { hook, transcribe } = setup();
    FakeMediaRecorder.bytesPerRecording = 3 * 1024 * 1024;
    await record(hook);
    await act(async () => hook.result.current.stop());
    expect(transcribe).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("too_large");
  });

  it("surfaces provider/transport errors and an empty transcript", async () => {
    const { hook, onTranscript } = setup(
      vi.fn(async () => {
        throw new TranscriptionError("rate_limited");
      }),
    );
    await record(hook);
    await act(async () => hook.result.current.stop());
    expect(hook.result.current.error).toBe("rate_limited");

    const empty = setup(vi.fn(async () => "   "));
    await record(empty.hook);
    await act(async () => empty.hook.result.current.stop());
    expect(empty.hook.result.current.error).toBe("empty_transcript");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(empty.onTranscript).not.toHaveBeenCalled();
  });
});

describe("transcribeViaApi error mapping", () => {
  it.each([
    [401, "unauthenticated", "session_expired"],
    [403, "permission_denied", "not_allowed"],
    [503, "transcription_unavailable", "unavailable"],
    [429, "rate_limited", "rate_limited"],
    [402, "entitlement_exceeded", "quota_exceeded"],
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
