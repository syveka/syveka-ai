import { describe, expect, it, vi } from "vitest";
import {
  BUSY_ROW_MAX_PAGES,
  BUSY_ROW_ORDER,
  BUSY_ROW_PAGE_SIZE,
  busyIntervals,
  loadBusyRows,
  type BusyRowPage,
} from "@/server/calendar/busy";
import { findManyPagedOver } from "./helpers/calendar-event-where";

/**
 * Busy-time queries used one capped query (newest first, take 500/1000). Their
 * candidate set includes every recurring series that ever started before the
 * window, so an old series still occupying the window could be left out and
 * its time offered as free. Rows are now paged; past the page limit the
 * window is reported incomplete and counted as busy.
 */

const MAX_ROWS = BUSY_ROW_PAGE_SIZE * BUSY_ROW_MAX_PAGES;

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${String(i).padStart(5, "0")}`,
    startsAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    endsAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000),
    recurrenceRule: null,
    timezone: "UTC",
  }));
}

function pager(all: ReturnType<typeof rows>) {
  const findMany = findManyPagedOver(all);
  return vi.fn((page: BusyRowPage) => findMany({ orderBy: BUSY_ROW_ORDER as never, ...page }));
}

describe("loadBusyRows", () => {
  it("reads every row across pages, newest first, without repeats", async () => {
    const all = rows(1201);
    const fetchPage = pager(all);
    const { rows: loaded, complete } = await loadBusyRows(fetchPage);
    expect(complete).toBe(true);
    expect(loaded).toHaveLength(1201);
    expect(new Set(loaded.map((r) => r.id)).size).toBe(1201);
    expect(loaded[0]!.id).toBe("row-01200");
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[1]![0]).toEqual({
      take: BUSY_ROW_PAGE_SIZE,
      skip: 1,
      cursor: { id: loaded[BUSY_ROW_PAGE_SIZE - 1]!.id },
    });
  });

  it("a single short page is one query", async () => {
    const fetchPage = pager(rows(3));
    expect((await loadBusyRows(fetchPage)).complete).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("exactly the page limit is complete (one probe confirms nothing is left)", async () => {
    const fetchPage = pager(rows(MAX_ROWS));
    const { rows: loaded, complete } = await loadBusyRows(fetchPage);
    expect(complete).toBe(true);
    expect(loaded).toHaveLength(MAX_ROWS);
    expect(fetchPage).toHaveBeenCalledTimes(BUSY_ROW_MAX_PAGES + 1);
  });

  it("one row past the limit is incomplete, and the work stays bounded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchPage = pager(rows(MAX_ROWS + 1));
    const { rows: loaded, complete } = await loadBusyRows(fetchPage);
    expect(complete).toBe(false);
    expect(loaded).toHaveLength(MAX_ROWS);
    expect(fetchPage).toHaveBeenCalledTimes(BUSY_ROW_MAX_PAGES + 1);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "calendar_busy_rows_incomplete", loaded: MAX_ROWS }),
    );
    warn.mockRestore();
  });
});

describe("busyIntervals with incomplete rows", () => {
  const from = new Date("2026-10-12T00:00:00Z");
  const to = new Date("2026-10-13T00:00:00Z");

  it("counts exactly the whole window as busy (nothing outside it)", () => {
    expect(busyIntervals([], from, to, { complete: false })).toEqual([
      { startsAt: from, endsAt: to },
    ]);
  });

  it("complete rows behave as before", () => {
    const row = {
      startsAt: new Date("2026-10-12T10:00:00Z"),
      endsAt: new Date("2026-10-12T11:00:00Z"),
      recurrenceRule: null,
    };
    expect(busyIntervals([row], from, to, { complete: true })).toEqual([
      { startsAt: row.startsAt, endsAt: row.endsAt },
    ]);
    expect(busyIntervals([row], from, to)).toEqual([
      { startsAt: row.startsAt, endsAt: row.endsAt },
    ]);
  });
});
