// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Composer } from "@/components/chat/composer";
import { installFakeMedia, uninstallFakeMedia } from "./fake-media";

/**
 * The attach control is only offered to a user the server would let create a
 * Knowledge Base document (chat attachments are such documents). The server
 * check in /api/v1/ai/files is the boundary; this keeps the UI honest about it.
 */
type Messages = { chat: { placeholder: string; send: string; attachFile: string } };
const messages: Messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installFakeMedia();
  fetchMock = vi.fn(async (url: string) => {
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  uninstallFakeMedia();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Composer onSend={onSend} onAbort={vi.fn()} disabled={false} {...props} />
    </NextIntlClientProvider>,
  );
  return { onSend };
}

describe("Composer attachments permission", () => {
  it("offers the attach control to a user who may create Knowledge Base documents", () => {
    renderComposer({ attachmentsEnabled: true });
    expect(screen.getByTitle(messages.chat.attachFile)).toBeTruthy();
  });

  it("hides the attach control from a user without kb:write (and by default)", () => {
    renderComposer({ attachmentsEnabled: false });
    expect(screen.queryByTitle(messages.chat.attachFile)).toBeNull();
    cleanup();
    renderComposer();
    expect(screen.queryByTitle(messages.chat.attachFile)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("text-only chat still works without the attach control", () => {
    const { onSend } = renderComposer({ attachmentsEnabled: false });
    const textarea = screen.getByPlaceholderText(messages.chat.placeholder);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: messages.chat.send }));
    expect(onSend).toHaveBeenCalledWith("hello", { useKnowledgeBase: true, documentIds: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
