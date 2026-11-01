// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useSpeechPlayback, VOICE_WAIT_MS } from "@/hooks/use-speech-playback";
import { ChatThread } from "@/components/chat/chat-thread";
import { chooseVoice, primaryLanguage } from "@/lib/voice/voices";

/**
 * Listen with a fake speechSynthesis whose voice list arrives late, in
 * several updates, or never (Android). A reply is only ever read by a voice
 * of its own language; a missing voice is reported after a bounded wait.
 */
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

class FakeUtterance {
  lang = "";
  voice: { name: string; lang: string } | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

type Voice = { lang: string; localService: boolean; name: string };
const v = (lang: string, name = lang, localService = true): Voice => ({ lang, localService, name });

let spoken: FakeUtterance[];
let voices: Voice[];
let listeners: Array<() => void>;
const synth = {
  speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
  cancel: vi.fn(),
  getVoices: () => voices,
  addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  removeEventListener: (_: string, fn: () => void) => {
    listeners = listeners.filter((l) => l !== fn);
  },
};
const voicesChanged = (next: Voice[]) =>
  act(() => {
    voices = next;
    [...listeners].forEach((l) => l());
  });
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  spoken = [];
  voices = [];
  listeners = [];
  synth.speak.mockClear();
  synth.cancel.mockClear();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ARABIC = "مرحبا، لدينا موعدان متاحان غدا في الساعة العاشرة والثانية.";
const FINNISH = "Huomenna kello kymmenen on vapaa aika. Voit varata sen chatissa, jos haluat.";
const ENGLISH = "You have two free slots tomorrow and you can book them in the chat.";

describe("chooseVoice language variants", () => {
  it("matches the primary subtag case-insensitively, with _ or -", () => {
    for (const tag of ["ar-XA", "ar_SA", "ar", "AR-eg"]) {
      expect(primaryLanguage(tag)).toBe("ar");
      expect(chooseVoice("ar", [v("fi-FI"), v(tag)] as never)).toMatchObject({ ok: true });
    }
    expect(chooseVoice("ar", [v("ar_sa")] as never)).toMatchObject({ lang: "ar-SA" });
    expect(chooseVoice("en", [v("en-GB")] as never)).toMatchObject({ lang: "en-GB" });
  });

  it("never treats another language with the same prefix as a match (fil is not fi)", () => {
    expect(chooseVoice("fi", [v("fil-PH")] as never)).toEqual({ ok: false, reason: "no_voice" });
  });

  it("prefers on-device voices, then the default region", () => {
    const pick = (list: Voice[]) => {
      const c = chooseVoice("ar", list as never);
      return c.ok ? c.voice?.name : null;
    };
    expect(pick([v("ar-SA", "remote-sa", false), v("ar-XA", "local-xa")])).toBe("local-xa");
    expect(pick([v("ar-XA", "local-xa"), v("ar-SA", "local-sa")])).toBe("local-sa");
    expect(pick([v("ar-EG", "remote-eg", false), v("ar-SA", "remote-sa", false)])).toBe(
      "remote-sa",
    );
  });
});

describe("useSpeechPlayback voice wait", () => {
  it("(a) Arabic voice present immediately: speaks at once, no loading state", () => {
    voices = [v("fi-FI"), v("ar-XA", "ar")];
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    expect(result.current.loadingId).toBeNull();
    expect(result.current.playingId).toBe("m1");
    expect(spoken[0]!.voice!.name).toBe("ar");
    expect(spoken[0]!.lang).toBe("ar-XA");
  });

  it("(b) voices arriving late via voiceschanged: loading, then speaks Arabic", () => {
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    expect(result.current.loadingId).toBe("m1");
    expect(result.current.playingId).toBeNull();
    expect(synth.speak).not.toHaveBeenCalled();
    wait(500);
    voicesChanged([v("fi-FI"), v("ar_SA", "ar")]);
    expect(result.current.loadingId).toBeNull();
    expect(result.current.playingId).toBe("m1");
    expect(spoken[0]!.voice!.name).toBe("ar");
    expect(listeners).toHaveLength(0); // the wait ended
  });

  it("(c) partial list first (fi only), then ar added: never reads Arabic with the fi voice", () => {
    voices = [v("fi-FI", "fi")];
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    expect(result.current.error).toBeNull();
    expect(result.current.loadingId).toBe("m1");
    voicesChanged([v("fi-FI", "fi"), v("en-US", "en")]);
    expect(synth.speak).not.toHaveBeenCalled();
    voicesChanged([v("fi-FI", "fi"), v("en-US", "en"), v("ar-XA", "ar")]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.voice!.name).toBe("ar");
  });

  it("(d) Arabic never available: unavailable after the bound, nothing spoken", () => {
    voices = [v("fi-FI", "fi"), v("en-US", "en")];
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    wait(VOICE_WAIT_MS - 1);
    expect(result.current.error).toBeNull();
    expect(result.current.loadingId).toBe("m1");
    wait(1);
    expect(result.current.loadingId).toBeNull();
    expect(result.current.error).toEqual({ id: "m1", code: "no_voice", language: "ar" });
    expect(synth.speak).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
    // A later list doesn't start speech the user no longer expects.
    voicesChanged([v("ar-SA")]);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("empty list throughout: unavailable after the bound, never left to the engine", () => {
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ENGLISH));
    wait(VOICE_WAIT_MS);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.error).toEqual({ id: "m1", code: "no_voice", language: "en" });
  });

  it("utterance onerror: playback_failed", () => {
    voices = [v("ar-SA")];
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    act(() => spoken[0]!.onerror?.({ error: "synthesis-failed" }));
    expect(result.current.playingId).toBeNull();
    expect(result.current.error).toEqual({ id: "m1", code: "playback_failed" });
  });

  it("stop while loading cancels the wait: a later voice doesn't start speech", () => {
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    act(() => result.current.stop());
    expect(result.current.loadingId).toBeNull();
    expect(listeners).toHaveLength(0);
    voicesChanged([v("ar-SA")]);
    wait(VOICE_WAIT_MS);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("a newer play() supersedes an older pending wait", () => {
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    act(() => result.current.play("m2", FINNISH));
    expect(result.current.loadingId).toBe("m2");
    expect(listeners).toHaveLength(1);
    voicesChanged([v("ar-SA", "ar"), v("fi-FI", "fi")]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.voice!.name).toBe("fi");
    expect(result.current.playingId).toBe("m2");
    wait(VOICE_WAIT_MS);
    expect(result.current.error).toBeNull();
  });

  it("unmount during the wait clears timers and listeners and never speaks", () => {
    const { result, unmount } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    voicesChanged([v("ar-SA")]);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("hiding the page during the wait cancels it", () => {
    const { result } = renderHook(() => useSpeechPlayback());
    act(() => result.current.play("m1", ARABIC));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(result.current.loadingId).toBeNull();
    expect(listeners).toHaveLength(0);
  });
});

describe("ChatThread Listen across interface languages", () => {
  const messages = (locale: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));

  function Thread({ reply, turn }: { reply: string; turn: string }) {
    const playback = useSpeechPlayback();
    return (
      <ChatThread
        playback={playback}
        messages={[
          { id: "u1", role: "user", content: turn },
          { id: "a1", role: "assistant", content: reply },
        ]}
      />
    );
  }
  const renderThread = (locale: string, reply: string, turn: string) => {
    Element.prototype.scrollIntoView = vi.fn();
    const msgs = messages(locale);
    render(
      <NextIntlClientProvider locale={locale} messages={msgs}>
        <Thread reply={reply} turn={turn} />
      </NextIntlClientProvider>,
    );
    return msgs.chat.voice;
  };

  it("Arabic answer, Finnish UI, voices late: preparing + Stop, then the Arabic voice", () => {
    const fi = renderThread("fi", ARABIC, "مرحبا، هل لديكم مواعيد غدا؟");
    fireEvent.click(screen.getByRole("button", { name: fi.listenLabel }));
    expect(screen.getByText(fi.preparingVoice)).toBeTruthy();
    const stopButton = screen.getByRole("button", { name: fi.stopListening });
    expect(stopButton.getAttribute("aria-busy")).toBe("true");
    voicesChanged([v("fi-FI", "fi"), v("ar-XA", "ar")]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.voice!.name).toBe("ar");
    fireEvent.click(screen.getByRole("button", { name: fi.stopListening }));
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: fi.listenLabel })).toBeTruthy();
    expect(spoken).toHaveLength(1);
  });

  it("repeated taps while loading never overlap: the second tap stops, a third restarts once", () => {
    const fi = renderThread("fi", ARABIC, "مرحبا");
    fireEvent.click(screen.getByRole("button", { name: fi.listenLabel }));
    fireEvent.click(screen.getByRole("button", { name: fi.stopListening }));
    fireEvent.click(screen.getByRole("button", { name: fi.listenLabel }));
    expect(listeners).toHaveLength(1);
    voicesChanged([v("ar-SA")]);
    expect(spoken).toHaveLength(1);
  });

  it("Arabic answer, Finnish UI, no Arabic voice: explains in Finnish, reply stays readable", () => {
    voices = [v("fi-FI", "fi"), v("en-US", "en")];
    const fi = renderThread("fi", ARABIC, "مرحبا");
    fireEvent.click(screen.getByRole("button", { name: fi.listenLabel }));
    wait(VOICE_WAIT_MS);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("arabia");
    expect(status.textContent).toContain("asetuksista");
    expect(synth.speak).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(ARABIC);
    expect(screen.getByRole("button", { name: fi.listenLabel })).toBeTruthy();
  });

  it("Finnish answer in English UI uses the Finnish voice", () => {
    voices = [v("en-US", "en"), v("fi_FI", "fi")];
    const en = renderThread("en", FINNISH, "Onko huomenna vapaita aikoja?");
    fireEvent.click(screen.getByRole("button", { name: en.listenLabel }));
    expect(spoken[0]!.voice!.name).toBe("fi");
    expect(spoken[0]!.lang).toBe("fi-FI");
  });

  it("English answer in Arabic UI uses the English voice; a missing one is named in Arabic", () => {
    voices = [v("ar-SA", "ar"), v("en-GB", "en")];
    const ar = renderThread("ar", ENGLISH, "Do you have free slots tomorrow?");
    fireEvent.click(screen.getByRole("button", { name: ar.listenLabel }));
    expect(spoken[0]!.voice!.name).toBe("en");
    cleanup();

    voices = [v("ar-SA", "ar")];
    renderThread("ar", ENGLISH, "Do you have free slots tomorrow?");
    fireEvent.click(screen.getByRole("button", { name: ar.listenLabel }));
    wait(VOICE_WAIT_MS);
    expect(screen.getByRole("status").textContent).toContain("الإنجليزية");
    expect(spoken).toHaveLength(1);
  });
});
