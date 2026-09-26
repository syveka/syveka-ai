// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MAX_SILENT_LISTENS, useVoiceSession } from "@/hooks/use-voice-session";
import { VoiceError } from "@/lib/voice/speech-engine";
import { createFakeSpeechEngine } from "./fake-speech-engine";

function setup(sendTurn = vi.fn(async (_text: string) => ({ text: "Reply", error: null }))) {
  const fake = createFakeSpeechEngine();
  const onAbortTurn = vi.fn();
  const hook = renderHook(() =>
    useVoiceSession({ engine: fake.engine, lang: "fi-FI", sendTurn, onAbortTurn }),
  );
  return { fake, hook, sendTurn, onAbortTurn };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useVoiceSession", () => {
  afterEach(cleanup);

  it("runs connecting → listening → thinking → speaking → listening, hands-free", async () => {
    let finishTurn!: (v: { text: string; error: null }) => void;
    const sendTurn = vi.fn(
      () => new Promise<{ text: string; error: null }>((resolve) => (finishTurn = resolve)),
    );
    const { fake, hook } = setup(sendTurn);

    await act(async () => {
      void hook.result.current.start();
    });
    expect(fake.engine.primeAudio).toHaveBeenCalled();
    expect(fake.engine.requestMicrophone).toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    expect(fake.lastListen.lang).toBe("fi-FI");

    act(() => fake.lastListen.onInterim?.("Mitkä ovat"));
    expect(hook.result.current.interim).toBe("Mitkä ovat");

    await act(async () => fake.lastListen.resolve("Mitkä ovat aukioloajat?"));
    expect(hook.result.current.status).toBe("thinking");
    expect(sendTurn).toHaveBeenCalledWith("Mitkä ovat aukioloajat?");

    await act(async () => finishTurn({ text: "Olemme **auki** 9–17 [doc:x].", error: null }));
    expect(hook.result.current.status).toBe("speaking");
    expect(fake.lastSpeech.text).toBe("Olemme auki 9–17.");
    expect(hook.result.current.lastReply).toBe(fake.lastSpeech.text);

    await act(async () => fake.lastSpeech.resolve());
    expect(hook.result.current.status).toBe("listening");
    expect(fake.listens).toHaveLength(2);
  });

  it("reports permission_denied when the microphone is blocked and can retry", async () => {
    const { fake, hook } = setup();
    fake.denyMicrophone();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("permission_denied");
    expect(fake.engine.listen).not.toHaveBeenCalled();

    fake.allowMicrophone();
    await act(async () => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    expect(hook.result.current.error).toBeNull();
  });

  it("reports unsupported without requesting the microphone", async () => {
    const fake = createFakeSpeechEngine({ supported: false });
    const hook = renderHook(() =>
      useVoiceSession({ engine: fake.engine, lang: "en-US", sendTurn: vi.fn() }),
    );
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("unsupported");
    expect(fake.engine.requestMicrophone).not.toHaveBeenCalled();
  });

  it("mutes while listening and resumes listening on unmute", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));

    await act(async () => hook.result.current.mute());
    expect(hook.result.current.status).toBe("muted");
    expect(hook.result.current.isMuted).toBe(true);
    expect(fake.listens).toHaveLength(1);

    await act(async () => hook.result.current.unmute());
    expect(hook.result.current.status).toBe("listening");
    expect(fake.listens).toHaveLength(2);
  });

  it("muting while speaking finishes the reply, then parks muted", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hello"));
    await waitFor(() => expect(hook.result.current.status).toBe("speaking"));

    act(() => hook.result.current.mute());
    expect(hook.result.current.status).toBe("speaking");
    await act(async () => fake.lastSpeech.resolve());
    expect(hook.result.current.status).toBe("muted");
    expect(fake.listens).toHaveLength(1);
  });

  it("barge-in: interrupting a spoken reply goes straight back to listening", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hello"));
    await waitFor(() => expect(hook.result.current.status).toBe("speaking"));

    await act(async () => hook.result.current.interrupt());
    expect(hook.result.current.status).toBe("listening");
  });

  it("surfaces a chat-route error (e.g. rate limit) and recovers on retry", async () => {
    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({ text: "", error: "rate_limited" })
      .mockResolvedValue({ text: "ok", error: null });
    const { fake, hook } = setup(sendTurn);
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hello"));
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("rate_limited");
    expect(fake.engine.speak).not.toHaveBeenCalled();

    await act(async () => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
  });

  it("surfaces a recognition network drop as an error instead of hanging", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.reject(new VoiceError("network")));
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("network");
  });

  it(`auto-mutes after ${MAX_SILENT_LISTENS} silent listens instead of looping forever`, async () => {
    const { fake, hook, sendTurn } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    for (let i = 0; i < MAX_SILENT_LISTENS; i++) {
      await waitFor(() => expect(fake.listens).toHaveLength(i + 1));
      await act(async () => fake.lastListen.resolve(""));
    }
    await waitFor(() => expect(hook.result.current.status).toBe("muted"));
    expect(hook.result.current.isMuted).toBe(true);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("ending mid-turn aborts the request and ignores the late reply", async () => {
    let finishTurn!: (v: { text: string; error: null }) => void;
    const sendTurn = vi.fn(
      () => new Promise<{ text: string; error: null }>((resolve) => (finishTurn = resolve)),
    );
    const { fake, hook, onAbortTurn } = setup(sendTurn);
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hello"));
    expect(hook.result.current.status).toBe("thinking");

    act(() => hook.result.current.end());
    expect(onAbortTurn).toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.isActive).toBe(false);

    await act(async () => finishTurn({ text: "Late reply", error: null }));
    await flush();
    expect(hook.result.current.status).toBe("idle");
    expect(fake.engine.speak).not.toHaveBeenCalled();
  });

  it("ending while speaking cancels speech and stops listening", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hello"));
    await waitFor(() => expect(hook.result.current.status).toBe("speaking"));
    const speech = fake.engine.speak as ReturnType<typeof vi.fn>;
    const handle = speech.mock.results[0]!.value as { cancel: ReturnType<typeof vi.fn> };

    await act(async () => hook.result.current.end());
    expect(handle.cancel).toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    await flush();
    expect(fake.listens).toHaveLength(1);
  });

  it("can reconnect after ending (a fresh session)", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    act(() => hook.result.current.end());
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    expect(fake.engine.requestMicrophone).toHaveBeenCalledTimes(2);
  });

  it("stops the microphone and speech on unmount", async () => {
    const { fake, hook } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.status).toBe("listening"));
    const listen = fake.engine.listen as ReturnType<typeof vi.fn>;
    const handle = listen.mock.results[0]!.value as { stop: ReturnType<typeof vi.fn> };
    hook.unmount();
    expect(handle.stop).toHaveBeenCalled();
  });
});
