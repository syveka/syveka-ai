// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * "New conversation" is in the chat view on every screen size and always
 * starts an empty chat: from /chat/[id] it goes to /chat; on /chat itself
 * (same route, no remount) it resets the view so the next message creates a
 * new conversation instead of continuing the previous one. An unsent draft
 * is carried over. Mocked: router, fetch (chat stream), live-voice hook.
 */
const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: nav.push }),
}));
vi.mock("@/hooks/use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    phase: "idle",
    active: false,
    error: null,
    notice: null,
    muted: false,
    elapsedMs: 0,
    remainingMs: null,
    start: vi.fn(),
    end: vi.fn(),
    toggleMute: vi.fn(),
    stopReply: vi.fn(),
    enableSpeech: vi.fn(),
    speechEnabledInSession: false,
    allowance: null,
    clearError: vi.fn(),
  }),
}));

import { ChatView } from "@/components/chat/chat-view";
import type { UiMessage } from "@/hooks/use-chat";

const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));
const FIRST = "66666666-6666-4666-8666-666666666666";
const EXISTING = "33333333-3333-4333-8333-333333333333";

let withAction: boolean;
let sentBodies: Array<{ conversationId?: string; message: string }>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.push.mockClear();
  sessionStorage.clear();
  withAction = false;
  sentBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { conversationId?: string; message: string };
      sentBodies.push(sent);
      const conversationId = sent.conversationId ?? FIRST;
      const frames = [
        { type: "meta", conversationId, messageId: "m1" },
        ...(withAction
          ? [
              {
                type: "action",
                action: {
                  id: "11111111-1111-4111-8111-111111111111",
                  tool: "createContact",
                  digest: "a".repeat(64),
                  conversationId,
                  expiresAt: Date.now() + 600_000,
                  details: { tool: "createContact", firstName: "QA" },
                },
              },
            ]
          : []),
        { type: "text", delta: `Reply to ${sent.message}` },
        { type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(conversationId?: string, initialMessages: UiMessage[] = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChatView conversationId={conversationId} initialMessages={initialMessages} />
    </NextIntlClientProvider>,
  );
}

const newChatButton = () => screen.getByRole("button", { name: en.chat.newConversation });
const composer = () => screen.getByPlaceholderText(en.chat.placeholder) as HTMLTextAreaElement;

async function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(composer(), { key: "Enter", code: "Enter" });
  });
  await act(async () => {}); // let the stream finish
}

describe("New conversation", () => {
  it("is shown in the chat view itself, disabled on an untouched new chat", () => {
    renderChat();
    expect(newChatButton()).toBeTruthy();
    expect((newChatButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("from a saved conversation, goes to /chat", () => {
    renderChat(EXISTING, [
      { id: "u1", role: "user", content: "Old question" },
      { id: "a1", role: "assistant", content: "Old answer" },
    ]);
    fireEvent.click(newChatButton());
    expect(nav.push).toHaveBeenCalledWith("/chat");
  });

  it("on /chat, a held redirect doesn't keep the next message in the previous conversation", async () => {
    withAction = true; // an undecided card holds the redirect to /chat/[id]
    renderChat();
    await send("First test question");
    expect(screen.getByText("First test question")).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(newChatButton());
    });
    expect(screen.queryByText("First test question")).toBeNull();
    expect(screen.queryByText("Reply to First test question")).toBeNull();
    expect(screen.getByText(en.chat.emptyState)).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled(); // the created conversation is listed

    withAction = false;
    await send("Second test question");
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]!.conversationId).toBeUndefined();
    expect(sentBodies[1]!.conversationId).toBeUndefined();
    expect(screen.queryByText("First test question")).toBeNull();
  });

  it("on /chat after the first reply, the next message also starts fresh", async () => {
    renderChat();
    await send("First test question");
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${FIRST}`);

    await act(async () => {
      fireEvent.click(newChatButton());
    });
    await send("Another question");
    expect(sentBodies[1]!.conversationId).toBeUndefined();
    expect(screen.queryByText("First test question")).toBeNull();
  });

  it("carries an unsent draft into the new chat instead of dropping it", async () => {
    renderChat();
    await send("First test question");
    fireEvent.change(composer(), { target: { value: "Unsent draft" } });

    await act(async () => {
      fireEvent.click(newChatButton());
    });
    expect(composer().value).toBe("Unsent draft");
    expect(sentBodies).toHaveLength(1); // never sent
    expect(sessionStorage.getItem("chat:draft")).toBeNull(); // consumed by the composer
  });

  it("from a saved conversation, hands the draft to the new chat page", () => {
    renderChat(EXISTING, [{ id: "u1", role: "user", content: "Old question" }]);
    fireEvent.change(composer(), { target: { value: "Keep me" } });
    fireEvent.click(newChatButton());
    expect(sessionStorage.getItem("chat:draft")).toBe("Keep me");
    expect(nav.push).toHaveBeenCalledWith("/chat");
  });
});
