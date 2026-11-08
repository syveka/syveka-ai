import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving a schedule writes the schedule itself (name, timezone, default),
 * clears the user's other defaults, and replaces its weekly rules and date
 * overrides. All of it is one transaction: if any part fails, the schedule
 * keeps its previous state, instead of being left with none of its rules
 * (every booking page using it would offer no slots) or with a new timezone
 * over its old rules (every slot would move).
 *
 * The fake database keeps rows in memory and gives $transaction real
 * commit/rollback semantics: the callback works on a copy, which replaces the
 * stored rows only if the callback succeeds.
 */
type Row = Record<string, unknown>;
type Store = { schedules: Row[]; rules: Row[]; overrides: Row[] };

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

const s = vi.hoisted(() => ({
  store: { schedules: [], rules: [], overrides: [] } as {
    schedules: Row[];
    rules: Row[];
    overrides: Row[];
  },
  failOverrideInsert: false,
}));

type Where = Record<string, unknown>;
const matches = (row: Row, where: Where) =>
  Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && "not" in value
      ? row[key] !== (value as { not: unknown }).not
      : row[key] === value,
  );

function tables(store: Store) {
  const children = (name: "rules" | "overrides") => ({
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matches(r, where));
      return { count: before - store[name].length };
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      if (name === "overrides" && s.failOverrideInsert) throw new Error("connection reset");
      store[name].push(...data);
      return { count: data.length };
    }),
  });
  return {
    availabilitySchedule: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `sched-${store.schedules.length + 1}`, ...data };
        store.schedules.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        let count = 0;
        store.schedules = store.schedules.map((r) => {
          if (!matches(r, where)) return r;
          count += 1;
          return { ...r, ...data };
        });
        return { count };
      }),
    },
    availabilityRule: children("rules"),
    availabilityOverride: children("overrides"),
  };
}

vi.mock("@/server/db/tenant", () => ({
  tenantDb: (orgId: string) => ({
    // Writes through tenantDb (outside any transaction) go straight to the store.
    availabilitySchedule: {
      ...tables(s.store).availabilitySchedule,
      update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        s.store.schedules = s.store.schedules.map((r) =>
          r.organizationId === orgId && matches(r, where) ? { ...r, ...data } : r,
        );
        return {};
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          s.store.schedules.find((r) => r.organizationId === orgId && matches(r, where)) ?? null,
      ),
    },
  }),
  unscopedPrisma: {
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof tables>) => unknown) => {
      const draft: Store = structuredClone(s.store);
      const result = await fn(tables(draft)); // throws → draft discarded (rollback)
      s.store = draft;
      return result;
    }),
  },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { saveSchedule } from "@/server/services/availability";

const ctx = {
  orgId: ORG,
  userId: "user-1",
  email: "owner@example.test",
  role: "OWNER" as const,
  locale: "FI" as const,
};

const SALON = {
  id: "sched-1",
  organizationId: ORG,
  userId: "user-1",
  name: "Salon",
  timezone: "Europe/Helsinki",
  isDefault: true,
};
const OLD_RULE = { scheduleId: "sched-1", weekday: 1, startMinute: 540, endMinute: 1020 };

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "Salon",
    timezone: "Europe/Stockholm",
    isDefault: true,
    rules: [{ weekday: 2, startMinute: 600, endMinute: 960 }],
    overrides: [{ date: "2026-12-24", startMinute: null, endMinute: null, isUnavailable: true }],
    ...overrides,
  }) as unknown as Parameters<typeof saveSchedule>[1];

beforeEach(() => {
  s.store = {
    schedules: [
      { ...SALON },
      // Another default schedule of the same user, and one in another organization.
      {
        id: "sched-2",
        organizationId: ORG,
        userId: "user-1",
        name: "Old",
        timezone: "Europe/Helsinki",
        isDefault: false,
      },
      {
        id: "sched-x",
        organizationId: OTHER_ORG,
        userId: "user-1",
        name: "Elsewhere",
        timezone: "Europe/Helsinki",
        isDefault: true,
      },
    ],
    rules: [{ ...OLD_RULE }],
    overrides: [],
  };
  s.failOverrideInsert = false;
});

describe("saveSchedule is one transaction", () => {
  it("a failure while writing overrides keeps the previous rules, timezone and default", async () => {
    s.failOverrideInsert = true;
    await expect(saveSchedule(ctx, input(), "sched-1")).rejects.toThrow("connection reset");
    expect(s.store.rules).toEqual([OLD_RULE]);
    expect(s.store.overrides).toEqual([]);
    expect(s.store.schedules.find((r) => r.id === "sched-1")).toMatchObject({
      timezone: "Europe/Helsinki",
      isDefault: true,
    });
  });

  it("a successful save stores exactly the new schedule, rules and overrides", async () => {
    await expect(saveSchedule(ctx, input(), "sched-1")).resolves.toBe("sched-1");
    expect(s.store.schedules.find((r) => r.id === "sched-1")).toMatchObject({
      timezone: "Europe/Stockholm",
    });
    expect(s.store.rules).toEqual([
      { scheduleId: "sched-1", weekday: 2, startMinute: 600, endMinute: 960 },
    ]);
    expect(s.store.overrides).toEqual([
      expect.objectContaining({ scheduleId: "sched-1", isUnavailable: true }),
    ]);
  });

  it("a new default clears the user's other defaults in this organization only", async () => {
    s.store.schedules[1]!.isDefault = true;
    await saveSchedule(ctx, input(), "sched-1");
    expect(s.store.schedules.map((r) => [r.id, r.isDefault])).toEqual([
      ["sched-1", true],
      ["sched-2", false],
      ["sched-x", true],
    ]);
  });

  it("another organization's schedule id is not found and nothing is written", async () => {
    await expect(saveSchedule(ctx, input(), "sched-x")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(s.store.schedules.find((r) => r.id === "sched-x")).toMatchObject({
      name: "Elsewhere",
    });
  });

  it("a new schedule is created in the caller's organization with its rules", async () => {
    const id = await saveSchedule(ctx, input({ isDefault: false }));
    expect(s.store.schedules.find((r) => r.id === id)).toMatchObject({
      organizationId: ORG,
      userId: "user-1",
    });
    expect(s.store.rules.filter((r) => r.scheduleId === id)).toHaveLength(1);
  });
});
