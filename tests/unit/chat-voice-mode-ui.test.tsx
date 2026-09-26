// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { ChatView } from "@/components/chat/chat-view";
import { createFakeSpeechEngine } from "./fake-speech-engine";

const routerReplace = vi.fn();
const routerRefresh = vi.fn();
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: routerReplace, refresh: routerRefresh }),
}));

function loadMessages(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
  );
}
const MESSAGES = { en: loadMessages("en"), fi: loadMessages("fi"), ar: loadMessages("ar") };
type Locale = keyof typeof MESSAGES;

function sseResponse(events: object[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const fetchMock = vi.fn();

function renderChat(locale: Locale = "en", engine = createFakeSpeechEngine()) {
  const utils = render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <ChatView initialMessages={[]} speechEngine={engine.engine} />
    </NextIntlClientProvider>,
  );
  return { ...utils, fake: engine };
}

describe("Assistant chat — voice mode UI", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      sseResponse([
        { type: "meta", conversationId: "c-1", messageId: "m-1" },
        { type: "text", delta: "We open at nine." },
        { type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 },
      ]),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps text chat working unchanged (regression) and sends responseMode text", async () => {
    renderChat("en");
    const input = screen.getByPlaceholderText(MESSAGES.en.chat.placeholder);
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.chat.send }));

    await screen.findByText("We open at nine.");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/ai/chat");
    expect(body).toMatchObject({ message: "Hello", responseMode: "text" });
    expect(body).not.toHaveProperty("orgId");
    expect(screen.queryByTestId("voice-session-panel")).toBeNull();
    // New text conversations still navigate to their own URL immediately.
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/chat/c-1"));
  });

  it("shows the voice control next to the message controls", async () => {
    renderChat("en");
    const button = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("disables the voice control with an explanation when the browser can't do voice", async () => {
    renderChat("en", createFakeSpeechEngine({ supported: false }));
    const button = await screen.findByRole("button", {
      name: MESSAGES.en.chat.voice.errors.unsupported,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs a full voice turn through the same chat endpoint and speaks the reply", async () => {
    const { fake } = renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));

    const panel = await screen.findByTestId("voice-session-panel");
    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("listening"));
    expect(screen.getByRole("status").textContent).toBe(MESSAGES.en.chat.voice.status.listening);

    await act(async () => fake.lastListen.resolve("When do you open?"));
    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("speaking"));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ message: "When do you open?", responseMode: "voice" });
    expect(fake.lastSpeech.text).toBe("We open at nine.");
    // The transcript also lands in the normal chat thread.
    expect(screen.getAllByText("When do you open?").length).toBeGreaterThan(0);

    // The first-message redirect is held so the call isn't torn down...
    expect(routerReplace).not.toHaveBeenCalled();

    // ...and applied once the user ends the session.
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.chat.voice.end }));
    expect(screen.queryByTestId("voice-session-panel")).toBeNull();
    expect(routerReplace).toHaveBeenCalledWith("/chat/c-1");
  });

  it("toggles mute with an accessible pressed state", async () => {
    renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));
    const panel = await screen.findByTestId("voice-session-panel");
    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("listening"));

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.chat.voice.mute })),
    );
    const unmute = screen.getByRole("button", { name: MESSAGES.en.chat.voice.unmute });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");
    expect(panel.getAttribute("data-status")).toBe("muted");
    expect(screen.getByRole("status").textContent).toBe(MESSAGES.en.chat.voice.status.muted);
  });

  it("explains a blocked microphone and offers a retry", async () => {
    const fake = createFakeSpeechEngine();
    fake.denyMicrophone();
    renderChat("en", fake);
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));

    expect((await screen.findByRole("alert")).textContent).toContain(
      MESSAGES.en.chat.voice.errors.permission_denied,
    );
    expect(screen.getByRole("button", { name: MESSAGES.en.chat.voice.retry })).toBeTruthy();
  });

  it("shows a chat-route error (rate limit) inside the voice panel", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    const { fake } = renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));
    const panel = await screen.findByTestId("voice-session-panel");
    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("listening"));
    await act(async () => fake.lastListen.resolve("Hi"));

    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("error"));
    expect(screen.getByRole("alert").textContent).toContain(MESSAGES.en.chat.errors.rate_limited);
  });

  it.each([
    [403, "permission_denied", "not_permitted"],
    [401, "unauthenticated", "session_expired"],
  ] as const)(
    "a chat %s (%s) mid-call shows access guidance, never the microphone message",
    async (status, code, voiceKey) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status }));
      const { fake } = renderChat("en");
      const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
      await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
      await act(async () => fireEvent.click(start));
      const panel = await screen.findByTestId("voice-session-panel");
      await waitFor(() => expect(panel.getAttribute("data-status")).toBe("listening"));
      await act(async () => fake.lastListen.resolve("Hi"));

      await waitFor(() => expect(panel.getAttribute("data-status")).toBe("error"));
      const alert = screen.getByRole("alert").textContent ?? "";
      expect(alert).toContain(MESSAGES.en.chat.voice.errors[voiceKey]);
      expect(alert).not.toContain(MESSAGES.en.chat.voice.errors.permission_denied);
    },
  );

  it("moves focus into the call view when it opens", async () => {
    renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));
    await screen.findByTestId("voice-session-panel");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: MESSAGES.en.chat.voice.end }),
    );
  });

  it("the voice button can't start a second session or send text while a call is live", async () => {
    renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));
    await screen.findByTestId("voice-session-panel");
    expect((start as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByPlaceholderText(MESSAGES.en.chat.placeholder);
    fireEvent.change(input, { target: { value: "typed while talking" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a full-screen, safe-area-aware sheet on mobile and a floating card from md up", async () => {
    renderChat("en");
    const start = await screen.findByRole("button", { name: MESSAGES.en.chat.voice.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));
    const panel = await screen.findByTestId("voice-session-panel");
    const classes = panel.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["fixed", "inset-0", "z-50"]));
    expect(panel.className).toContain("env(safe-area-inset-bottom)");
    expect(classes).toEqual(expect.arrayContaining(["md:inset-auto", "md:w-96", "md:end-6"]));
    // Logical (RTL-safe) positioning only.
    expect(panel.className).not.toMatch(/\b(md:)?(right|left)-/);
  });

  it.each([
    ["fi", "fi-FI"],
    ["en", "en-US"],
    ["ar", "ar-SA"],
  ] as const)("localizes the voice UI and speech language for %s", async (locale, speechLang) => {
    const { fake } = renderChat(locale);
    const m = MESSAGES[locale].chat.voice;
    const start = await screen.findByRole("button", { name: m.start });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(start));

    const panel = await screen.findByTestId("voice-session-panel");
    await waitFor(() => expect(panel.getAttribute("data-status")).toBe("listening"));
    expect(screen.getByRole("dialog", { name: m.title })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(m.status.listening);
    expect(screen.getByRole("button", { name: m.mute })).toBeTruthy();
    expect(screen.getByRole("button", { name: m.end })).toBeTruthy();
    expect(screen.getByText(m.privacyNote)).toBeTruthy();
    expect(fake.lastListen.lang).toBe(speechLang);
  });
});
