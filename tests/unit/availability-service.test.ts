import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving a schedule replaces its weekly rules and date overrides. The
 * replacement is one transaction: if any part of it fails, the schedule keeps
 * its previous rules instead of being left with none (which would make every
 * booking page that uses it offer no slots at all).
 *
 * The fake database keeps rows in memory and gives $transaction real
 * commit/rollback semantics: the callback works on a copy, which replaces the
 * stored rows only if the callback succeeds.
 */
type Row = Record<string, unknown>;
type Store = { rules: Row[]; overrides: Row[] };

const s = vi.hoisted(() => ({
  store: { rules: [], overrides: [] } as { rules: Row[]; overrides: Row[] },
  failOverrideInsert: false,
}));

function tables(store: Store) {
  const table = (name: "rules" | "overrides") => ({
    deleteMany: vi.fn(async ({ where }: { where: { scheduleId: string } }) => {
      const before = store[name].length;
      store[name] = store[name].filter((r) => r.scheduleId !== where.scheduleId);
      return { count: before - store[name].length };
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      if (name === "overrides" && s.failOverrideInsert) throw new Error("connection reset");
      store[name].push(...data);
      return { count: data.length };
    }),
  });
  return { availabilityRule: table("rules"), availabilityOverride: table("overrides") };
}

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    availabilitySchedule: {
      findFirst: vi.fn(async () => ({ id: "sched-1", userId: "user-1" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  }),
  unscopedPrisma: {
    // Writes outside a transaction go straight to the store.
    get availabilityRule() {
      return tables(s.store).availabilityRule;
    },
    get availabilityOverride() {
      return tables(s.store).availabilityOverride;
    },
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof tables>) => unknown) => {
      const draft: Store = { rules: [...s.store.rules], overrides: [...s.store.overrides] };
      const result = await fn(tables(draft)); // throws → draft discarded (rollback)
      s.store = draft;
      return result;
    }),
  },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { saveSchedule } from "@/server/services/availability";

const ctx = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  email: "owner@example.test",
  role: "OWNER" as const,
  locale: "FI" as const,
};

const OLD_RULE = { scheduleId: "sched-1", weekday: 1, startMinute: 540, endMinute: 1020 };

const input = {
  name: "Salon",
  timezone: "Europe/Helsinki",
  isDefault: true,
  rules: [{ weekday: 2, startMinute: 600, endMinute: 960 }],
  overrides: [
    {
      date: "2026-12-24",
      startMinute: null,
      endMinute: null,
      isUnavailable: true,
    },
  ],
} as unknown as Parameters<typeof saveSchedule>[1];

beforeEach(() => {
  s.store = { rules: [{ ...OLD_RULE }], overrides: [] };
  s.failOverrideInsert = false;
});

describe("saveSchedule replaces rules and overrides atomically", () => {
  it("a failure while writing overrides keeps the previous rules", async () => {
    s.failOverrideInsert = true;
    await expect(saveSchedule(ctx, input, "sched-1")).rejects.toThrow("connection reset");
    expect(s.store.rules).toEqual([OLD_RULE]);
    expect(s.store.overrides).toEqual([]);
  });

  it("a successful save stores exactly the new rules and overrides", async () => {
    await expect(saveSchedule(ctx, input, "sched-1")).resolves.toBe("sched-1");
    expect(s.store.rules).toEqual([
      { scheduleId: "sched-1", weekday: 2, startMinute: 600, endMinute: 960 },
    ]);
    expect(s.store.overrides).toEqual([
      expect.objectContaining({ scheduleId: "sched-1", isUnavailable: true }),
    ]);
  });
});
