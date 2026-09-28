// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * ChatView ↔ live voice wiring with real messages. Mocked: the live hook
 * (state is driven directly), the chat network, router and speech playback.
 */
const live = vi.hoisted(() => ({
  state: {
    phase: "idle",
    active: false,
    error: null as string | null,
    notice: null as string | null,
    muted: false,
    elapsedMs: 0,
    remainingMs: null as number | null,
  },
  start: vi.fn(async () => {}),
  end: vi.fn(),
  toggleMute: vi.fn(),
  stopReply: vi.fn(),
  lastOptions: null as null | LiveOptions,
  replace: vi.fn(),
}));
type LiveOptions = {
  onUserTurn: (t: string, grant: string) => Promise<string | null>;
  speakReplies?: boolean;
};

vi.mock("@/hooks/use-voice-conversation", () => ({
  useVoiceConversation: (options: LiveOptions) => {
    live.lastOptions = options;
    return {
      ...live.state,
      start: live.start,
      end: live.end,
      toggleMute: live.toggleMute,
      stopReply: live.stopReply,
      clearError: vi.fn(),
    };
  },
}));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: live.replace, refresh: vi.fn(), push: vi.fn() }),
}));

import { ChatView } from "@/components/chat/chat-view";

const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));
const ar = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/ar.json"), "utf8"));
let fetchBodies: Array<Record<string, unknown>>;
let deviceVoices: Array<{ lang: string; localService: boolean; name: string }>;
const GRANT = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  live.state = {
    phase: "idle",
    active: false,
    error: null,
    notice: null,
    muted: false,
    elapsedMs: 0,
    remainingMs: null,
  };
  live.start.mockClear();
  live.replace.mockClear();
  fetchBodies = [];
  deviceVoices = [{ lang: "en-US", localService: true, name: "en" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      fetchBodies.push(JSON.parse(String(init?.body)));
      const frames = [
        { type: "meta", conversationId: "66666666-6666-4666-8666-666666666666" },
        { type: "text", delta: "Huomenna on kaksi tapaamista." },
        { type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
    }),
  );
  vi.stubGlobal("speechSynthesis", {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => deviceVoices,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView(messages = en, props: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  return render(
    <NextIntlClientProvider locale={messages === ar ? "ar" : "en"} messages={messages}>
      <ChatView
        conversationId="33333333-3333-4333-8333-333333333333"
        initialMessages={[{ id: "a1", role: "assistant", content: "Hei!" }]}
        voiceInputEnabled
        voiceConversation={{ sessionMinutes: 5 }}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("ChatView live voice", () => {
  it("is not offered when the server doesn't allow it", () => {
    renderView(en, { voiceConversation: null });
    expect(screen.queryByRole("button", { name: en.chat.live.start })).toBeNull();
  });

  it("explains the mode before starting; the microphone opens only after confirming", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: en.chat.live.start }));
    expect(live.start).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en.chat.live.introMic);
    expect(document.body.textContent).toContain(en.chat.live.introAuto);
    expect(document.body.textContent).toContain(en.chat.live.introActions);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.chat.live.confirm) }));
    expect(live.start).toHaveBeenCalledTimes(1);
    expect(live.lastOptions!.speakReplies).toBe(true);
  });

  it("without a device voice for the language: offers text-only replies or dictation, never another language", () => {
    deviceVoices = [{ lang: "fi-FI", localService: true, name: "fi" }]; // no English voice
    renderView();
    fireEvent.click(screen.getByRole("button", { name: en.chat.live.start }));
    expect(screen.getByRole("status").textContent).toBe(en.chat.live.voiceUnavailable);
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${en.chat.live.confirm}$`) }),
    ).toBeNull();

    // "Use dictation" closes the dialog without opening a live session.
    fireEvent.click(screen.getByRole("button", { name: en.chat.live.useDictation }));
    expect(live.start).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(en.chat.placeholder)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: en.chat.live.start }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.chat.live.startTextOnly) }));
    expect(live.start).toHaveBeenCalledTimes(1);
    expect(live.lastOptions!.speakReplies).toBe(false);
  });

  it("never sends the typed draft and keeps it after the conversation", () => {
    const view = renderView();
    const box = screen.getByPlaceholderText(en.chat.placeholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "luonnos, ei lähetetä" } });

    live.state = { ...live.state, phase: "listening", active: true, remainingMs: 290_000 };
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatView
          conversationId="33333333-3333-4333-8333-333333333333"
          initialMessages={[{ id: "a1", role: "assistant", content: "Hei!" }]}
          voiceInputEnabled
          voiceConversation={{ sessionMinutes: 5 }}
        />
      </NextIntlClientProvider>,
    );
    // While live: composer hidden (not unmounted), no Listen buttons, End visible.
    expect(box.closest(".hidden")).not.toBeNull();
    expect(screen.queryByRole("button", { name: en.chat.voice.listenLabel })).toBeNull();
    expect(screen.getByRole("button", { name: new RegExp(en.chat.live.end) })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(en.chat.live.mute) })).toBeTruthy();

    live.state = { ...live.state, phase: "ended", active: false };
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatView
          conversationId="33333333-3333-4333-8333-333333333333"
          initialMessages={[{ id: "a1", role: "assistant", content: "Hei!" }]}
          voiceInputEnabled
          voiceConversation={{ sessionMinutes: 5 }}
        />
      </NextIntlClientProvider>,
    );
    expect(box.value).toBe("luonnos, ei lähetetä");
    expect(fetchBodies).toHaveLength(0);
  });

  it("submits a spoken turn through the normal chat route in voice mode and returns the reply", async () => {
    renderView();
    let reply: string | null = null;
    await act(async () => {
      reply = await live.lastOptions!.onUserTurn("Mitä huomenna?", GRANT);
    });
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({
      message: "Mitä huomenna?",
      voiceGrant: GRANT,
      documentIds: [],
      conversationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(fetchBodies[0]).not.toHaveProperty("responseMode");
    expect(reply).toBe("Huomenna on kaksi tapaamista.");
    // The committed turn is visible in the thread.
    expect(document.body.textContent).toContain("Mitä huomenna?");
  });

  it("in a new chat, the redirect waits until the live conversation ends (no remount mid-session)", async () => {
    live.state = { ...live.state, phase: "listening", active: true };
    const view = renderView(en, { conversationId: undefined });
    await act(async () => {
      await live.lastOptions!.onUserTurn("Mitä huomenna?", GRANT);
    });
    expect(live.replace).not.toHaveBeenCalled();

    live.state = { ...live.state, phase: "ended", active: false };
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatView
          initialMessages={[{ id: "a1", role: "assistant", content: "Hei!" }]}
          voiceInputEnabled
          voiceConversation={{ sessionMinutes: 5 }}
        />
      </NextIntlClientProvider>,
    );
    expect(live.replace).toHaveBeenCalledTimes(1);
    expect(live.replace).toHaveBeenCalledWith("/chat/66666666-6666-4666-8666-666666666666");
  });

  it("typed chat in a new conversation still redirects immediately", async () => {
    renderView(en, { conversationId: undefined });
    const box = screen.getByPlaceholderText(en.chat.placeholder);
    fireEvent.change(box, { target: { value: "typed" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(live.replace).toHaveBeenCalledWith("/chat/66666666-6666-4666-8666-666666666666");
  });

  it("typed chat still sends without responseMode", async () => {
    renderView();
    const box = screen.getByPlaceholderText(en.chat.placeholder);
    fireEvent.change(box, { target: { value: "typed" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(fetchBodies[0]).not.toHaveProperty("responseMode");
    expect(fetchBodies[0]).not.toHaveProperty("voiceGrant");
  });

  it("renders Arabic states with LTR-isolated timers", () => {
    live.state = {
      ...live.state,
      phase: "speaking",
      active: true,
      elapsedMs: 65_000,
      remainingMs: 235_000,
    };
    renderView(ar);
    expect(document.body.textContent).toContain(ar.chat.live.state.speaking);
    const timers = [...document.querySelectorAll("span[dir=ltr]")].map((e) => e.textContent);
    expect(timers).toEqual(expect.arrayContaining(["1:05", "3:55"]));
    expect(screen.getByRole("button", { name: new RegExp(ar.chat.live.stopReply) })).toBeTruthy();
  });
});
