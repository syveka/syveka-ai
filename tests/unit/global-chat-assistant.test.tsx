// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  pathname: "/dashboard",
  send: vi.fn(async () => undefined),
  state: {
    messages: [] as Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      streaming?: boolean;
    }>,
    isStreaming: false,
    error: null as string | null,
  },
  useChat: vi.fn(),
}));

vi.mock("@/hooks/use-chat", () => ({
  useChat: mocks.useChat,
}));

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mocks.pathname,
}));

import { GlobalChatAssistant } from "@/components/chat/global-chat-assistant";

const messages = {
  globalAssistant: {
    launcherLabel: "Open Syveka assistant",
    title: "Syveka Assistant",
    close: "Close assistant",
    greeting: "Hi! How can I help you?",
    placeholder: "Ask about your business…",
    send: "Send message",
    stop: "Stop generating",
    openFullChat: "Open full chat",
  },
  chat: {
    disclaimer: "AI answers can contain mistakes.",
    errors: {
      generic: "Something went wrong.",
      rate_limited: "Wait a moment.",
      entitlement_exceeded: "Monthly quota reached.",
      content_flagged: "Message blocked.",
      generation_failed: "Generation failed.",
      network_error: "Connection lost.",
      invalid_document: "Document unavailable.",
    },
  },
};

function renderAssistant() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GlobalChatAssistant />
    </NextIntlClientProvider>,
  );
}

describe("GlobalChatAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.pathname = "/dashboard";
    mocks.state = { messages: [], isStreaming: false, error: null };
    mocks.useChat.mockImplementation(
      (params: { initialMessages: typeof mocks.state.messages }) => ({
        ...mocks.state,
        messages: mocks.state.messages.length > 0 ? mocks.state.messages : params.initialMessages,
        send: mocks.send,
        abort: mocks.abort,
      }),
    );
  });

  afterEach(cleanup);

  it("is closed initially, opens with a localized greeting, and uses mobile-safe bounds", () => {
    renderAssistant();

    const launcher = screen.getByRole("button", { name: "Open Syveka assistant" });
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(launcher);

    const dialog = screen.getByRole("dialog", { name: "Syveka Assistant" });
    expect(dialog.textContent).toContain("Hi! How can I help you?");
    expect(dialog.className).toContain("100dvh-7rem");
    expect(dialog.className).toContain("100vw-2rem");
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(mocks.useChat).toHaveBeenCalledWith(
      expect.objectContaining({ navigateOnCreate: false }),
    );
  });

  it("sends through the authenticated chat hook with knowledge grounding enabled", () => {
    renderAssistant();
    fireEvent.click(screen.getByRole("button", { name: "Open Syveka assistant" }));

    const input = screen.getByRole("textbox", { name: "Ask about your business…" });
    fireEvent.change(input, { target: { value: "What are our opening hours?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.send).toHaveBeenCalledWith("What are our opening hours?", {
      useKnowledgeBase: true,
    });
  });

  it("closes with Escape and returns focus to the launcher", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    renderAssistant();
    const launcher = screen.getByRole("button", { name: "Open Syveka assistant" });
    fireEvent.click(launcher);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(launcher);
    vi.unstubAllGlobals();
  });

  it("fails safely with a generic localized error", () => {
    mocks.state.error = "provider_unavailable";
    renderAssistant();
    fireEvent.click(screen.getByRole("button", { name: "Open Syveka assistant" }));

    expect(screen.getByRole("alert").textContent).toContain("Something went wrong.");
  });

  it("does not duplicate the full chat UI on chat routes", () => {
    mocks.pathname = "/chat/conversation-1";
    renderAssistant();

    expect(screen.queryByRole("button", { name: "Open Syveka assistant" })).toBeNull();
  });
});
