// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
/** Whether a live voice session is running (switched by the live-voice tests). */
const live = vi.hoisted(() => ({ active: false }));
vi.mock("@/hooks/use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    phase: live.active ? "listening" : "idle",
    active: live.active,
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
  live.active = false;
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
    ["an unavailable service", { status: 503, body: { error: { code: "service_unavailable" } } }],
    ["a rate limit", { status: 429, body: { error: { code: "rate_limited" } } }],
  ])(
    "D. %s: the request can be sent again, so the card stays and nothing navigates",
    async (_l, failure) => {
      decision = failure;
      renderChat();
      await sendFirstMessage();
      await click(en.chat.actions.confirm);
      expect(card()).not.toBeNull();
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.refresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["expired", { status: 404, body: { error: { code: "not_found" } } }, "expired"],
    // The decision was consumed: whatever happened, it can't be sent again.
    [
      "failed while running",
      { status: 500, body: { error: { code: "action_failed" } } },
      "unknown",
    ],
    [
      "refused by role",
      { status: 403, body: { error: { code: "permission_denied" } } },
      "permission",
    ],
  ])("an action %s is settled: it then navigates once", async (_l, failure, state) => {
    decision = failure;
    renderChat();
    await sendFirstMessage();
    await click(en.chat.actions.confirm);
    expect(screen.getByRole("status").textContent).toBe(
      (en.chat.actions.result as Record<string, string>)[state],
    );
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

describe("interaction with live voice's navigation deferral", () => {
  /** Re-renders the same new-chat view after switching the live session on or off. */
  const setLive = (view: ReturnType<typeof renderChat>, active: boolean) => {
    live.active = active;
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatView initialMessages={[]} />
      </NextIntlClientProvider>,
    );
  };

  it("ending live voice doesn't redirect while an action is still pending", async () => {
    const view = renderChat();
    await sendFirstMessage();
    setLive(view, true);
    setLive(view, false); // live ended: its flush must not bypass the pending card
    expect(card()).not.toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
    await click(en.chat.actions.cancel); // then settling it redirects once
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
  });

  it("settling the last pending action during live voice waits for voice to end, then redirects once", async () => {
    const view = renderChat();
    await sendFirstMessage();
    setLive(view, true);
    await click(en.chat.actions.cancel);
    expect(nav.replace).not.toHaveBeenCalled(); // settled, but the live session holds it
    setLive(view, false);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    setLive(view, false); // further renders never redirect again
    expect(nav.replace).toHaveBeenCalledTimes(1);
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

/**
 * A correction in a new chat: the first reply proposes A, the user corrects
 * a fact in the same view, the second reply proposes B about the same field.
 * The held redirect passes from A (replaced) to B; canceling B releases it
 * and re-offers A in the same commit. The invariant this pins: a click on
 * the re-offered card inside that window can only send A's own request
 * (A's id, digest and conversation), nothing navigates twice, and no other
 * request is repeated. The remount the redirect causes restores A from the
 * server (pending, or its recorded outcome); what it shows is proven in
 * chat-page-restored-actions.test.tsx.
 */
describe("a correction in a new chat and the held redirect", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const dna = (id: string, close: string) => ({
    id,
    tool: "proposeBusinessDnaUpdate",
    digest: id[0]!.repeat(64),
    conversationId: NEW_CHAT,
    expiresAt: Date.now() + 600_000,
    details: {
      tool: "proposeBusinessDnaUpdate",
      missingAfter: [],
      changes: [
        {
          field: "openingHours",
          kind: "modified",
          before: {
            type: "hours",
            days: [{ day: "monday", closed: false, open: "08:00", close: "17:00" }],
          },
          after: {
            type: "hours",
            days: [{ day: "monday", closed: false, open: "08:00", close: close }],
          },
        },
      ],
    },
  });
  /** Decision requests wait until the test answers them (no sleeps). */
  let pending: Map<string, { body: unknown; resolve: (r: Response) => void }>;
  let decisionBodies: Array<{ url: string; body: Record<string, unknown> }>;

  const answer = async (actionId: string, status: number, body: unknown) => {
    const entry = pending.get(`/api/v1/ai/actions/${actionId}`);
    if (!entry) throw new Error(`no request in flight for ${actionId}`);
    pending.delete(`/api/v1/ai/actions/${actionId}`);
    await act(async () => {
      entry.resolve(new Response(JSON.stringify(body), { status }));
    });
  };
  const cardOf = (index: number) =>
    screen.getAllByRole("region", { name: en.chat.actions.title })[index]!;
  const buttonIn = (card: HTMLElement, name: string) =>
    Array.from(card.querySelectorAll("button")).find((b) => b.textContent?.includes(name));
  const clickIn = async (card: HTMLElement, name: string) => {
    const button = buttonIn(card, name);
    if (!button) throw new Error(`no "${name}" button in the card`);
    await act(async () => {
      fireEvent.click(button);
    });
  };

  beforeEach(() => {
    pending = new Map();
    decisionBodies = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.startsWith("/api/v1/ai/actions/")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        decisionBodies.push({ url: target, body });
        return new Promise<Response>((resolve) => pending.set(target, { body, resolve }));
      }
      const sent = JSON.parse(String(init?.body)) as { conversationId?: string; message: string };
      // The first message proposes A; the correction (a later message in the
      // same, now known, conversation) proposes B about the same field.
      const proposal = sent.conversationId ? dna(B, "16:00") : dna(A, "17:00");
      const frames = [
        { type: "meta", conversationId: NEW_CHAT, messageId: sent.conversationId ? "m2" : "m1" },
        { type: "action", action: proposal },
        { type: "text", delta: "When you confirm, I'll update the opening hours." },
        { type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
    });
  });

  it("the hold passes from the replaced card to the correction; canceling the correction releases it and re-offers the earlier card; a click in that window sends only that card's own request", async () => {
    renderChat();
    await sendFirstMessage("We are open Monday until 17");
    expect(buttonIn(cardOf(0), en.chat.actions.confirm)).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();

    await sendFirstMessage("Actually we close at 16");
    const [a, b] = [cardOf(0), cardOf(1)];
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.superseded);
    expect(buttonIn(a, en.chat.actions.confirm)).toBeUndefined();
    expect(buttonIn(b, en.chat.actions.confirm)).toBeTruthy();
    // A is released, but B still holds the redirect.
    expect(nav.replace).not.toHaveBeenCalled();

    await clickIn(b, en.chat.actions.cancel);
    expect(pending.size).toBe(1);
    expect(nav.replace).not.toHaveBeenCalled(); // in flight: still held
    await answer(B, 200, { data: { status: "canceled" } });
    // Released exactly once, and A is offered again in the same commit.
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(`/chat/${NEW_CHAT}`);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(within(b).getByRole("status").textContent).toBe(en.chat.actions.result.canceled);
    expect(buttonIn(a, en.chat.actions.confirm)).toBeTruthy();

    // The redirect window: the user clicks Confirm on the re-offered card
    // before the remount. Only A's own, fully bound request goes out.
    await clickIn(a, en.chat.actions.confirm);
    expect(decisionBodies).toHaveLength(2);
    expect(decisionBodies[1]).toEqual({
      url: `/api/v1/ai/actions/${A}`,
      body: { decision: "confirm", conversationId: NEW_CHAT, digest: "a".repeat(64) },
    });
    await answer(A, 200, { data: { status: "done", tool: "proposeBusinessDnaUpdate" } });
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.done);
    // Nothing navigates again, and nothing else was sent.
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(decisionBodies).toHaveLength(2);
    expect(pending.size).toBe(0);
  });

  it("applying the correction releases the redirect and keeps the earlier card replaced", async () => {
    renderChat();
    await sendFirstMessage("We are open Monday until 17");
    await sendFirstMessage("Actually we close at 16");
    const [a, b] = [cardOf(0), cardOf(1)];
    await clickIn(b, en.chat.actions.confirm);
    await answer(B, 200, { data: { status: "done", tool: "proposeBusinessDnaUpdate" } });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.superseded);
    expect(buttonIn(a, en.chat.actions.confirm)).toBeUndefined();
    expect(decisionBodies).toHaveLength(1);
  });

  it("a decision that can be sent again holds the redirect until its repeat settles; then it navigates once", async () => {
    renderChat();
    await sendFirstMessage("We are open Monday until 17");
    const a = cardOf(0);
    await clickIn(a, en.chat.actions.confirm);
    await answer(A, 429, { error: { code: "rate_limited" } });
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.rateLimited);
    expect(nav.replace).not.toHaveBeenCalled();
    await clickIn(a, en.chat.actions.tryAgain);
    expect(nav.replace).not.toHaveBeenCalled();
    await answer(A, 409, { error: { code: "already_decided", outcome: "done" } });
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(decisionBodies.map((d) => d.url)).toEqual([
      `/api/v1/ai/actions/${A}`,
      `/api/v1/ai/actions/${A}`,
    ]);
  });

  it("a card awaiting its repeat is replaced by the correction too: the hold passes to the correction, and the repeat returns when the correction is withdrawn", async () => {
    renderChat();
    await sendFirstMessage("We are open Monday until 17");
    await clickIn(cardOf(0), en.chat.actions.confirm);
    await answer(A, 503, { error: { code: "service_unavailable" } });
    expect(buttonIn(cardOf(0), en.chat.actions.tryAgain)).toBeTruthy();

    await sendFirstMessage("Actually we close at 16");
    const [a, b] = [cardOf(0), cardOf(1)];
    expect(within(a).getByRole("status").textContent).toBe(en.chat.actions.result.superseded);
    expect(buttonIn(a, en.chat.actions.tryAgain)).toBeUndefined();
    expect(nav.replace).not.toHaveBeenCalled(); // B holds it

    await clickIn(b, en.chat.actions.cancel);
    await answer(B, 200, { data: { status: "canceled" } });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(buttonIn(a, en.chat.actions.tryAgain)).toBeTruthy();
    expect(decisionBodies).toHaveLength(2);
  });
});
