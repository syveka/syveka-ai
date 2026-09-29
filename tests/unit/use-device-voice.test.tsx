// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDeviceVoice } from "@/hooks/use-device-voice";

/**
 * The start dialog's voice check with a fake voice list. Android can list
 * voices late and in several updates; an early partial list must not decide
 * the answer (it would offer only text replies for the whole session).
 */
type Voice = { lang: string; localService: boolean; name: string };
let voices: Voice[];
let listeners: Array<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  voices = [];
  listeners = [];
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const voicesChanged = (next: Voice[]) =>
  act(() => {
    voices = next;
    listeners.forEach((l) => l());
  });

describe("useDeviceVoice", () => {
  it("a voice that arrives in a later update is found (partial early list)", () => {
    const { result } = renderHook(() => useDeviceVoice("fi", true));
    voicesChanged([{ lang: "en-US", localService: true, name: "en" }]);
    voicesChanged([
      { lang: "en-US", localService: true, name: "en" },
      { lang: "fi-FI", localService: true, name: "fi" },
    ]);
    expect(result.current).toBe("available");
  });

  it("voices listed only after the wait still update the answer", () => {
    const { result } = renderHook(() => useDeviceVoice("fi", true));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe("unknown");
    voicesChanged([{ lang: "fi-FI", localService: true, name: "fi" }]);
    expect(result.current).toBe("available");
  });

  it("a complete list without the language is still 'unavailable'", () => {
    voices = [{ lang: "en-US", localService: true, name: "en" }];
    const { result } = renderHook(() => useDeviceVoice("fi", true));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe("unavailable");
  });
});
