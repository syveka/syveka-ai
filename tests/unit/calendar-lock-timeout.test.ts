import { describe, expect, it, vi } from "vitest";

/**
 * Waiting for an organization's calendar lock is bounded, and a timeout is a
 * distinct, retryable outcome. The real wait against Postgres is proven in
 * calendar-lock-timeout.postgres.test.ts.
 */
import { CalendarBusyError, lockOrgCalendar } from "@/server/calendar/locks";

const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
  code: "P2010",
  meta: { driverAdapterError: { cause: { originalCode: "55P03", code: "55P03" } } },
});

function txRejecting(error: unknown) {
  return { $executeRaw: vi.fn(async () => Promise.reject(error)) } as never;
}

describe("lockOrgCalendar", () => {
  it("sets the wait limit in the same statement that takes the lock", async () => {
    const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    await lockOrgCalendar({ $executeRaw: executeRaw } as never, "org-a");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = (executeRaw.mock.calls[0]![0] as TemplateStringsArray).join("?");
    expect(sql).toContain("set_config('lock_timeout', '3000ms', true)");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(executeRaw.mock.calls[0]![1]).toBe("org-a");
  });

  it("reports a Postgres lock timeout as CalendarBusyError", async () => {
    await expect(lockOrgCalendar(txRejecting(lockTimeout), "org-a")).rejects.toBeInstanceOf(
      CalendarBusyError,
    );
  });

  it("leaves other database errors unchanged", async () => {
    const otherSqlState = Object.assign(new Error("deadlock detected"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
    await expect(lockOrgCalendar(txRejecting(otherSqlState), "org-a")).rejects.toBe(otherSqlState);
    const expired = Object.assign(new Error("expired transaction"), { code: "P2028" });
    await expect(lockOrgCalendar(txRejecting(expired), "org-a")).rejects.toBe(expired);
  });
});
