import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Each user has at most one default availability schedule. Saving a schedule
 * as the default clears the default flag on the *schedule owner's* other
 * schedules. Anyone with booking:manage can edit an org schedule by id, so the
 * editor is not always the owner.
 *
 * Real: saveSchedule. Mocked: the database and audit.
 */
const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ id: "schedule-new" })),
  updateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    availabilitySchedule: {
      findFirst: m.findFirst,
      update: m.update,
      create: m.create,
      updateMany: m.updateMany,
    },
  })),
  unscopedPrisma: {
    availabilityRule: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    availabilityOverride: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { saveSchedule } from "@/server/services/availability";

const manager: TenantContext = {
  userId: "manager-1",
  email: "manager@test.fi",
  orgId: "org-a",
  role: "MANAGER",
  locale: "fi",
};

const input = {
  name: "Weekdays",
  timezone: "Europe/Helsinki",
  isDefault: true,
  rules: [],
  overrides: [],
} as Parameters<typeof saveSchedule>[1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveSchedule: one default schedule per owner", () => {
  it("editing another member's schedule as default clears that member's other defaults, not the editor's", async () => {
    m.findFirst.mockResolvedValue({ id: "schedule-b", userId: "member-2" });

    await saveSchedule(manager, input, "schedule-b");

    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { userId: "member-2", id: { not: "schedule-b" } },
      data: { isDefault: false },
    });
  });

  it("a new default schedule clears the creator's other defaults", async () => {
    await saveSchedule(manager, input);

    expect(m.updateMany).toHaveBeenCalledWith({
      where: { userId: "manager-1", id: { not: "schedule-new" } },
      data: { isDefault: false },
    });
  });

  it("a schedule saved as not default leaves every other schedule alone", async () => {
    m.findFirst.mockResolvedValue({ id: "schedule-b", userId: "member-2" });

    await saveSchedule(manager, { ...input, isDefault: false }, "schedule-b");

    expect(m.updateMany).not.toHaveBeenCalled();
  });
});
