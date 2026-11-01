// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Composer } from "@/components/chat/composer";
import { FakeMediaRecorder, domError, installFakeMedia, uninstallFakeMedia } from "./fake-media";

/**
 * Real Composer + real messages. MOCKED: the microphone (fake
 * getUserMedia/MediaRecorder producing synthetic audio Blobs), object URLs and
 * the transcription endpoint (fetch). No real audio, device or provider call.
 */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
type Voice = Record<
  | "record"
  | "stop"
  | "cancel"
  | "transcribe"
  | "discard"
  | "reviewTitle"
  | "playbackLabel"
  | "transcriptAdded"
  | "recordingCancelled"
  | "recordingDiscarded"
  | "dismiss"
  | "privacyNote"
  | "retryHint",
  string
> & { errors: Record<string, string> };
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
let revokeUrl: ReturnType<typeof vi.fn>;

const transcribeCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url === "/api/v1/ai/transcribe").length;

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
  URL.createObjectURL = vi.fn(() => "blob:recording") as unknown as typeof URL.createObjectURL;
  revokeUrl = vi.fn();
  URL.revokeObjectURL = revokeUrl as unknown as typeof URL.revokeObjectURL;
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
  const view = render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <Composer
        onSend={onSend}
        onAbort={vi.fn()}
        disabled={false}
        voiceInputEnabled
        attachmentsEnabled
        onRecordingStart={onRecordingStart}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  const v = MESSAGES[locale].chat.voice;
  const textarea = screen.getByPlaceholderText(
    MESSAGES[locale].chat.placeholder,
  ) as HTMLTextAreaElement;
  const send = () =>
    screen.getByRole("button", { name: MESSAGES[locale].chat.send }) as HTMLButtonElement;
  return { onSend, onRecordingStart, v, textarea, send, locale, view };
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

async function recordAndStop(v: Voice) {
  await act(async () => {
    fireEvent.click(button(v.record));
  });
  await act(async () => {
    fireEvent.click(button(v.stop));
  });
}

async function dictate(v: Voice) {
  await recordAndStop(v);
  await act(async () => {
    fireEvent.click(button(v.transcribe));
  });
}

