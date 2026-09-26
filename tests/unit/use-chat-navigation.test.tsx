// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

import { useChat } from "@/hooks/use-chat";

function chatResponse(conversationId = "11111111-1111-4111-8111-111111111111") {
  const body = [
    `data: ${JSON.stringify({ type: "meta", conversationId, messageId: "message-1" })}`,
    `data: ${JSON.stringify({ type: "text", delta: "Hello" })}`,
    `data: ${JSON.stringify({ type: "done", tokensIn: 1, tokensOut: 1, estimatedCostUsd: 0 })}`,
    "",
  ].join("\n\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("useChat new-conversation navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse()),
    );
  });

  it("keeps an embedded assistant on the current route", async () => {
    const { result } = renderHook(() => useChat({ initialMessages: [], navigateOnCreate: false }));

    await act(async () => {
      await result.current.send("Hello");
    });

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("preserves the full chat's existing navigation behavior by default", async () => {
    const { result } = renderHook(() => useChat({ initialMessages: [] }));

    await act(async () => {
      await result.current.send("Hello");
    });

    expect(mocks.replace).toHaveBeenCalledWith("/chat/11111111-1111-4111-8111-111111111111");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
