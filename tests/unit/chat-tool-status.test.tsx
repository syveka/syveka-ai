// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Chat never shows tool names or tool chips: while a tool runs, the reply
 * shows one plain, localized status ("Checking calendar…"), and nothing about
 * tools stays on the finished reply. Which tools ran is saved server-side
 * (Message.toolCalls), not shown.
 */
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
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

import { ChatThread } from "@/components/chat/chat-thread";
import { ChatView } from "@/components/chat/chat-view";
import type { UiMessage } from "@/hooks/use-chat";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const en = load("en");
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

const TOOLS = [
  "searchKnowledgeBase",
  "searchContacts",
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
  "proposeBusinessDnaUpdate",
];
/** What the chips used to say; none of it may appear any more. */
const OLD_CHIP_TEXT = [
  "Knowledge base",
  "Contacts",
  "New contact",
  "Activity",
  "Calendar availability",
  "Booking",
  "Business DNA",
];

function show(message: Partial<UiMessage>, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={load(locale)}>
      <ChatThread messages={[{ id: "m1", role: "assistant", content: "Done.", ...message }]} />
    </NextIntlClientProvider>,
  );
}

function expectNoToolTraces(container: HTMLElement) {
  const text = container.textContent ?? "";
  for (const tool of TOOLS) expect(text).not.toContain(tool);
  for (const chip of OLD_CHIP_TEXT) expect(screen.queryByText(chip)).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
}

function renderChat() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChatView conversationId={CONVERSATION} initialMessages={[]} />
    </NextIntlClientProvider>,
  );
}

async function send(text: string) {
  const input = screen.getByPlaceholderText(en.chat.placeholder);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("while a tool runs", () => {
  it.each(["en", "fi", "ar"])(
    "every tool shows its plain status, no icon and no tool name (%s)",
    (locale) => {
      const status = load(locale).chat.toolStatus as Record<string, string>;
      for (const tool of TOOLS) {
        const { container, unmount } = show(
          { content: "", streaming: true, tools: [tool] },
          locale,
        );
        expect(status[tool], `${locale} status for ${tool}`).toBeTruthy();
        const line = screen.getByRole("status");
        expect(line.textContent).toBe(status[tool]);
        expect(line.querySelector("svg")).toBeNull();
        expect(container.textContent).not.toContain(tool);
        unmount();
      }
    },
  );

  it("the EN calendar lookup reads 'Checking calendar…'", () => {
    show({ content: "", streaming: true, tools: ["getCalendarAvailability"] });
    expect(screen.getByRole("status").textContent).toBe("Checking calendar…");
  });

  it("a tool without its own status shows the default, never its name", () => {
    const { container } = show({ content: "", streaming: true, tools: ["someFutureTool"] });
    expect(screen.getByRole("status").textContent).toBe(en.chat.toolStatus.default);
    expect(container.textContent).not.toContain("someFutureTool");
  });
});

describe("a finished reply", () => {
  it("shows no tool chip, label, icon or name for any tool", () => {
    const { container } = show({ tools: [...TOOLS, "someFutureTool"], streaming: false });
    expectNoToolTraces(container);
    expect(container.textContent).not.toContain("someFutureTool");
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("a reopened reply shows only its text", () => {
    const { container } = show({ content: "You're free at 09:00." });
    expectNoToolTraces(container);
    expect(screen.getByText("You're free at 09:00.")).toBeTruthy();
  });

  it("still shows a proposed action's confirmation card", () => {
    show({
      content: "When you confirm, I'll create the contact.",
      actions: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          tool: "createContact",
          digest: "a".repeat(64),
          conversationId: CONVERSATION,
          expiresAt: Date.now() + 600_000,
          details: { tool: "createContact", firstName: "QA" },
        } as never,
      ],
    });
    expect(screen.getByRole("region", { name: en.chat.actions.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.chat.actions.confirm })).toBeTruthy();
    expect(screen.queryByText("New contact")).toBeNull();
  });
});

describe("live chat stream", () => {
  it("shows 'Checking calendar…' only while the lookup runs, then just the answer", async () => {
    const encoder = new TextEncoder();
    let push!: (frame: object) => void;
    let close!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (f) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
            close = () => controller.close();
          },
        });
        return new Response(body);
      }),
    );
    const { container } = renderChat();
    await send("Am I free on 2026-10-19?");
    const step = (f: object) =>
      act(async () => {
        push(f);
        await new Promise((r) => setTimeout(r, 0));
      });

    await step({ type: "meta", conversationId: CONVERSATION, messageId: "m1" });
    await step({ type: "tool", name: "getCalendarAvailability", status: "start" });
    expect(screen.getByRole("status").textContent).toBe("Checking calendar…");
    expect(container.textContent).not.toContain("getCalendarAvailability");

    await step({ type: "tool", name: "getCalendarAvailability", status: "done" });
    expect(screen.queryByRole("status")).toBeNull();

    await step({ type: "text", delta: "You're free at 09:00 and 15:00." });
    await step({ type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 });
    await act(async () => {
      close();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText("You're free at 09:00 and 15:00.")).toBeTruthy();
    expectNoToolTraces(container);
  });

  it("a stream that ends while a tool runs leaves no status behind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const frames = [
          { type: "tool", name: "searchContacts", status: "start" },
          { type: "error", code: "generation_failed" },
        ];
        return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
      }),
    );
    const { container } = renderChat();
    await send("Find Jane");
    await act(async () => {});

    expect(screen.queryByText(en.chat.toolStatus.searchContacts)).toBeNull();
    expect(container.textContent).not.toContain("searchContacts");
  });
});