describe("Composer voice input: recorded-message journey (mocked microphone and API)", () => {
  it("shows an accessible microphone button and asks for the microphone only after the tap", async () => {
    const media = installFakeMedia();
    const { v } = renderComposer();
    const mic = button(v.record);
    expect(mic.getAttribute("aria-label")).toBe(v.record);
    expect(media.gum).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(mic);
    });
    expect(media.gum).toHaveBeenCalledTimes(1);
    expect(button(v.stop)).toBeTruthy();
    expect(button(v.cancel)).toBeTruthy();
  });

  it("Start → Stop → Review → Transcribe → editable text → Send (one message, only on Send)", async () => {
    const { onSend, v, textarea, send, onRecordingStart } = renderComposer();
    await recordAndStop(v);

    // Review: local playback, nothing uploaded yet, Send blocked until resolved.
    expect(screen.getByRole("group", { name: v.reviewTitle })).toBeTruthy();
    const audio = screen.getByLabelText(v.playbackLabel) as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("blob:recording");
    expect(transcribeCalls()).toBe(0);
    expect(send().disabled).toBe(true);

    await act(async () => {
      fireEvent.click(button(v.transcribe));
    });
    await waitFor(() => expect(textarea.value).toBe("book a meeting tomorrow"));
    expect(transcribeCalls()).toBe(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(onRecordingStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(v.transcriptAdded)).toBeTruthy();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording");
    expect(screen.queryByRole("group", { name: v.reviewTitle })).toBeNull();

    // The user edits, then explicitly sends: the exact edited text goes through the normal path.
    fireEvent.change(textarea, { target: { value: "book a meeting on Friday" } });
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("book a meeting on Friday", {
      useKnowledgeBase: true,
      documentIds: [],
    });
  });

  it("uploads only the recorded audio as multipart form data", async () => {
    const { v } = renderComposer();
    await dictate(v);
    await waitFor(() => expect(transcribeCalls()).toBe(1));
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe("POST");
    const audio = (init.body as FormData).get("audio") as Blob;
    expect(audio.size).toBe(FakeMediaRecorder.bytesPerRecording);
  });

  it("Discard after review uploads nothing and keeps the typed draft", async () => {
    const { onSend, v, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "typed draft" } });
    await recordAndStop(v);
    fireEvent.click(button(v.discard));
    expect(transcribeCalls()).toBe(0);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("typed draft");
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording");
    expect(screen.getByText(v.recordingDiscarded)).toBeTruthy();
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

  it("Start → Cancel: no upload, no submission, draft kept, microphone released", async () => {
    const media = installFakeMedia();
    const { onSend, v, textarea, send } = renderComposer();
    fireEvent.change(textarea, { target: { value: "typed draft" } });
    await act(async () => {
      fireEvent.click(button(v.record));
    });
    expect(send().disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(button(v.cancel));
    expect(textarea.value).toBe("typed draft");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(media.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(screen.getByText(v.recordingCancelled)).toBeTruthy();
    expect(send().disabled).toBe(false);
  });

  it("a too-short recording is refused before review and never uploaded", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000_000); // zero elapsed time
    const { v } = renderComposer();
    await recordAndStop(v);
    expect((await screen.findByRole("alert")).textContent).toBe(v.errors.too_short);
    expect(screen.queryByRole("button", { name: v.transcribe })).toBeNull();
    expect(transcribeCalls()).toBe(0);
  });

  it("transcription failure → retry → transcript once → exactly one chat message", async () => {
    let failures = 1;
    fetchMock.mockImplementation(async () =>
      failures-- > 0
        ? new Response(JSON.stringify({ error: { code: "transcription_failed" } }), { status: 502 })
        : new Response(JSON.stringify({ data: { text: transcript } }), { status: 200 }),
    );
    const { onSend, v, textarea, send } = renderComposer();
    await dictate(v);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(v.errors.transcription_failed);
    expect(alert.textContent).toContain(v.retryHint);
    expect(textarea.value).toBe("");

    await act(async () => {
      fireEvent.click(button(v.transcribe));
    });
    await waitFor(() => expect(textarea.value).toBe("book a meeting tomorrow"));
    expect(transcribeCalls()).toBe(2);
    fireEvent.click(send());
    fireEvent.click(send()); // a second tap on an empty box sends nothing
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a double tap on Transcribe makes one upload", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(new Response(JSON.stringify({ data: { text: transcript } }), { status: 200 }));
        }),
    );
    const { v, textarea } = renderComposer();
    await recordAndStop(v);
    await act(async () => {
      fireEvent.click(button(v.transcribe));
      fireEvent.click(button(v.transcribe));
    });
    expect(transcribeCalls()).toBe(1);
    await act(async () => release());
    await waitFor(() => expect(textarea.value).toBe("book a meeting tomorrow"));
  });

  it.each([
    ["daily_limit_reached", 429, "daily_limit"],
    ["audio_too_large", 413, "too_large"],
    ["unsupported_audio_format", 415, "unsupported_format"],
    ["audio_too_long", 422, "too_large"],
  ])("server %s (%s) shows a localized, dismissible error", async (code, status, key) => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: { code } }), { status }),
    );
    const { v, textarea } = renderComposer("fi");
    await dictate(v);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      v.errors[key]!.replace("{limit}", "10").replace("{seconds}", "60"),
    );
    expect(textarea.disabled).toBe(false);
    fireEvent.click(button(v.dismiss));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["NotAllowedError", "permission_denied"],
    ["NotFoundError", "no_microphone"],
  ])("microphone %s shows %s and records nothing", async (name, key) => {
    installFakeMedia(async () => {
      throw domError(name);
    });
    const { v } = renderComposer();
    await act(async () => {
      fireEvent.click(button(v.record));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(v.errors[key]);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unsupported browser gets a clear message instead of a broken recorder", async () => {
    uninstallFakeMedia();
    const { v } = renderComposer();
    await act(async () => {
      fireEvent.click(button(v.record));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(v.errors.unsupported);
  });

  it("unmounting (navigation) while recording stops the tracks and uploads nothing", async () => {
    const media = installFakeMedia();
    const { v, view } = renderComposer();
    await act(async () => {
      fireEvent.click(button(v.record));
    });
    view.unmount();
    expect(media.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances[0]!.state).toBe("inactive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unmounting during review frees the playback URL and uploads nothing", async () => {
    const { v, view } = renderComposer();
    await recordAndStop(v);
    view.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:recording");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("states that only the text is sent to the assistant; timer is LTR-isolated (AR)", async () => {
    const { v } = renderComposer("ar");
    await act(async () => {
      fireEvent.click(button(v.record));
    });
    expect(document.body.textContent).toContain(v.privacyNote);
    const timer = [...document.querySelectorAll("span[dir=ltr]")].find((el) =>
      /\d:\d\d \/ 1:00/.test(el.textContent ?? ""),
    );
    expect(timer).toBeTruthy();
  });

  it.each(["en", "fi", "ar"] as const)("renders the review step in %s", async (locale) => {
    const { v } = renderComposer(locale);
    await recordAndStop(v);
    expect(screen.getByRole("group", { name: v.reviewTitle })).toBeTruthy();
    expect(button(v.transcribe)).toBeTruthy();
    expect(button(v.discard)).toBeTruthy();
    expect(document.body.textContent).toContain(v.privacyNote);
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
