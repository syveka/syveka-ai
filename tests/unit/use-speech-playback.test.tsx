// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { ChatThread } from "@/components/chat/chat-thread";

/** Fake speechSynthesis: records utterances; no real audio is produced. */
class FakeUtterance {
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

let spoken: FakeUtterance[];
let voices: Array<{ lang: string; localService: boolean; name: string }>;
const synth = {
  speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
  cancel: vi.fn(),
  getVoices: () => voices,
};

beforeEach(() => {
  spoken = [];
  voices = [
    { lang: "en-US", localService: true, name: "en" },
    { lang: "fi-FI", localService: false, name: "fi-remote" },
    { lang: "fi-FI", localService: true, name: "fi-local" },
  ];
  synth.speak.mockClear();
  synth.cancel.mockClear();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSpeechPlayback", () => {
  it("never plays until play() is called, then speaks cleaned text in the locale", () => {
    const { result } = renderHook(() => useSpeechPlayback("fi"));
    expect(synth.speak).not.toHaveBeenCalled();
    act(() => result.current.play("m1", "**Auki** klo 9–17 [doc:abc]"));
    expect(spoken[0]!.text).toBe("Auki klo 9–17");
    expect(spoken[0]!.lang).toBe("fi-FI");
    expect((spoken[0]!.voice as { name: string }).name).toBe("fi-local");
    expect(result.current.playingId).toBe("m1");
  });

  it("plays one reply at a time: starting another stops the first", () => {
    const { result } = renderHook(() => useSpeechPlayback("en"));
    act(() => result.current.play("m1", "First."));
    act(() => result.current.play("m2", "Second."));
    expect(synth.cancel).toHaveBeenCalled();
    expect(result.current.playingId).toBe("m2");
    // A late end event from the replaced reply must not stop the new one.
    act(() => spoken[0]!.onend?.());
    expect(result.current.playingId).toBe("m2");
    // Nor may a late engine error from the replaced reply.
    act(() => spoken[0]!.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.playingId).toBe("m2");
    expect(result.current.error).toBeNull();
  });

  it("stop() cancels speech; finishing all chunks clears the playing state", () => {
    const { result } = renderHook(() => useSpeechPlayback("en"));
    act(() => result.current.play("m1", "One."));
    act(() => result.current.stop());
    expect(result.current.playingId).toBeNull();
    act(() => result.current.play("m2", "Two."));
    act(() => spoken.at(-1)!.onend?.());
    expect(result.current.playingId).toBeNull();
  });

  it("reports no_voice instead of reading Arabic with a wrong-language voice", () => {
    const { result } = renderHook(() => useSpeechPlayback("ar"));
    act(() => result.current.play("m1", "مرحبا"));
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.error).toEqual({ id: "m1", code: "no_voice" });
  });

  it("still tries when the voice list hasn't loaded yet (lang set, engine picks)", () => {
    voices = [];
    const { result } = renderHook(() => useSpeechPlayback("ar"));
    act(() => result.current.play("m1", "مرحبا"));
    expect(spoken[0]!.lang).toBe("ar-SA");
  });

  it("reports playback_failed on an engine error, but not for our own interruption", () => {
    const { result } = renderHook(() => useSpeechPlayback("en"));
    act(() => result.current.play("m1", "Hello."));
    act(() => spoken[0]!.onerror?.({ error: "interrupted" }));
    expect(result.current.error).toBeNull();
    act(() => spoken[0]!.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.error).toEqual({ id: "m1", code: "playback_failed" });
  });

  it("is unsupported without speechSynthesis, and stops on unmount", () => {
    const { result, unmount } = renderHook(() => useSpeechPlayback("en"));
    act(() => result.current.play("m1", "Hello."));
    synth.cancel.mockClear();
    unmount();
    expect(synth.cancel).toHaveBeenCalled();

    vi.unstubAllGlobals();
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    const r2 = renderHook(() => useSpeechPlayback("en"));
    expect(r2.result.current.supported).toBe(false);
  });
});

describe("ChatThread Listen control", () => {
  const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));

  function Thread({ streaming = false }: { streaming?: boolean }) {
    const playback = useSpeechPlayback("en");
    return (
      <ChatThread
        playback={playback}
        messages={[
          { id: "u1", role: "user", content: "Hi" },
          { id: "a1", role: "assistant", content: "Hello **there**.", streaming },
          { id: "a2", role: "assistant", content: "Second reply." },
        ]}
      />
    );
  }

  it("offers Listen only on finished assistant replies, toggling to Stop", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Thread />
      </NextIntlClientProvider>,
    );
    const listen = screen.getAllByRole("button", { name: en.chat.voice.listenLabel });
    expect(listen).toHaveLength(2);
    fireEvent.click(listen[0]!);
    expect(spoken[0]!.text).toBe("Hello there.");
    expect(screen.getByRole("button", { name: en.chat.voice.stopListening })).toBeTruthy();
    // Reply text stays fully visible.
    expect(document.body.textContent).toContain("Hello **there**.");
  });

  it("hides Listen while a reply is still streaming", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Thread streaming />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole("button", { name: en.chat.voice.listenLabel })).toHaveLength(1);
  });
});
