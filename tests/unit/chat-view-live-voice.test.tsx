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
  enableSpeech: vi.fn(),
  speechEnabledInSession: false,
  allowance: null as unknown,
  lastOptions: null as null | LiveOptions,
  replace: vi.fn(),
}));
type LiveOptions = {
  onUserTurn: (t: string, grant: string, conversationId: string) => Promise<string | null>;
  getConversationId?: () => string | undefined;
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
      enableSpeech: live.enableSpeech,
      speechEnabledInSession: live.speechEnabledInSession,
      allowance: live.allowance,
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
/** GET /voice-conversation/session: today's allowance (null → the read fails). */
let allowanceBody: unknown;
let allowanceReads: number;
let deviceVoices: Array<{ lang: string; localService: boolean; name: string }>;
const GRANT = "55555555-5555-4555-8555-555555555555";
/** Created by the chat route for a typed first message in a new chat. */
const NEW_CHAT_ID = "66666666-6666-4666-8666-666666666666";
/** Reserved by the session route when live mode starts in a new chat. */
const RESERVED_ID = "77777777-7777-4777-8777-777777777777";

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
  live.enableSpeech.mockClear();
  live.speechEnabledInSession = false;
  live.allowance = null;
  allowanceBody = null;
  allowanceReads = 0;
  live.replace.mockClear();
  fetchBodies = [];
  deviceVoices = [{ lang: "en-US", localService: true, name: "en" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/voice-conversation/session")) {
        allowanceReads += 1;
        return allowanceBody
          ? new Response(JSON.stringify({ data: allowanceBody }))
          : new Response(JSON.stringify({ error: { code: "voice_conversation_unavailable" } }), {
              status: 503,
            });
      }
      const body = JSON.parse(String(init?.body));
      fetchBodies.push(body);
      const frames = [
        // Like the server: an existing / reserved conversation is echoed back.
        { type: "meta", conversationId: body.conversationId ?? NEW_CHAT_ID },
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
    expect(document.body.textContent).toContain(en.chat.live.introDailyLimit);
    expect(document.body.textContent).toContain(en.chat.live.introLanguage);
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
      reply = await live.lastOptions!.onUserTurn(
        "Mitä huomenna?",
        GRANT,
        "33333333-3333-4333-8333-333333333333",
      );
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

  it("gives the live session the current conversation (none yet in a new chat)", () => {
    renderView();
    expect(live.lastOptions!.getConversationId!()).toBe("33333333-3333-4333-8333-333333333333");
    cleanup();
    renderView(en, { conversationId: undefined });
    expect(live.lastOptions!.getConversationId!()).toBeUndefined();
  });

  it("in a new chat, turns go to the server-reserved conversation and the redirect waits until the end", async () => {
    live.state = { ...live.state, phase: "listening", active: true };
    const view = renderView(en, { conversationId: undefined });
    await act(async () => {
      await live.lastOptions!.onUserTurn("Mitä huomenna?", GRANT, RESERVED_ID);
    });
    await act(async () => {
      await live.lastOptions!.onUserTurn("Entä perjantaina?", GRANT, RESERVED_ID);
    });
    expect(fetchBodies.map((b) => b.conversationId)).toEqual([RESERVED_ID, RESERVED_ID]);
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
    expect(live.replace).toHaveBeenCalledWith(`/chat/${RESERVED_ID}`);
  });

  it("typed chat in a new conversation still redirects immediately", async () => {
    renderView(en, { conversationId: undefined });
    const box = screen.getByPlaceholderText(en.chat.placeholder);
    fireEvent.change(box, { target: { value: "typed" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(live.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT_ID}`);
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

  describe("spoken replies inside a running session", () => {
    const active = (notice: string | null = null) => {
      live.state = {
        ...live.state,
        phase: "listening",
        active: true,
        notice,
        remainingMs: 290_000,
      };
    };
    const rerender = (view: ReturnType<typeof renderView>, messages = en) =>
      view.rerender(
        <NextIntlClientProvider locale={messages === ar ? "ar" : "en"} messages={messages}>
          <ChatView
            conversationId="33333333-3333-4333-8333-333333333333"
            initialMessages={[{ id: "a1", role: "assistant", content: "Hei!" }]}
            voiceInputEnabled
            voiceConversation={{ sessionMinutes: 5 }}
          />
        </NextIntlClientProvider>,
      );

    it("after a blocked reply: says so and offers Enable spoken replies without ending the session", () => {
      active("speech_blocked");
      renderView();
      expect(document.body.textContent).toContain(en.chat.live.notices.speech_blocked);
      fireEvent.click(screen.getByRole("button", { name: new RegExp(en.chat.live.enableSpeech) }));
      expect(live.enableSpeech).toHaveBeenCalledTimes(1);
      expect(live.end).not.toHaveBeenCalled();
    });

    it("is localized (Arabic) after a failed reply", () => {
      active("speech_failed");
      renderView(ar);
      expect(document.body.textContent).toContain(ar.chat.live.notices.speech_failed);
      expect(
        screen.getByRole("button", { name: new RegExp(ar.chat.live.enableSpeech) }),
      ).toBeTruthy();
    });

    it("is not offered while replies are spoken normally", () => {
      active();
      renderView();
      expect(
        screen.queryByRole("button", { name: new RegExp(en.chat.live.enableSpeech) }),
      ).toBeNull();
    });

    it("a text-only session keeps the choice, and can turn speech on in the same session", () => {
      deviceVoices = [{ lang: "fi-FI", localService: true, name: "fi" }]; // no English voice
      const view = renderView();
      fireEvent.click(screen.getByRole("button", { name: en.chat.live.start }));
      fireEvent.click(screen.getByRole("button", { name: new RegExp(en.chat.live.startTextOnly) }));
      expect(live.lastOptions!.speakReplies).toBe(false);
      active();
      rerender(view);
      expect(document.body.textContent).toContain(en.chat.live.textOnlyHint);
      fireEvent.click(screen.getByRole("button", { name: new RegExp(en.chat.live.enableSpeech) }));
      expect(live.enableSpeech).toHaveBeenCalledTimes(1);
      expect(live.start).toHaveBeenCalledTimes(1); // no restart

      live.speechEnabledInSession = true;
      rerender(view);
      expect(document.body.textContent).not.toContain(en.chat.live.textOnlyHint);
      expect(
        screen.queryByRole("button", { name: new RegExp(en.chat.live.enableSpeech) }),
      ).toBeNull();
    });
  });

  describe("allowance: what is left today, and why it stops", () => {
    const reading = (o: {
      starts?: number;
      turnsUsed?: number;
      audioUsed?: number;
      session?: number | null;
    }) => {
      const turnsUsed = o.turnsUsed ?? 6;
      const audioUsed = o.audioUsed ?? 31_740;
      const turnsRemaining = 10 - turnsUsed;
      const session = o.session === undefined ? null : o.session;
      return {
        day: "2026-09-30",
        renewsAt: Date.UTC(2026, 8, 30, 21), // 00:00 in Helsinki (UTC+3)
        startsToday: { used: 1 - (o.starts ?? 1), limit: 1, remaining: o.starts ?? 1 },
        turnsToday: { used: turnsUsed, limit: 10, remaining: turnsRemaining },
        audioMsToday: { used: audioUsed, limit: 300_000, remaining: 300_000 - audioUsed },
        sessionSeconds: 300,
        maxTurnSeconds: 30,
        maxTurnsPerSession: 10,
        session:
          session === null
            ? null
            : { turns: { used: session, limit: 10, remaining: 10 - session }, expiresAt: 0 },
        turnsAvailable: Math.min(turnsRemaining, session === null ? 99 : 10 - session),
      };
    };
    const openIntro = async (messages = en) => {
      const view = renderView(messages);
      fireEvent.click(screen.getByRole("button", { name: messages.chat.live.start }));
      await act(async () => {});
      return view;
    };

    it("before starting: today's starts, turns (4 after 6 used) and speaking time, separate from the session's maximum", async () => {
      allowanceBody = reading({});
      await openIntro();
      const text = document.body.textContent!;
      expect(allowanceReads).toBe(1);
      expect(text).toContain("1 conversation start");
      expect(text).toContain("4 turns");
      expect(text).toContain(`${en.chat.live.allowanceAudio} 4:28`);
      expect(text).toContain("Renews at 00:00 Helsinki time");
      expect(text).toContain("A conversation lasts at most 5 minutes. It ends earlier");
      expect(text).toContain(en.chat.live.introDailyLimit);
      expect(live.start).not.toHaveBeenCalled(); // reading never starts anything
      const confirm = screen.getByRole("button", { name: new RegExp(en.chat.live.confirm) });
      expect((confirm as HTMLButtonElement).disabled).toBe(false);
    });

    it("no starts left: says so with the renewal time and doesn't offer a start", async () => {
      allowanceBody = reading({ starts: 0 });
      await openIntro();
      expect(screen.getByRole("alert").textContent).toBe(
        en.chat.live.errors.daily_sessions_used.replace("{time}", "00:00"),
      );
      const confirm = screen.getByRole("button", { name: new RegExp(en.chat.live.confirm) });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
    });

    it("no turns left today: names that limit, not a generic one", async () => {
      allowanceBody = reading({ turnsUsed: 10 });
      await openIntro();
      expect(screen.getByRole("alert").textContent).toBe(
        en.chat.live.errors.daily_turns_used.replace("{time}", "00:00"),
      );
    });

    it("an unreadable allowance is shown as unknown, never as a balance, and doesn't block", async () => {
      allowanceBody = null;
      await openIntro();
      expect(document.body.textContent).toContain(en.chat.live.allowanceUnknown);
      const confirm = screen.getByRole("button", { name: new RegExp(en.chat.live.confirm) });
      expect((confirm as HTMLButtonElement).disabled).toBe(false);
    });

    it("during the session: session time, turns and speaking time left, from the server's reading", () => {
      live.state = { ...live.state, phase: "listening", active: true, remainingMs: 250_000 };
      live.allowance = reading({ session: 1, turnsUsed: 7, audioUsed: 40_000 });
      renderView();
      const text = document.body.textContent!;
      expect(text).toContain(`${en.chat.live.remaining} 4:10`);
      expect(screen.getByTestId("live-turns-left").textContent).toBe("3");
      expect(screen.getByTestId("live-audio-left").textContent).toBe("4:20");
    });

    it("during the session with no reading: 'unknown', not a guess", () => {
      live.state = { ...live.state, phase: "listening", active: true, remainingMs: 250_000 };
      renderView();
      expect(screen.getByTestId("live-turns-left").textContent).toBe(en.chat.live.unknown);
      expect(screen.getByTestId("live-audio-left").textContent).toBe(en.chat.live.unknown);
    });

    it.each([
      ["daily_sessions_used"],
      ["daily_turns_used"],
      ["daily_audio_used"],
      ["session_turns_used"],
      ["session_expired"],
    ])("ended by %s: its own message (EN and AR)", (error) => {
      for (const messages of [en, ar]) {
        cleanup();
        live.state = { ...live.state, phase: "ended", active: false, error };
        live.allowance = reading({});
        renderView(messages);
        const expected = (messages.chat.live.errors as Record<string, string>)[error]!.replace(
          "{time}",
          "00:00",
        );
        expect(screen.getByRole("alert").textContent).toBe(expected);
      }
    });
  });
});
