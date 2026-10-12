// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * A Knowledge document whose embed job stopped for good (every QStash retry used,
 * or the platform killed the last run) used to show "Queued"/"Processing" forever,
 * with a refresh button that could never change it. Past the stalled window it is
 * shown as failed, with what to do. Nothing is written on read.
 */
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, args: [] as unknown[] }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    document: {
      findMany: async (args: unknown) => {
        h.args.push(args);
        return h.rows;
      },
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  }),
  unscopedPrisma: {},
}));
vi.mock("@/server/supabase/server", () => ({ createSupabaseAdmin: vi.fn() }));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/i18n/routing", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  DOCUMENT_PROCESSING_RECLAIM_MS,
  DOCUMENT_STALLED_AFTER_MS,
  isDocumentStalled,
} from "@/lib/knowledge/processing";
import { listDocuments } from "@/server/services/documents";
import { DocumentTable, type DocumentRow } from "@/components/knowledge/document-table";

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const NOW = new Date("2026-10-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60_000;

afterEach(cleanup);

describe("isDocumentStalled", () => {
  it.each(["PENDING", "PROCESSING"])(
    "%s past the window is stalled, within it is not",
    (status) => {
      expect(isDocumentStalled({ status, updatedAt: ago(2 * HOUR + 1) }, NOW)).toBe(true);
      expect(isDocumentStalled({ status, updatedAt: ago(2 * HOUR) }, NOW)).toBe(false);
      expect(isDocumentStalled({ status, updatedAt: ago(5 * 60_000) }, NOW)).toBe(false);
    },
  );

  it.each(["READY", "FAILED"])("%s is never stalled, however old", (status) => {
    expect(isDocumentStalled({ status, updatedAt: ago(30 * 24 * HOUR) }, NOW)).toBe(false);
  });

  it("outlasts every retry and run: longer than the reclaim window and QStash's ~35 min of retries", () => {
    expect(DOCUMENT_STALLED_AFTER_MS).toBeGreaterThan(DOCUMENT_PROCESSING_RECLAIM_MS);
    expect(DOCUMENT_STALLED_AFTER_MS).toBeGreaterThan(35 * 60_000 + 4 * 300_000);
    // Above the job's 300 s maxDuration, so a live run is never taken over.
    expect(DOCUMENT_PROCESSING_RECLAIM_MS).toBeGreaterThan(300_000);
  });
});

describe("listDocuments", () => {
  it("flags stalled documents, reads updatedAt but doesn't return it, and writes nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h.rows = [
      { id: "stuck", status: "PROCESSING", updatedAt: ago(3 * HOUR), title: "a" },
      { id: "queued", status: "PENDING", updatedAt: ago(10 * 60_000), title: "b" },
      { id: "ready", status: "READY", updatedAt: ago(48 * HOUR), title: "c" },
    ];
    h.args = [];

    const docs = await listDocuments({ orgId: "org-a" } as never);
    vi.useRealTimers();

    expect(docs.map((d) => [d.id, d.status, d.stalled])).toEqual([
      ["stuck", "PROCESSING", true],
      ["queued", "PENDING", false],
      ["ready", "READY", false],
    ]);
    expect(docs.every((d) => !("updatedAt" in d))).toBe(true);
    expect((h.args[0] as { select: Record<string, boolean> }).select.updatedAt).toBe(true);
  });
});

describe("Knowledge document table", () => {
  const row = (over: Partial<DocumentRow>): DocumentRow => ({
    id: "d1",
    title: "Price list",
    sourceType: "UPLOAD",
    status: "PROCESSING",
    error: null,
    chunkCount: 0,
    sizeBytes: null,
    createdAt: NOW.toISOString(),
    ...over,
  });
  const show = (docs: DocumentRow[], locale = "en") =>
    render(
      <NextIntlClientProvider locale={locale} messages={load(locale)}>
        <DocumentTable documents={docs} />
      </NextIntlClientProvider>,
    );

  it.each(["en", "fi", "ar"])(
    "a stalled document shows Failed and what to do, with no refresh button (%s)",
    (locale) => {
      const k = load(locale).knowledge;
      const { container } = show([row({ stalled: true })], locale);

      expect(k.stalled).toBeTruthy();
      expect(screen.getByText(k.stalled)).toBeTruthy();
      expect(screen.getByText(k.status.FAILED)).toBeTruthy();
      expect(screen.queryByText(k.status.PROCESSING)).toBeNull();
      // Only the delete button remains.
      expect(container.querySelectorAll("button")).toHaveLength(1);
    },
  );

  it("a document still within its window keeps Processing and the refresh button", () => {
    const k = load("en").knowledge;
    const { container } = show([row({ stalled: false })]);

    expect(screen.getByText(k.status.PROCESSING)).toBeTruthy();
    expect(screen.queryByText(k.stalled)).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("a failed document still shows its own error", () => {
    show([row({ status: "FAILED", error: "The document could not be read." })]);
    expect(screen.getByText("The document could not be read.")).toBeTruthy();
  });
});
