// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Composer } from "@/components/chat/composer";
import { installFakeMedia, uninstallFakeMedia } from "./fake-media";

/**
 * A chat attachment is a Knowledge Base document, so it counts against the
 * plan's storage. The server refuses with 402 at the upload link, or at
 * finalize when storage filled up in between; the composer then says the
 * storage limit was reached, not that the upload failed.
 */
type Messages = {
  chat: { attachFile: string; errors: { storage_quota: string; upload_failed: string } };
};
const messages: Messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const REFUSED = { error: { code: "entitlement_exceeded", limit: "kbStorageMb" } };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installFakeMedia();
  vi.stubGlobal("fetch", (fetchMock = vi.fn()));
});
afterEach(() => {
  cleanup();
  uninstallFakeMedia();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function attach() {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Composer onSend={vi.fn()} onAbort={vi.fn()} disabled={false} attachmentsEnabled />
    </NextIntlClientProvider>,
  );
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["%PDF-1.4"], "menu.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("chat attachment over the storage limit", () => {
  it("a 402 for the upload link shows the storage limit message", async () => {
    fetchMock.mockResolvedValueOnce(json(402, REFUSED));
    attach();
    expect(await screen.findByText(messages.chat.errors.storage_quota)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 402 at finalize shows the storage limit message", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, { data: { uploadIntentId: "intent-1", signedUrl: "https://storage.test/x" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json(402, REFUSED));
    attach();
    expect(await screen.findByText(messages.chat.errors.storage_quota)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("any other failure still says the upload failed", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: "failed" }));
    attach();
    await waitFor(() => expect(screen.getByText(messages.chat.errors.upload_failed)).toBeTruthy());
  });
});
