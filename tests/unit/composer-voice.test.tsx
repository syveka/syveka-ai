// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Composer } from "@/components/chat/composer";
import { FakeMediaRecorder, installFakeMedia, uninstallFakeMedia } from "./fake-media";

/**
 * Real Composer + real messages. Mocked: the microphone (fake MediaRecorder)
 * and the transcription endpoint (fetch). No real audio or provider call.
 */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
type Voice = Record<
  | "record"
  | "stopRecording"
  | "cancel"
  | "transcriptAdded"
  | "recordingCancelled"
  | "dismiss"
  | "privacy",
  string
> & { errors: { rate_limited: string } };
type Messages = {
  chat: {
    placeholder: string;
    send: string;
    attachFile: string;
    useKnowledgeBase: string;
    voice: Voice;
  };
};
type Locale = "en" | "fi" | "ar";
const MESSAGES: Record<Locale, Messages> = { en: load("en"), fi: load("fi"), ar: load("ar") };

let transcript = "book a meeting tomorrow";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installFakeMedia();
  transcript = "book a meeting tomorrow";
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/v1/ai/transcribe") {
      return new Response(JSON.stringify({ data: { text: transcript } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  let t = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (t += 1500));
});
afterEach(() => {
  cleanup();
  uninstallFakeMedia();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function renderComposer(
  locale: Locale = "en",
  props: Partial<React.ComponentProps<typeof Composer>> = {},
) {
  const onSend = vi.fn();
  const onRecordingStart = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <Composer
        onSend={onSend}
        onAbort={vi.fn()}
        disabled={false}
        voiceInputEnabled
        onRecordingStart={onRecordingStart}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  const v = MESSAGES[locale].chat.voice;
  const textarea = screen.getByPlaceholderText(
    MESSAGES[locale].chat.placeholder,
  ) as HTMLTextAreaElement;
  return { onSend, onRecordingStart, v, textarea, locale };
}

async function dictate(v: Voice) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: v.record }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(v.stopRecording) }));
  });
}

describe("Composer voice input", () => {
  it("puts the transcript in the editable box and never sends it by itself", async () => {
    const { onSend, v, textarea, onRecordingStart } = renderComposer();
    await dictate(v);
    await waitFor(() => expect(textarea.value).toBe("book a meeting tomorrow"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onRecordingStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(v.transcriptAdded)).toBeTruthy();

    // The user edits, then explicitly sends: the exact edited text goes through the normal path.
    fireEvent.change(textarea, { target: { value: "book a meeting on Friday" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.chat.send }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("book a meeting on Friday", {
      useKnowledgeBase: true,
      documentIds: [],
    });
  });

  it("appends to an existing typed draft instead of overwriting it", async () => {
    const { v, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "Hi Syveka,  " } });
    await dictate(v);
    await waitFor(() => expect(textarea.value).toBe("Hi Syveka, book a meeting tomorrow"));
  });

  it("continues on a new line when the draft ends with a line break", async () => {
    const { v, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "Notes:\n" } });
    await dictate(v);
    await waitFor(() => expect(textarea.value).toBe("Notes:\nbook a meeting tomorrow"));
  });

  it("blocks Send (button and Enter) while recording, and Cancel keeps the draft", async () => {
    const { onSend, v, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "typed draft" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: v.record }));
    });
    const send = screen.getByRole("button", { name: MESSAGES.en.chat.send }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(v.cancel) }));
    expect(textarea.value).toBe("typed draft");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(v.recordingCancelled)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: MESSAGES.en.chat.send }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a localized, dismissible error and keeps typing available", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    const { v, textarea } = renderComposer("fi");
    await dictate(v);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(v.errors.rate_limited);
    expect(textarea.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: v.dismiss }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the maximum duration and privacy note while recording; timer is LTR-isolated", async () => {
    const { v } = renderComposer("ar");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: v.record }));
    });
    expect(document.body.textContent).toContain(v.privacy);
    const timer = [...document.querySelectorAll("span[dir=ltr]")].find((el) =>
      /\d:\d\d \/ 1:00/.test(el.textContent ?? ""),
    );
    expect(timer).toBeTruthy();
  });

  it("does not offer the microphone when voice input is not configured", () => {
    renderComposer("en", { voiceInputEnabled: false });
    expect(screen.queryByRole("button", { name: MESSAGES.en.chat.voice.record })).toBeNull();
  });

  it("keeps the existing attach, knowledge-base and send controls", () => {
    renderComposer();
    expect(screen.getByTitle(MESSAGES.en.chat.attachFile)).toBeTruthy();
    expect(screen.getByTitle(MESSAGES.en.chat.useKnowledgeBase)).toBeTruthy();
    expect(screen.getByRole("button", { name: MESSAGES.en.chat.send })).toBeTruthy();
  });

  it("text-only submission is unchanged", () => {
    const { onSend, textarea } = renderComposer("en", { voiceInputEnabled: false });
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello", { useKnowledgeBase: true, documentIds: [] });
    expect(textarea.value).toBe("");
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});
