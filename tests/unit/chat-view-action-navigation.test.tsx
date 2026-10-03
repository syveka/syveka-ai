// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * A new chat's first reply can propose a write (a confirmation card). The
 * redirect to /chat/[id] that follows a new chat's first reply remounts the
 * view from saved messages, where pending cards don't exist -- so it must
 * wait until the card is decided. Real: ChatView, useChat, the thread and the
 * card, with real messages. Mocked: the router, fetch (chat stream and the
 * decision endpoint) and the live-voice hook.
 */
const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: vi.fn() }),
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

const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));
const NEW_CHAT = "66666666-6666-4666-8666-666666666666";
const EXISTING = "33333333-3333-4333-8333-333333333333";
const ACTION_ID = "11111111-1111-4111-8111-111111111111";

const action = (conversationId = NEW_CHAT) => ({
  id: ACTION_ID,
  tool: "createContact",
  digest: "a".repeat(64),
  conversationId,
  expiresAt: Date.now() + 600_000,
  details: { tool: "createContact", firstName: "QA Cancel Test 2" },
});

let withAction: boolean;
let decision: { status: number; body: unknown } | "network_error";
let decisions: number;
let writes: number;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  withAction = true;
  decisions = 0;
  writes = 0;
  decision = { status: 200, body: { data: { status: "canceled", tool: "createContact" } } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/v1/ai/actions/")) {
        decisions += 1;
        if (decision === "network_error") throw new TypeError("Failed to fetch");
        const body = decision.body as { data?: { status?: string } };
        if (body.data?.status === "done") writes += 1;
        return new Response(JSON.stringify(decision.body), { status: decision.status });
      }
      const sent = JSON.parse(String(init?.body)) as { conversationId?: string };
      const conversationId = sent.conversationId ?? NEW_CHAT;
      const frames = [
        { type: "meta", conversationId, messageId: "m1" },
        { type: "tool", name: "createContact", status: "start" },
        ...(withAction ? [{ type: "action", action: action(conversationId) }] : []),
        { type: "tool", name: "createContact", status: "done" },
        { type: "text", delta: "When you confirm, I'll create the contact." },
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

function renderChat(conversationId?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChatView conversationId={conversationId} initialMessages={[]} />
    </NextIntlClientProvider>,
  );
}

async function sendFirstMessage(text = "Create a contact named QA Cancel Test 2") {
  fireEvent.change(screen.getByPlaceholderText(en.chat.placeholder), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(screen.getByPlaceholderText(en.chat.placeholder), {
      key: "Enter",
      code: "Enter",
    });
  });
  await act(async () => {}); // let the stream finish
}

const card = () => screen.queryByRole("region", { name: en.chat.actions.title });
const click = async (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

describe("a new chat whose first reply proposes a write", () => {
  it("A. doesn't navigate while the action is undecided; the card stays", async () => {
    renderChat();
    await sendFirstMessage();
    expect(card()).not.toBeNull();
    expect(screen.getByRole("button", { name: en.chat.actions.confirm })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("B. Cancel: nothing written, then it navigates exactly once", async () => {
    renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.cancel);
    expect(writes).toBe(0);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.canceled);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("C. Confirm: exactly one write, then it navigates exactly once", async () => {
    decision = {
      status: 200,
      body: { data: { status: "done", tool: "createContact", result: { id: "c-1" } } },
    };
    renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.confirm);
    expect(writes).toBe(1);
    expect(decisions).toBe(1);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
  });

  it.each([
    ["a network failure", "network_error" as const],
    ["a server error", { status: 500, body: { error: { code: "action_failed" } } }],
    ["a rate limit", { status: 429, body: { error: { code: "rate_limited" } } }],
  ])("D. %s: the card stays and nothing navigates", async (_l, failure) => {
    decision = failure;
    renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.confirm);
    expect(card()).not.toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("an expired or already-handled action is settled: it then navigates once", async () => {
    decision = { status: 404, body: { error: { code: "not_found" } } };
    renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.confirm);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.expired);
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });
});

describe("races and multiple actions", () => {
  it("leaving the chat while a decision is in flight never redirects back to it", async () => {
    let resolveDecision!: (r: Response) => void;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).startsWith("/api/v1/ai/actions/")) {
        return new Promise<Response>((r) => (resolveDecision = r));
      }
      return base(url as string, init);
    });
    const view = renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.confirm);
    view.unmount(); // the user navigated elsewhere
    await act(async () => {
      resolveDecision(
        new Response(JSON.stringify({ data: { status: "done", tool: "createContact" } })),
      );
    });
    await act(async () => {});
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("two pending actions: settling one keeps the redirect held; the second releases it once", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).startsWith("/api/v1/ai/actions/")) return base(url as string, init);
      const frames = [
        { type: "meta", conversationId: NEW_CHAT, messageId: "m1" },
        { type: "action", action: { ...action(), id: "a1" } },
        { type: "action", action: { ...action(), id: "a2" } },
        { type: "text", delta: "Two things to confirm." },
        { type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
    });
    renderChat();
    await sendFirstMessage();
    const cancels = screen.getAllByRole("button", { name: en.chat.actions.cancel });
    await act(async () => {
      fireEvent.click(cancels[0]!);
    });
    expect(nav.replace).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(cancels[1]!);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("unchanged behaviour", () => {
  it("E. an existing chat never navigates (with or without a card)", async () => {
    renderChat(EXISTING);
    await sendFirstMessage();
    expect(card()).not.toBeNull();
    await click(en.chat.actions.cancel);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("F. a new chat whose first reply proposes nothing navigates at once, as before", async () => {
    withAction = false;
    renderChat();
    await sendFirstMessage("What is on my calendar tomorrow?");
    expect(card()).toBeNull();
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});
