// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * The Knowledge list showed Queued/Processing until a manual page refresh.
 * While any document is not final it now re-reads the list, and stops once
 * every document is READY, FAILED or stalled.
 */
const h = vi.hoisted(() => {
  const refresh = vi.fn();
  return { refresh, router: { refresh } };
});
vi.mock("@/i18n/routing", () => ({ useRouter: () => h.router }));

import { DOCUMENT_STATUS_POLL_MS } from "@/lib/knowledge/processing";
import { DocumentTable, type DocumentRow } from "@/components/knowledge/document-table";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);
const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: "d1",
  title: "Price list",
  sourceType: "UPLOAD",
  status: "PENDING",
  error: null,
  chunkCount: 0,
  sizeBytes: null,
  createdAt: "2026-11-20T12:00:00.000Z",
  ...over,
});
const table = (documents: DocumentRow[]) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <DocumentTable documents={documents} />
  </NextIntlClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  h.refresh.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Knowledge list status polling", () => {
  it.each(["PENDING", "PROCESSING"])("re-reads the list while a document is %s", (status) => {
    render(table([row({ id: "a", status: "READY" }), row({ id: "b", status })]));

    vi.advanceTimersByTime(DOCUMENT_STATUS_POLL_MS - 1);
    expect(h.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops once the refreshed list has only final documents", () => {
    const { rerender } = render(table([row({ status: "PROCESSING" })]));
    vi.advanceTimersByTime(DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    rerender(table([row({ status: "READY", chunkCount: 4 })]));
    vi.advanceTimersByTime(10 * DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("never polls for READY, FAILED or stalled documents", () => {
    render(
      table([
        row({ id: "a", status: "READY" }),
        row({ id: "b", status: "FAILED", error: "The document could not be read." }),
        row({ id: "c", status: "PROCESSING", stalled: true }),
      ]),
    );
    vi.advanceTimersByTime(10 * DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("skips the refresh while the tab is hidden and stops on unmount", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { unmount } = render(table([row({ status: "PENDING" })]));
    vi.advanceTimersByTime(3 * DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    vi.advanceTimersByTime(DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(10 * DOCUMENT_STATUS_POLL_MS);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });
});
